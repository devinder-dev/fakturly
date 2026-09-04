// invoice.repository.ts — database queries for Invoice.

import { prisma } from '../lib/prisma.ts'
import type { InvoiceStatus, InvoiceType, TransactionType } from '../generated/prisma/client.ts'

/** Every field an invoice endpoint returns, defined once. */
const invoiceSelect = {
  id: true,
  invoiceNumber: true,
  clientId: true,
  currency: true,
  status: true,
  type: true,
  creditsInvoiceId: true,
  // Both directions of the credit-note link, by number, so a screen can
  // show "krediterar 2026-0016" / "krediterad av 2026-0021" without a
  // second request.
  creditsInvoice: { select: { id: true, invoiceNumber: true } },
  creditNotes: { select: { id: true, invoiceNumber: true } },
  netTotalOre: true,
  vatTotalOre: true,
  grossTotalOre: true,
  lateFeeOre: true,
  reminderFeeOre: true,
  reminderSentAt: true,
  issueDate: true,
  dueDate: true,
  sentAt: true,
  paidAt: true,
  createdAt: true,
  // The ledger, oldest first. Returned with the invoice because it is the
  // invoice's explanation: every öre of the amount due traces to a row here.
  transactions: {
    select: { id: true, type: true, amountOre: true, description: true, createdAt: true },
    orderBy: { createdAt: 'asc' }
  },
  items: {
    select: {
      id: true,
      description: true,
      quantity: true,
      unitPriceOre: true,
      vatRate: true,
      netOre: true,
      vatOre: true,
      grossOre: true,
      position: true
    },
    orderBy: { position: 'asc' }
  }
} as const

export type InvoiceItemRecord = {
  id: string
  description: string
  quantity: number
  unitPriceOre: number
  vatRate: number
  netOre: number
  vatOre: number
  grossOre: number
  position: number
}

export type InvoiceReference = {
  id: string
  invoiceNumber: string
}

export type LedgerRow = {
  id: string
  type: TransactionType
  amountOre: number
  description: string
  createdAt: Date
}

export type InvoiceRecord = {
  id: string
  invoiceNumber: string
  clientId: string
  currency: string
  status: InvoiceStatus
  type: InvoiceType
  creditsInvoiceId: string | null
  creditsInvoice: InvoiceReference | null
  creditNotes: InvoiceReference[]
  netTotalOre: number
  vatTotalOre: number
  grossTotalOre: number
  lateFeeOre: number
  reminderFeeOre: number
  reminderSentAt: Date | null
  issueDate: Date
  dueDate: Date
  sentAt: Date | null
  paidAt: Date | null
  createdAt: Date
  transactions: LedgerRow[]
  items: InvoiceItemRecord[]
}

export type CreateInvoiceData = {
  invoiceNumber: string
  clientId: string
  dueDate: Date
  netTotalOre: number
  vatTotalOre: number
  grossTotalOre: number
  items: Array<{
    description: string
    quantity: number
    unitPriceOre: number
    vatRate: number
    netOre: number
    vatOre: number
    grossOre: number
    position: number
  }>
}

/**
 * Creates the invoice and its lines, atomically.
 *
 * An invoice without its lines has a total that nothing explains, so both
 * land or neither does.
 *
 * NO LEDGER ROW IS WRITTEN HERE, and that is deliberate. A DRAFT is not a
 * financial event — nobody has been invoiced, nothing is owed, and the draft
 * may still be deleted. The ledger entry belongs at the moment the invoice
 * becomes a financial document, which is when it is sent. See markSent.
 *
 * We learned this from a foreign-key violation when deleting a draft. The
 * quick fix would have been onDelete: Cascade on Transaction — which would
 * have made ledger rows deletable and quietly broken the append-only
 * guarantee the whole system rests on.
 *
 * Note the invoice NUMBER is allocated before this, in its own transaction.
 * Holding the counter row's lock for the whole of this would serialise every
 * invoice creation in the system. The cost is that a failure here leaves an
 * allocated number unused — a gap, which is explainable, rather than a
 * duplicate, which is not.
 */
export async function createInvoiceWithItems(
  data: CreateInvoiceData
): Promise<InvoiceRecord> {
  return prisma.invoice.create({
    data: {
      invoiceNumber: data.invoiceNumber,
      clientId: data.clientId,
      dueDate: data.dueDate,
      netTotalOre: data.netTotalOre,
      vatTotalOre: data.vatTotalOre,
      grossTotalOre: data.grossTotalOre,
      // DRAFT is the default, but stating it makes the lifecycle obvious to
      // anyone reading this rather than hunting through the schema.
      status: 'DRAFT',
      items: { create: data.items }
    },
    select: invoiceSelect
  })
}

/**
 * Marks an invoice as sent AND writes its ledger entry — atomically.
 *
 * This is the moment the invoice becomes a financial document: a copy now
 * exists outside our system, money is owed, and the row can never be edited
 * or deleted again. Those two facts must be recorded together. An invoice
 * marked SENT without its ledger row would mean money is owed and the ledger
 * does not know — a discrepancy that surfaces at quarter end with no way to
 * tell which of the two is wrong.
 *
 * `status: 'DRAFT'` sits in the WHERE clause rather than being checked
 * beforehand, as an optimistic-concurrency guard. Without it, two admins
 * clicking "send" at the same moment both read DRAFT, both write SENT, and
 * two ledger rows are written for one invoice. With it, the second update
 * matches no rows and returns null.
 */
