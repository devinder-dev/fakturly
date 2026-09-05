// payment.service.ts — creating payment links, and applying payments.
//
// This is the file where a mistake costs real money, so the rules it enforces
// are stated explicitly rather than implied.

import {
  createCheckoutSession,
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
  actingAdminId: string,
  context: RequestContext = {}
): Promise<PaymentLink> {
  const invoice = await invoiceRepository.findInvoiceById(invoiceId)
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

  const client = await clientRepository.findClientById(invoice.clientId)
  if (!client) {
    throw new NotFoundError('Kunden')
  }

  // What is actually outstanding today — gross, accrued interest and any
  // reminder fee — not what the invoice said when it was written.
  const amountOre = totalDueOre(invoice)

  const session = await createCheckoutSession({
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    amountOre,
    currency: invoice.currency,
    clientEmail: client.email,
    successUrl: `${env.FRONTEND_URL}/invoices/${invoice.id}?payment=success`,
    cancelUrl: `${env.FRONTEND_URL}/invoices/${invoice.id}?payment=cancelled`
  })

  await invoiceRepository.attachCheckoutSession(invoice.id, session.id)

  await record({
    action: AuditAction.PAYMENT_LINK_CREATED,
    resource: AuditResource.INVOICE,
    userId: actingAdminId,
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
  // Layer 1 — claim the delivery. Before the work, never after: a crash
  // between doing the work and recording it would let the retry redo it.
  const claimed = await webhookEventRepository.claimEvent(event.id, event.type)
  if (!claimed) {
    return { handled: false, reason: 'duplicate_event' }
  }

  if (event.type !== 'checkout.session.completed') {
    // Acknowledged, not an error. Returning a failure would make Stripe retry
    // an event we are never going to act on.
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

  const invoice = await invoiceRepository.findInvoiceById(invoiceId)
  if (!invoice) {
    console.error('[payment] webhook references an unknown invoice', { invoiceId })
    return { handled: false, reason: 'unknown_invoice' }
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

  // Layer 2 — only SENT or OVERDUE match.
  const paid = await invoiceRepository.markPaid(invoiceId, {
    stripePaymentId: session.payment_intent ?? session.id,
    amountOre
  })

  if (!paid) {
    return { handled: false, reason: 'invoice_not_payable' }
  }

  await record({
    action: AuditAction.PAYMENT_RECEIVED,
    resource: AuditResource.INVOICE,
    // No acting user: this was Stripe, not a person. userId stays null, which
    // the audit schema allows precisely for events with no human actor.
    resourceId: invoiceId
  })

  const client = await clientRepository.findClientById(paid.clientId)
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
