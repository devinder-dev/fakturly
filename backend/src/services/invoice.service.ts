// invoice.service.ts — invoice business rules.
//
// Every money figure on an invoice is calculated here from the submitted
// line items. Nothing the caller sends is trusted as a total.

import { calculateLine, sumLines, REMINDER_FEE_ORE, stockholmYear } from '../lib/money.ts'
import { allocateInvoiceNumber } from '../repositories/invoiceNumber.repository.ts'
import * as invoiceRepository from '../repositories/invoice.repository.ts'
import * as clientRepository from '../repositories/client.repository.ts'
import { record, AuditAction, AuditResource } from './audit.service.ts'
import { sendInvoiceEmail } from './email.service.ts'
import { getEmailQueue } from '../jobs/queues.ts'
import { NotFoundError, BusinessRuleError } from '../lib/errors.ts'
import type { InvoiceRecord } from '../repositories/invoice.repository.ts'
import type { CreateInvoiceInput, InvoiceListQuery } from '../validators/invoice.validator.ts'
import type { Actor, AuthenticatedUser } from '../types/auth.ts'
import type { RequestContext } from './auth.service.ts'
import type { InvoiceStatus } from '../generated/prisma/client.ts'

// ─────────────────────────────────────────────────────────────
// Creation
// ─────────────────────────────────────────────────────────────

/**
 * Creates a DRAFT invoice.
 *
 * The order matters:
 *   1. Confirm the client exists IN THE ADMIN'S ORGANIZATION — otherwise we
 *      would burn an invoice number on an invoice that cannot be created.
 *      Another organization's client id gets the same 404 as one that never
 *      existed, and advances no series.
 *   2. Calculate every line and the totals, from the items alone.
 *   3. Allocate the invoice number.
 *   4. Write invoice + lines + ledger entry atomically.
 *   5. Audit, in its own transaction.
 */
export async function createInvoice(
  input: CreateInvoiceInput,
  actor: Actor,
  context: RequestContext = {}
): Promise<InvoiceRecord> {
  const client = await clientRepository.findClientById(actor.organizationId, input.clientId)
  if (!client) {
    throw new NotFoundError('Kunden')
  }

  // Every figure below is derived. The request contained none of them.
  const calculated = input.items.map((item, index) => {
    const line = calculateLine({
      quantity: item.quantity,
      unitPriceOre: item.unitPriceOre,
      vatRate: item.vatRate
    })

    return {
      description: item.description,
      quantity: item.quantity,
      unitPriceOre: item.unitPriceOre,
      vatRate: item.vatRate,
      netOre: line.netOre,
      vatOre: line.vatOre,
      grossOre: line.grossOre,
      position: index
    }
  })

  const totals = sumLines(calculated)

  /**
   * A zero-total invoice is refused.
   *
   * It is reachable with lines that cancel out — +5 and -5 of the same item.
   * That is not an invoice, it is a mistake, and it would consume a number in
   * the legally-required series to say nothing. A genuine credit note is a
   * separate document with a negative total, not a self-cancelling one.
   */
  if (totals.grossTotalOre === 0) {
    throw new BusinessRuleError('Fakturans totalbelopp kan inte vara noll')
  }

  const invoiceNumber = await allocateInvoiceNumber(actor.organizationId, stockholmYear())

  const invoice = await invoiceRepository.createInvoiceWithItems(actor.organizationId, {
    invoiceNumber,
    clientId: input.clientId,
    dueDate: input.dueDate,
    netTotalOre: totals.netTotalOre,
    vatTotalOre: totals.vatTotalOre,
    grossTotalOre: totals.grossTotalOre,
    items: calculated
  })

  await record({
    action: AuditAction.INVOICE_CREATED,
    resource: AuditResource.INVOICE,
    userId: actor.userId,
    organizationId: actor.organizationId,
    resourceId: invoice.id,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })

  return invoice
}

// ─────────────────────────────────────────────────────────────
// Reading — ownership again
// ─────────────────────────────────────────────────────────────

/**
 * A customer's own customer records' ids — one per seller they buy from.
 *
 * A CLIENT's token carries a user id, not client ids — deliberately, since
 * the token holds no more than it must, and a seller can add this login as
 * its customer at any time. So every scoped read costs one lookup.
 */
async function ownClientIds(userId: string): Promise<string[]> {
  const clients = await clientRepository.findClientsOfUser(userId)
  return clients.map((client) => client.id)
}