export async function markSent(id: string): Promise<InvoiceRecord | null> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.updateMany({
      where: { id, status: 'DRAFT' },
      data: { status: 'SENT', sentAt: new Date() }
    })

    // Zero rows: someone else sent it first, or it is no longer a draft.
    if (updated.count === 0) return null

    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id },
      select: invoiceSelect
    })

    // The immutable ledger entry. Never updated, never deleted — a
    // correction is a new row with a negative amount.
    await tx.transaction.create({
      data: {
        invoiceId: invoice.id,
        type: 'INVOICE_CREATED',
        // Gross: what the client actually owes, VAT included.
        amountOre: invoice.grossTotalOre,
        currency: invoice.currency,
        description: `Faktura ${invoice.invoiceNumber} utfärdad`
      }
    })

    return invoice
  })
}

export async function findInvoiceById(id: string): Promise<InvoiceRecord | null> {
  return prisma.invoice.findUnique({ where: { id }, select: invoiceSelect })
}

export type ListInvoicesFilter = {
  limit: number
  offset: number
  status?: InvoiceStatus | undefined
  type?: InvoiceType | undefined
  /** When set, only this client's invoices. This is how a CLIENT is scoped. */
  clientId?: string | undefined
}

export type ListInvoicesResult = {
  invoices: InvoiceRecord[]
  total: number
}

export async function listInvoices(
  filter: ListInvoicesFilter
): Promise<ListInvoicesResult> {
  const where = {
    ...(filter.clientId ? { clientId: filter.clientId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.type ? { type: filter.type } : {})
  }

  // Page and count in one transaction, so `total` cannot describe a different
  // set of rows than the page returned.
  const [invoices, total] = await prisma.$transaction([
    prisma.invoice.findMany({
      where,
      select: invoiceSelect,
      orderBy: { createdAt: 'desc' },
      take: filter.limit,
      skip: filter.offset
    }),
    prisma.invoice.count({ where })
  ])

  return { invoices, total }
}

/**
 * Records a payment: status to PAID, plus the ledger entry — atomically.
 *
 * `status: { in: ['SENT', 'OVERDUE'] }` in the WHERE clause is doing real
 * work. It means:
 *   - an already-PAID invoice matches nothing, so a duplicate payment webhook
 *     cannot write a second PAYMENT_RECEIVED row
 *   - a DRAFT cannot be marked paid, because it was never issued
 *
 * That is the second layer of idempotency. The first is the event log, which
 * stops the same *delivery* being handled twice; this stops the same *payment*
 * being applied twice even if it arrives as two different events.
 *
 * Returns null when nothing matched — the caller treats that as "already
 * handled", not as an error.
 */
export async function markPaid(
  id: string,
  payment: { stripePaymentId: string; amountOre: number }
): Promise<InvoiceRecord | null> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.updateMany({
      // type: INVOICE — a credit note is never paid; it is money going the
      // other way, and settling it here would record a phantom receipt.
      where: { id, type: 'INVOICE', status: { in: ['SENT', 'OVERDUE'] } },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        stripePaymentId: payment.stripePaymentId
      }
    })

    if (updated.count === 0) return null

    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id },
      select: invoiceSelect
    })

    await tx.transaction.create({
      data: {
        invoiceId: invoice.id,
        type: 'PAYMENT_RECEIVED',
        // The amount Stripe actually collected, not what we expected. If they
        // differ, the ledger must record what really happened — the
        // discrepancy is the finding, and hiding it would be the bug.
        amountOre: payment.amountOre,
        currency: invoice.currency,
        description: `Betalning mottagen för faktura ${invoice.invoiceNumber}`
      }
    })

    return invoice
  })
}

/** Stores the Stripe checkout session id on an invoice. */
export async function attachCheckoutSession(
  id: string,
  sessionId: string
): Promise<void> {
  await prisma.invoice.update({
    where: { id },
    data: { stripePaymentId: sessionId }
  })
}

/** Deletes a DRAFT invoice. Items cascade; see the schema. */
export async function deleteDraftInvoice(id: string): Promise<boolean> {
  // The status condition is in the WHERE clause, not just checked beforehand.
  // A check-then-delete could race with a send.
  const result = await prisma.invoice.deleteMany({ where: { id, status: 'DRAFT' } })
  return result.count > 0
}

// ─────────────────────────────────────────────────────────────
// Credit notes
// ─────────────────────────────────────────────────────────────

export type CreateCreditNoteData = {
  /** The invoice being cancelled. Must be SENT or OVERDUE at write time. */
  originalId: string
  creditNoteNumber: string
  clientId: string
  currency: string
  issuedAt: Date
  /** Negative totals — the mirror image of the original. */
  netTotalOre: number
  vatTotalOre: number
  grossTotalOre: number
  items: CreateInvoiceData['items']
}

