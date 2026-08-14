// invoice.service.ts — invoice business rules.
//
// Every money figure on an invoice is calculated here from the submitted
// line items. Nothing the caller sends is trusted as a total.

import { calculateLine, sumLines } from '../lib/money.ts'
import { allocateInvoiceNumber } from '../repositories/invoiceNumber.repository.ts'
import * as invoiceRepository from '../repositories/invoice.repository.ts'
import * as clientRepository from '../repositories/client.repository.ts'
import { record, AuditAction, AuditResource } from './audit.service.ts'
import { NotFoundError, BusinessRuleError } from '../lib/errors.ts'
import type { InvoiceRecord } from '../repositories/invoice.repository.ts'
import type { CreateInvoiceInput, InvoiceListQuery } from '../validators/invoice.validator.ts'
import type { AuthenticatedUser } from '../types/auth.ts'
import type { RequestContext } from './auth.service.ts'
import type { InvoiceStatus } from '../generated/prisma/client.ts'

// ─────────────────────────────────────────────────────────────
// Creation
// ─────────────────────────────────────────────────────────────

/**
 * Creates a DRAFT invoice.
 *
 * The order matters:
 *   1. Confirm the client exists — otherwise we would burn an invoice number
 *      on an invoice that cannot be created.
 *   2. Calculate every line and the totals, from the items alone.
 *   3. Allocate the invoice number.
 *   4. Write invoice + lines + ledger entry atomically.
 *   5. Audit, in its own transaction.
 */
export async function createInvoice(
  input: CreateInvoiceInput,
  actingAdminId: string,
  context: RequestContext = {}
): Promise<InvoiceRecord> {
  const client = await clientRepository.findClientById(input.clientId)
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

  const invoiceNumber = await allocateInvoiceNumber(new Date().getFullYear())

  const invoice = await invoiceRepository.createInvoiceWithItems({
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
    userId: actingAdminId,
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
 * Resolves the caller's own client id, or null for an admin.
 *
 * A CLIENT's token carries a user id, not a client id — deliberately, since
 * the token holds no more than it must. So every scoped read costs one lookup.
 */
async function callerClientId(caller: AuthenticatedUser): Promise<string | null> {
  if (caller.role === 'ADMIN') return null

  const client = await clientRepository.findClientByUserId(caller.id)
  return client?.id ?? null
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
  const invoice = await invoiceRepository.findInvoiceById(invoiceId)
  if (!invoice) {
    throw new NotFoundError('Fakturan')
  }

  if (caller.role === 'ADMIN') {
    return invoice
  }

  const ownClientId = await callerClientId(caller)
  if (!ownClientId || invoice.clientId !== ownClientId) {
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
    return invoiceRepository.listInvoices({
      limit: query.limit,
      offset: query.offset,
      status: query.status,
      clientId: query.clientId
    })
  }

  const ownClientId = await callerClientId(caller)

  // A CLIENT with no client record sees nothing — not an error, just an empty
  // list. There is nothing to hide and nothing to show.
  if (!ownClientId) {
    return { invoices: [], total: 0 }
  }

  return invoiceRepository.listInvoices({
    limit: query.limit,
    offset: query.offset,
    status: query.status,
    // Deliberately ignores query.clientId. A client asking for someone else's
    // invoices is silently scoped back to their own rather than refused —
    // refusing would confirm the other client id is real.
    clientId: ownClientId
  })
}

// ─────────────────────────────────────────────────────────────
// Status transitions
// ─────────────────────────────────────────────────────────────

/**
 * Which moves are legal.
 *
 * DRAFT   -> SENT            the invoice becomes a financial document
 * SENT    -> PAID | OVERDUE
 * OVERDUE -> PAID            paying late is still paying
 * PAID    -> nothing         terminal
 *
 * Everything absent from this table is refused. Encoding it as data rather
 * than a chain of if-statements means the rules can be read at a glance, and
 * adding a status cannot silently create a path nobody considered.
 */
const ALLOWED_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  DRAFT: ['SENT'],
  SENT: ['PAID', 'OVERDUE'],
  OVERDUE: ['PAID'],
  PAID: []
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
  actingAdminId: string,
  context: RequestContext = {}
): Promise<InvoiceRecord> {
  const invoice = await invoiceRepository.findInvoiceById(invoiceId)
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
  const updated = await invoiceRepository.markSent(invoiceId)

  if (!updated) {
    throw new BusinessRuleError('Fakturan ändrades av någon annan. Försök igen.')
  }

  await record({
    action: AuditAction.INVOICE_SENT,
    resource: AuditResource.INVOICE,
    userId: actingAdminId,
    resourceId: invoiceId,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })

  return updated
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
  actingAdminId: string,
  context: RequestContext = {}
): Promise<void> {
  const invoice = await invoiceRepository.findInvoiceById(invoiceId)
  if (!invoice) {
    throw new NotFoundError('Fakturan')
  }

  if (invoice.status !== 'DRAFT') {
    throw new BusinessRuleError(
      'Endast utkast kan raderas. En skickad faktura rättas med en kreditnota.'
    )
  }

  const deleted = await invoiceRepository.deleteDraftInvoice(invoiceId)
  if (!deleted) {
    // It was sent between our check and the delete.
    throw new BusinessRuleError('Fakturan kunde inte raderas — den har skickats.')
  }

  await record({
    action: AuditAction.INVOICE_DELETED,
    resource: AuditResource.INVOICE,
    userId: actingAdminId,
    resourceId: invoiceId,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })
}