/**
 * Fetches one invoice, enforcing that the caller may see it.
 *
 * Same rule as clients: a row belonging to someone else answers 404, never
 * 403. A 403 confirms the invoice exists, and invoice numbers are sequential
 * by law — so an attacker who learns that 2026-0007 exists but is not theirs
 * has learned exactly how many invoices the business has issued this year.
 * That is commercially sensitive on its own.
 */
export async function getInvoiceForCaller(
  invoiceId: string,
  caller: AuthenticatedUser
): Promise<InvoiceRecord> {
  // The rule is in the query for both roles: the admin's organization, or
  // the customer's own records across every seller they buy from.
  const invoice =
    caller.role === 'ADMIN'
      ? await invoiceRepository.findInvoiceById(caller.organizationId, invoiceId)
      : await invoiceRepository.findInvoiceOfClients(await ownClientIds(caller.id), invoiceId)

  // Missing, another organization's, another customer's: one answer.
  if (!invoice) {
    throw new NotFoundError('Fakturan')
  }

  return invoice
}

/**
 * Lists invoices, scoped to what the caller may see.
 *
 * The scoping is applied to the QUERY, not to the results. Filtering after
 * fetching would mean another client's rows had already been read into memory,
 * and one forgotten filter later they are in a response. Constraining the
 * WHERE clause means they are never loaded at all.
 */
export async function listInvoicesForCaller(
  query: InvoiceListQuery,
  caller: AuthenticatedUser
): Promise<invoiceRepository.ListInvoicesResult> {
  if (caller.role === 'ADMIN') {
    // clientId narrows WITHIN the organization. Another organization's
    // client id is not refused — it just matches nothing here, which tells
    // the caller nothing about whether it exists.
    return invoiceRepository.listInvoices(caller.organizationId, {
      limit: query.limit,
      offset: query.offset,
      status: query.status,
      type: query.type,
      clientId: query.clientId
    })
  }

  const clientIds = await ownClientIds(caller.id)

  // A CLIENT with no customer record sees nothing — not an error, just an
  // empty list. There is nothing to hide and nothing to show.
  if (clientIds.length === 0) {
    return { invoices: [], total: 0 }
  }

  // Deliberately ignores query.clientId. A client asking for someone else's
  // invoices is silently scoped back to their own rather than refused —
  // refusing would confirm the other client id is real. Every seller they
  // buy from is included; each invoice names its seller.
  return invoiceRepository.listInvoicesOfClients(clientIds, {
    limit: query.limit,
    offset: query.offset,
    status: query.status,
    type: query.type
  })
}

// ─────────────────────────────────────────────────────────────
// Status transitions
// ─────────────────────────────────────────────────────────────

/**
 * Which moves are legal.
 *
 * DRAFT    -> SENT                 the invoice becomes a financial document
 * SENT     -> PAID | OVERDUE | CREDITED
 * OVERDUE  -> PAID | CREDITED      paying late is still paying
 * PAID     -> nothing              terminal
 * CREDITED -> nothing              terminal — the credit note carries on
 *
 * Note what is NOT here: PAID -> CREDITED. Crediting a paid invoice means
 * money must go back to the customer, which is a refund flow with its own
 * ledger rows and its own Stripe call. Until that exists, a paid invoice
 * cannot be credited, and the transition table says so.
 *
 * Everything absent from this table is refused. Encoding it as data rather
 * than a chain of if-statements means the rules can be read at a glance, and
 * adding a status cannot silently create a path nobody considered.
 */
const ALLOWED_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  DRAFT: ['SENT'],
  SENT: ['PAID', 'OVERDUE', 'CREDITED'],
  OVERDUE: ['PAID', 'CREDITED'],
  PAID: [],
  CREDITED: []
}

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/**
 * Sends an invoice: DRAFT -> SENT.
 *
 * This is the moment the invoice stops being editable. Before it, the invoice
 * is a draft nobody has seen and may be changed or deleted freely. After it,
 * a copy exists outside our system, and Swedish bookkeeping law treats it as
 * a financial record: a correction is a credit note, never an edit.
 */
