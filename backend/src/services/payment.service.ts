// payment.service.ts — creating payment links, and applying payments.
//
// This is the file where a mistake costs real money, so the rules it enforces
// are stated explicitly rather than implied.

import {
  createCheckoutSession,
  expireCheckoutSession,
  type StripeEvent,
  isStripeConfigured
} from '../lib/stripe.ts'
import * as invoiceRepository from '../repositories/invoice.repository.ts'
import * as clientRepository from '../repositories/client.repository.ts'
import * as webhookEventRepository from '../repositories/webhookEvent.repository.ts'
import { record, AuditAction, AuditResource } from './audit.service.ts'
import { sendPaymentConfirmationEmail } from './email.service.ts'
import { env } from '../lib/env.ts'
import { totalDueOre } from '../lib/money.ts'
import { NotFoundError, BusinessRuleError } from '../lib/errors.ts'
import type { RequestContext } from './auth.service.ts'
import type { Actor } from '../types/auth.ts'

// ─────────────────────────────────────────────────────────────
// Creating a payment link
// ─────────────────────────────────────────────────────────────

export type PaymentLink = {
  url: string
  sessionId: string
}

/**
 * Creates a hosted Stripe payment page for an invoice.
 *
 * Only for invoices that have actually been issued. A DRAFT has not been sent
 * to anyone, so there is nothing to pay; a PAID one is settled. Allowing
 * either would mean collecting money against a document the client has never
 * seen, or twice against one they have.
 */
export async function createPaymentLink(
  invoiceId: string,
  actor: Actor,
  context: RequestContext = {}
): Promise<PaymentLink> {
  const invoice = await invoiceRepository.findInvoiceById(actor.organizationId, invoiceId)
  if (!invoice) {
    throw new NotFoundError('Fakturan')
  }

  if (invoice.type === 'CREDIT_NOTE') {
    throw new BusinessRuleError('En kreditfaktura kan inte betalas')
  }

  if (invoice.status === 'DRAFT') {
    throw new BusinessRuleError('Fakturan måste skickas innan den kan betalas')
  }

  if (invoice.status === 'PAID') {
    throw new BusinessRuleError('Fakturan är redan betald')
  }

  if (invoice.status === 'CREDITED') {
    throw new BusinessRuleError('Fakturan är krediterad och kan inte betalas')
  }

  const client = await clientRepository.findClientById(actor.organizationId, invoice.clientId)
  if (!client) {
    throw new NotFoundError('Kunden')
  }

  // What is actually outstanding today — gross, accrued interest and any
  // reminder fee — not what the invoice said when it was written.
  const amountOre = totalDueOre(invoice)

  const session = await createCheckoutSession({
    invoiceId: invoice.id,
    organizationId: invoice.organizationId,
    invoiceNumber: invoice.invoiceNumber,
    amountOre,
    currency: invoice.currency,
    clientEmail: client.email,
    successUrl: `${env.FRONTEND_URL}/invoices/${invoice.id}?payment=success`,
    cancelUrl: `${env.FRONTEND_URL}/invoices/${invoice.id}?payment=cancelled`
  })

  // Any earlier checkout link for this invoice stops working. Without this,
  // two links stay payable for 24 hours and a customer who opens both pays
  // twice — the second payment then lands as "unapplied" below.
  if (invoice.stripePaymentId?.startsWith('cs_')) {
    await expireCheckoutSession(invoice.stripePaymentId)
  }

  await invoiceRepository.attachCheckoutSession(actor.organizationId, invoice.id, session.id)

  await record({
    action: AuditAction.PAYMENT_LINK_CREATED,
    resource: AuditResource.INVOICE,
    userId: actor.userId,
    organizationId: actor.organizationId,
    resourceId: invoice.id,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })

  return { url: session.url, sessionId: session.id }
}

// ─────────────────────────────────────────────────────────────
// Applying a payment from a webhook
// ─────────────────────────────────────────────────────────────

export type WebhookOutcome =
  | { handled: true; invoiceId: string }
  | { handled: false; reason: string }

/**
 * Handles a verified Stripe event.
 *
 * THREE LAYERS OF IDEMPOTENCY, because Stripe guarantees at-least-once
 * delivery and retries for days:
 *
 *   1. The event log claims the event id before any work. A repeat delivery
 *      of the same event stops here.
 *   2. markPaid only matches invoices in SENT or OVERDUE. The same payment
 *      arriving as a *different* event still cannot be applied twice.
 *   3. Unknown event types are acknowledged and ignored, so Stripe stops
 *      retrying things we will never handle.
 *
 * The signature has already been verified by the caller. If it had not, this
 * would be an endpoint where anyone on the internet can declare an invoice
 * paid.
 */