/**
 * Issues a credit note and cancels the original — atomically.
 *
 * Five writes that must land together or not at all:
 *
 *   1. the original moves to CREDITED, guarded by its expected status
 *   2. the credit note is created, already SENT: it is derived from a frozen
 *      document, so there is nothing to draft
 *   3. a CREDIT_NOTE_ISSUED ledger row on the ORIGINAL for minus the gross —
 *      its ledger now sums to zero, which is the whole point
 *   4. if interest had accrued, a LATE_FEE_WAIVED row cancels it
 *   5. if a reminder fee was charged, a REMINDER_FEE_WAIVED row cancels it
 *
 * The ledger rows go on the original, not on the credit note. The ledger
 * follows the RECEIVABLE — the thing the customer owed — and the credit note
 * is the document that explains why that receivable is now zero. Putting the
 * rows on the credit note would leave the original's ledger claiming money
 * that will never arrive.
 *
 * Returns null when the status guard matched nothing: someone paid or
 * credited it first.
 */
export async function createCreditNote(
  data: CreateCreditNoteData
): Promise<{ creditNote: InvoiceRecord; original: InvoiceRecord } | null> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.invoice.findUnique({
      where: { id: data.originalId },
      select: { lateFeeOre: true, reminderFeeOre: true, invoiceNumber: true }
    })
    if (!before) return null

    const cancelled = await tx.invoice.updateMany({
      where: { id: data.originalId, type: 'INVOICE', status: { in: ['SENT', 'OVERDUE'] } },
      data: { status: 'CREDITED' }
    })
    if (cancelled.count === 0) return null

    const creditNote = await tx.invoice.create({
      data: {
        invoiceNumber: data.creditNoteNumber,
        clientId: data.clientId,
        currency: data.currency,
        type: 'CREDIT_NOTE',
        creditsInvoiceId: data.originalId,
        status: 'SENT',
        issueDate: data.issuedAt,
        sentAt: data.issuedAt,
        // Nothing is due on a credit note, but the column is required; the
        // issue date says "settled now" and keeps it out of any overdue logic.
        dueDate: data.issuedAt,
        netTotalOre: data.netTotalOre,
        vatTotalOre: data.vatTotalOre,
        grossTotalOre: data.grossTotalOre,
        items: { create: data.items }
      },
      select: invoiceSelect
    })

    await tx.transaction.create({
      data: {
        invoiceId: data.originalId,
        type: 'CREDIT_NOTE_ISSUED',
        amountOre: data.grossTotalOre, // already negative
        currency: data.currency,
        description: `Krediterad genom kreditfaktura ${data.creditNoteNumber}`
      }
    })

    if (before.lateFeeOre > 0) {
      await tx.transaction.create({
        data: {
          invoiceId: data.originalId,
          type: 'LATE_FEE_WAIVED',
          amountOre: -before.lateFeeOre,
          currency: data.currency,
          description: `Dröjsmålsränta avskriven — faktura ${before.invoiceNumber} krediterad`
        }
      })
    }

    if (before.reminderFeeOre > 0) {
      await tx.transaction.create({
        data: {
          invoiceId: data.originalId,
          type: 'REMINDER_FEE_WAIVED',
          amountOre: -before.reminderFeeOre,
          currency: data.currency,
          description: `Påminnelseavgift avskriven — faktura ${before.invoiceNumber} krediterad`
        }
      })
    }

    const original = await tx.invoice.findUniqueOrThrow({
      where: { id: data.originalId },
      select: invoiceSelect
    })

    return { creditNote, original }
  })
}

// ─────────────────────────────────────────────────────────────
// Reminders
// ─────────────────────────────────────────────────────────────

/**
 * Charges the statutory reminder fee — once — and stamps the reminder.
 *
 * `reminderFeeOre: 0` in the WHERE clause is the "once" rule, enforced by the
 * database rather than by a check in the service: two admins pressing
 * "remind" at the same moment cannot both add 60 kr.
 *
 * Returns null when the fee was already charged (or the invoice is not
 * open). The caller may still send the email; it just cannot charge again.
 */
export async function chargeReminderFee(
  id: string,
  feeOre: number,
  sentAt: Date
): Promise<InvoiceRecord | null> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.updateMany({
      where: { id, type: 'INVOICE', status: { in: ['SENT', 'OVERDUE'] }, reminderFeeOre: 0 },
      data: { reminderFeeOre: feeOre, reminderSentAt: sentAt }
    })
    if (updated.count === 0) return null

    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id }, select: invoiceSelect })

    await tx.transaction.create({
      data: {
        invoiceId: id,
        type: 'REMINDER_FEE_ADDED',
        amountOre: feeOre,
        currency: invoice.currency,
        description: `Påminnelseavgift enligt lag (1981:739), faktura ${invoice.invoiceNumber}`
      }
    })

    return invoice
  })
}

/** A repeat reminder: the timestamp moves, no fee is added. */
export async function markReminderSent(id: string, sentAt: Date): Promise<void> {
  await prisma.invoice.update({ where: { id }, data: { reminderSentAt: sentAt } })
}