export async function sendInvoice(
  invoiceId: string,
  actor: Actor,
  context: RequestContext = {}
): Promise<InvoiceRecord> {
  const invoice = await invoiceRepository.findInvoiceById(actor.organizationId, invoiceId)
  if (!invoice) {
    throw new NotFoundError('Fakturan')
  }

  if (!canTransition(invoice.status, 'SENT')) {
    throw new BusinessRuleError(
      `En faktura med status ${invoice.status} kan inte skickas`
    )
  }

  // Status change and ledger entry in one transaction. The expected status is
  // in the WHERE clause, so two concurrent sends cannot both succeed — the
  // second matches no rows and gets the conflict error below.
  const updated = await invoiceRepository.markSent(actor.organizationId, invoiceId)

  if (!updated) {
    throw new BusinessRuleError('Fakturan ändrades av någon annan. Försök igen.')
  }

  await record({
    action: AuditAction.INVOICE_SENT,
    resource: AuditResource.INVOICE,
    userId: actor.userId,
    organizationId: actor.organizationId,
    resourceId: invoiceId,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })

  // The customer is told. After the status change and outside its
  // transaction: the invoice IS sent whether or not the mail server is up,
  // and the email service records the attempt either way.
  const client = await clientRepository.findClientById(actor.organizationId, updated.clientId)
  if (client) {
    await sendInvoiceEmail({
      to: client.email,
      clientName: client.name,
      invoiceNumber: updated.invoiceNumber,
      grossTotalOre: updated.grossTotalOre,
      currency: updated.currency,
      dueDate: updated.dueDate,
      invoiceId: updated.id
    })
  }

  return updated
}

// ─────────────────────────────────────────────────────────────
// Credit notes
// ─────────────────────────────────────────────────────────────

/**
 * Issues a credit note (kreditfaktura) that cancels an invoice in full.
 *
 * WHY NOT JUST EDIT OR DELETE THE INVOICE: once sent, an invoice is a
 * financial record with a number in the legally-required series and a copy in
 * the customer's bookkeeping. Bokföringslagen does not allow it to change.
 * The only lawful correction is a NEW document that says "minus this much",
 * references the original, and takes the next number in the same series.
 *
 * The credit note mirrors the original line by line with negated quantities,
 * so its totals are exactly minus the original's — the same arithmetic run
 * on the same inputs, which is why roundOre rounds half away from zero
 * (symmetrically) rather than half up.
 *
 * Only SENT or OVERDUE invoices can be credited here. A PAID one needs a
 * refund flow that does not exist yet; the transition table refuses it.
 *
 * Partial credit notes (crediting one line, or a discount) are a real thing
 * and a natural extension. Full credit first, because it has no ambiguity
 * about what happens to interest and fees: everything is written off.
 */
export async function issueCreditNote(
  originalId: string,
  actor: Actor,
  context: RequestContext = {}
): Promise<{ creditNote: InvoiceRecord; original: InvoiceRecord }> {
  const original = await invoiceRepository.findInvoiceById(actor.organizationId, originalId)
  if (!original) {
    throw new NotFoundError('Fakturan')
  }

  if (original.type === 'CREDIT_NOTE') {
    throw new BusinessRuleError('En kreditfaktura kan inte krediteras')
  }

  if (original.status === 'PAID') {
    throw new BusinessRuleError(
      'En betald faktura krediteras genom återbetalning, vilket inte stöds ännu'
    )
  }

  if (!canTransition(original.status, 'CREDITED')) {
    throw new BusinessRuleError(`En faktura med status ${original.status} kan inte krediteras`)
  }

  // Mirror image. Same descriptions, same prices, same VAT rates — the sign
  // lives on the quantity, and every derived figure follows from it.
  const mirrored = original.items.map((item) => {
    const line = calculateLine({
      quantity: -item.quantity,
      unitPriceOre: item.unitPriceOre,
      vatRate: item.vatRate
    })
    return {
      description: item.description,
      quantity: -item.quantity,
      unitPriceOre: item.unitPriceOre,
      vatRate: item.vatRate,
      netOre: line.netOre,
      vatOre: line.vatOre,
      grossOre: line.grossOre,
      position: item.position
    }
  })
  const totals = sumLines(mirrored)

  // Same series as invoices. The law counts a credit note as an invoice, and
  // a separate numbering would leave a gap in the "real" series that someone
  // would have to explain.
  const creditNoteNumber = await allocateInvoiceNumber(actor.organizationId, stockholmYear())

  const result = await invoiceRepository.createCreditNote(actor.organizationId, {
    originalId,
    creditNoteNumber,
    clientId: original.clientId,
    currency: original.currency,
    issuedAt: new Date(),
    netTotalOre: totals.netTotalOre,
    vatTotalOre: totals.vatTotalOre,
    grossTotalOre: totals.grossTotalOre,
    items: mirrored
  })

  if (!result) {
    throw new BusinessRuleError('Fakturan ändrades av någon annan. Försök igen.')
  }

  await record({
    action: AuditAction.CREDIT_NOTE_ISSUED,
    resource: AuditResource.INVOICE,
    userId: actor.userId,
    organizationId: actor.organizationId,
    resourceId: result.creditNote.id,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })

  return result
}