export async function handleStripeEvent(event: StripeEvent): Promise<WebhookOutcome> {
  if (event.type !== 'checkout.session.completed') {
    // Acknowledged, not an error. Returning a failure would make Stripe retry
    // an event we are never going to act on. Not claimed either: there is no
    // work to protect from a repeat.
    return { handled: false, reason: `unhandled_type:${event.type}` }
  }

  const session = event.data.object
  const invoiceId = session.metadata?.invoiceId

  if (!invoiceId) {
    // Should not happen — we set this when creating the session. If it does,
    // matching on amount would be the alternative, and that breaks the moment
    // two invoices are for the same sum.
    console.error('[payment] checkout session without invoiceId metadata', {
      sessionId: session.id
    })
    return { handled: false, reason: 'missing_invoice_metadata' }
  }

  // Stripe reports payment_status separately from the event. A completed
  // session with an unpaid status is a real state — an async method like a
  // bank debit that has not settled.
  if (session.payment_status && session.payment_status !== 'paid') {
    return { handled: false, reason: `payment_status:${session.payment_status}` }
  }

  // DELIBERATELY CROSS-TENANT (ADR 56). Stripe is one platform account for
  // every organization and tells us an invoice id, nothing more — so the
  // organization is learned from the row. Everything after this line is
  // scoped to that organization.
  const invoice = await invoiceRepository.findInvoiceByIdUnscoped(invoiceId)
  if (!invoice) {
    console.error('[payment] webhook references an unknown invoice', { invoiceId })
    return { handled: false, reason: 'unknown_invoice' }
  }

  // The session also records the organization it was created for. A
  // mismatch means the invoice id in the metadata does not belong to the
  // seller whose payment page took the money — never apply that. A session
  // created before multi-tenancy has no organizationId; it can only be for
  // the single organization that existed then, so it is accepted.
  const sessionOrganizationId = session.metadata?.organizationId
  if (sessionOrganizationId !== undefined && sessionOrganizationId !== invoice.organizationId) {
    console.error('[payment] checkout session organization does not match the invoice — refund needed', {
      invoiceId,
      sessionId: session.id
    })
    await record({
      action: AuditAction.PAYMENT_UNAPPLIED,
      resource: AuditResource.INVOICE,
      organizationId: invoice.organizationId,
      resourceId: invoiceId
    })
    return { handled: false, reason: 'organization_mismatch' }
  }

  const expectedOre = totalDueOre(invoice)
  const amountOre = session.amount_total ?? expectedOre

  // A mismatch does not stop us recording the payment — the money genuinely
  // arrived, and refusing to record it would leave the ledger further from
  // the truth, not closer. But it must be loud.
  if (amountOre !== expectedOre) {
    console.error('[payment] amount mismatch', {
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      expectedOre,
      receivedOre: amountOre
    })
  }

  // Layer 1 and layer 2 together, in ONE transaction: claim the event id,
  // then mark paid where the status still allows it. A repeat delivery fails
  // the claim; a failure after the claim rolls it back so the retry works.
  const outcome = await webhookEventRepository.claimEventAndRun(event.id, event.type, (tx) =>
    invoiceRepository.markPaidWithin(tx, invoice.organizationId, invoiceId, {
      stripePaymentId: session.payment_intent ?? session.id,
      amountOre
    })
  )

  if (!outcome.claimed) {
    return { handled: false, reason: 'duplicate_event' }
  }

  const paid = outcome.result

  if (!paid) {
    // Stripe says money arrived for an invoice that is not open — most likely
    // paid a second time through an older checkout link. This is NOT a quiet
    // outcome: it is money we hold and cannot apply, and someone must refund
    // it. Loud in the log and in the audit trail, so it cannot go unnoticed.
    console.error('[payment] paid session for a non-payable invoice — refund needed', {
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      sessionId: session.id,
      amountOre
    })
    await record({
      action: AuditAction.PAYMENT_UNAPPLIED,
      resource: AuditResource.INVOICE,
      organizationId: invoice.organizationId,
      resourceId: invoiceId
    })
    return { handled: false, reason: 'invoice_not_payable' }
  }

  await record({
    action: AuditAction.PAYMENT_RECEIVED,
    resource: AuditResource.INVOICE,
    // No acting user: this was Stripe, not a person. userId stays null, which
    // the audit schema allows precisely for events with no human actor.
    organizationId: invoice.organizationId,
    resourceId: invoiceId
  })

  const client = await clientRepository.findClientById(invoice.organizationId, paid.clientId)
  if (client) {
    await sendPaymentConfirmationEmail({
      to: client.email,
      clientName: client.name,
      invoiceNumber: paid.invoiceNumber,
      amountOre,
      currency: paid.currency,
      invoiceId: paid.id
    })
  }

  return { handled: true, invoiceId }
}

export { isStripeConfigured }