// ─────────────────────────────────────────────────────────────
// Reminders
// ─────────────────────────────────────────────────────────────

export type ReminderOutcome = {
  invoice: InvoiceRecord
  /** True when this reminder charged the statutory fee. */
  feeCharged: boolean
}

/**
 * Sends a payment reminder and, the first time, charges the statutory fee.
 *
 * Lag (1981:739) om ersättning för inkassokostnader allows ONE reminder fee
 * of 60 kr per debt, and only if the invoice stated in advance that it would
 * be charged — ours does, in the terms printed on every PDF. A second or
 * third reminder is free: the email goes out, the fee does not repeat.
 *
 * The fee and its ledger row are written atomically, with the "once" rule
 * in the WHERE clause. The email is queued afterwards, outside the
 * transaction, with retries: a mail outage must not lose the fee, and a fee
 * must not be charged twice because a retry re-ran the whole thing.
 */
export async function sendReminder(
  invoiceId: string,
  actor: Actor,
  context: RequestContext = {}
): Promise<ReminderOutcome> {
  const invoice = await invoiceRepository.findInvoiceById(actor.organizationId, invoiceId)
  if (!invoice) {
    throw new NotFoundError('Fakturan')
  }

  if (invoice.type === 'CREDIT_NOTE') {
    throw new BusinessRuleError('En kreditfaktura kan inte påminnas')
  }

  if (invoice.status !== 'SENT' && invoice.status !== 'OVERDUE') {
    throw new BusinessRuleError(`En faktura med status ${invoice.status} kan inte påminnas`)
  }

  const now = new Date()
  let feeCharged = false
  let updated = await invoiceRepository.chargeReminderFee(
    actor.organizationId,
    invoiceId,
    REMINDER_FEE_ORE,
    now
  )

  if (updated) {
    feeCharged = true
  } else {
    // Already charged once. Just record that another reminder went out.
    await invoiceRepository.markReminderSent(actor.organizationId, invoiceId, now)
    updated = await invoiceRepository.findInvoiceById(actor.organizationId, invoiceId)
    if (!updated) throw new NotFoundError('Fakturan')
  }

  await record({
    action: AuditAction.REMINDER_SENT,
    resource: AuditResource.INVOICE,
    userId: actor.userId,
    organizationId: actor.organizationId,
    resourceId: invoiceId,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })

  // Through the queue, so a mail provider hiccup is retried rather than
  // lost. The worker re-reads the invoice at send time and skips it if the
  // customer paid in the meantime.
  await getEmailQueue().add('payment-reminder', { kind: 'payment-reminder', invoiceId })

  return { invoice: updated, feeCharged }
}

/**
 * Deletes a DRAFT invoice.
 *
 * The only invoice that may ever be deleted. Once sent, an invoice is part of
 * the numbered series and its absence would be a hole someone has to explain.
 * A draft was never issued, so removing it leaves nothing to explain — though
 * it does consume a number, which is why the gap is documented.
 */
export async function deleteDraft(
  invoiceId: string,
  actor: Actor,
  context: RequestContext = {}
): Promise<void> {
  const invoice = await invoiceRepository.findInvoiceById(actor.organizationId, invoiceId)
  if (!invoice) {
    throw new NotFoundError('Fakturan')
  }

  if (invoice.status !== 'DRAFT') {
    throw new BusinessRuleError(
      'Endast utkast kan raderas. En skickad faktura rättas med en kreditnota.'
    )
  }

  const deleted = await invoiceRepository.deleteDraftInvoice(actor.organizationId, invoiceId)
  if (!deleted) {
    // It was sent between our check and the delete.
    throw new BusinessRuleError('Fakturan kunde inte raderas — den har skickats.')
  }

  await record({
    action: AuditAction.INVOICE_DELETED,
    resource: AuditResource.INVOICE,
    userId: actor.userId,
    organizationId: actor.organizationId,
    resourceId: invoiceId,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })
}
