// invoice.repository.ts — database queries for Invoice.
//
// Tenant-scoped (ADR 56): every function takes the organizationId FIRST and
// puts it in every WHERE, so another organization's invoice is simply not
// found — answered as 404, exactly like an id that never existed. The one
// deliberate crossing is named for it: findInvoiceByIdUnscoped, for the
// Stripe webhook, which is told an invoice id and nothing else.

import { prisma } from '../lib/prisma.ts'
import type { InvoiceStatus, InvoiceType, TransactionType, Prisma } from '../generated/prisma/client.ts'

/** Every field an invoice endpoint returns, defined once. */
const invoiceSelect = {
  id: true,
  invoiceNumber: true,
  organizationId: true,
  // The seller, by name: a customer of two sellers sees both sellers'
  // invoices in one list, and the portal groups them by this.
  organization: { select: { id: true, name: true } },
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
  // The current checkout session (cs_…) while a link is open, the payment
  // intent (pi_…) once paid. Needed to expire an old link before a new one.
  stripePaymentId: true,
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
  organizationId: string
  organization: { id: string; name: string }
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
  stripePaymentId: string | null
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
  organizationId: string,
  data: CreateInvoiceData
): Promise<InvoiceRecord> {
  return prisma.invoice.create({
    data: {
      // With clientId, the composite foreign key: the database itself refuses
      // this row if the client is not THIS organization's.
      organizationId,
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
export async function markSent(
  organizationId: string,
  id: string
): Promise<InvoiceRecord | null> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.updateMany({
      where: { id, organizationId, status: 'DRAFT' },
      data: { status: 'SENT', sentAt: new Date() }
    })

    // Zero rows: someone else sent it first, or it is no longer a draft.
    if (updated.count === 0) return null

    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id_organizationId: { id, organizationId } },
      select: invoiceSelect
    })

    // The immutable ledger entry. Never updated, never deleted — a
    // correction is a new row with a negative amount.
    await tx.transaction.create({
      data: {
        organizationId,
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

export async function findInvoiceById(
  organizationId: string,
  id: string
): Promise<InvoiceRecord | null> {
  return prisma.invoice.findUnique({
    where: { id_organizationId: { id, organizationId } },
    select: invoiceSelect
  })
}

/**
 * An invoice by id alone, from ANY organization. Deliberately unscoped.
 *
 * For the Stripe webhook only: Stripe tells us an invoice id and nothing
 * else, so the organization has to be learned from the row. The caller then
 * cross-checks it against the organization recorded in the checkout
 * session, and does every write scoped to it. Anywhere else, this is the
 * bug that leaks one company's invoices to another — hence the name, so
 * `grep -rn Unscoped src` lists every crossing there is.
 */
export async function findInvoiceByIdUnscoped(id: string): Promise<InvoiceRecord | null> {
  return prisma.invoice.findUnique({ where: { id }, select: invoiceSelect })
}

/**
 * An invoice, if it is addressed to one of these customer records.
 *
 * The portal's read. Scoped by the caller's own Client ids — one per seller
 * they buy from — not by an organization: a customer of two sellers may see
 * both sellers' invoices, and nobody else's.
 */
export async function findInvoiceOfClients(
  clientIds: string[],
  id: string
): Promise<InvoiceRecord | null> {
  return prisma.invoice.findFirst({
    where: { id, clientId: { in: clientIds } },
    select: invoiceSelect
  })
}

export type ListInvoicesFilter = {
  limit: number
  offset: number
  status?: InvoiceStatus | undefined
  type?: InvoiceType | undefined
  /** When set, only this customer's invoices — within the organization. */
  clientId?: string | undefined
}

export type ListInvoicesResult = {
  invoices: InvoiceRecord[]
  total: number
}

/** An organization's invoices — the admin list. */
export async function listInvoices(
  organizationId: string,
  filter: ListInvoicesFilter
): Promise<ListInvoicesResult> {
  return pageOfInvoices(
    {
      organizationId,
      ...(filter.clientId ? { clientId: filter.clientId } : {})
    },
    filter
  )
}

/** Invoices addressed to these customer records — the portal list, across
 *  every seller the caller buys from. */
export async function listInvoicesOfClients(
  clientIds: string[],
  filter: Omit<ListInvoicesFilter, 'clientId'>
): Promise<ListInvoicesResult> {
  return pageOfInvoices({ clientId: { in: clientIds } }, filter)
}

/**
 * One page plus its total. Private: callers go through the two functions
 * above, so no caller can ask for a page with no scope at all.
 */
async function pageOfInvoices(
  scope: Prisma.InvoiceWhereInput,
  filter: Omit<ListInvoicesFilter, 'clientId'>
): Promise<ListInvoicesResult> {
  const where: Prisma.InvoiceWhereInput = {
    ...scope,
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
  organizationId: string,
  id: string,
  payment: { stripePaymentId: string; amountOre: number }
): Promise<InvoiceRecord | null> {
  return prisma.$transaction((tx) => markPaidWithin(tx, organizationId, id, payment))
}

/**
 * The body of markPaid, on a caller-supplied transaction client — so the
 * webhook handler can put the event claim and the payment in ONE transaction
 * (see webhookEvent.repository.claimEventAndRun).
 */
export async function markPaidWithin(
  tx: Prisma.TransactionClient,
  organizationId: string,
  id: string,
  payment: { stripePaymentId: string; amountOre: number }
): Promise<InvoiceRecord | null> {
  {
    const updated = await tx.invoice.updateMany({
      // type: INVOICE — a credit note is never paid; it is money going the
      // other way, and settling it here would record a phantom receipt.
      where: { id, organizationId, type: 'INVOICE', status: { in: ['SENT', 'OVERDUE'] } },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        stripePaymentId: payment.stripePaymentId
      }
    })

    if (updated.count === 0) return null

    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id_organizationId: { id, organizationId } },
      select: invoiceSelect
    })

    await tx.transaction.create({
      data: {
        organizationId,
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
  }
}

/** Stores the Stripe checkout session id on an invoice. */
export async function attachCheckoutSession(
  organizationId: string,
  id: string,
  sessionId: string
): Promise<void> {
  await prisma.invoice.updateMany({
    where: { id, organizationId },
    data: { stripePaymentId: sessionId }
  })
}

/** Deletes a DRAFT invoice. Items cascade; see the schema. */
export async function deleteDraftInvoice(organizationId: string, id: string): Promise<boolean> {
  // The status condition is in the WHERE clause, not just checked beforehand.
  // A check-then-delete could race with a send.
  const result = await prisma.invoice.deleteMany({
    where: { id, organizationId, status: 'DRAFT' }
  })
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
  organizationId: string,
  data: CreateCreditNoteData
): Promise<{ creditNote: InvoiceRecord; original: InvoiceRecord } | null> {
  const original = { id_organizationId: { id: data.originalId, organizationId } }

  return prisma.$transaction(async (tx) => {
    const before = await tx.invoice.findUnique({
      where: original,
      select: { lateFeeOre: true, reminderFeeOre: true, invoiceNumber: true }
    })
    if (!before) return null

    const cancelled = await tx.invoice.updateMany({
      where: {
        id: data.originalId,
        organizationId,
        type: 'INVOICE',
        status: { in: ['SENT', 'OVERDUE'] }
      },
      data: { status: 'CREDITED' }
    })
    if (cancelled.count === 0) return null

    const creditNote = await tx.invoice.create({
      data: {
        // Same organization as the original — and the same series: the law
        // counts a credit note as an invoice.
        organizationId,
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
        organizationId,
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
          organizationId,
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
          organizationId,
          invoiceId: data.originalId,
          type: 'REMINDER_FEE_WAIVED',
          amountOre: -before.reminderFeeOre,
          currency: data.currency,
          description: `Påminnelseavgift avskriven — faktura ${before.invoiceNumber} krediterad`
        }
      })
    }

    const updatedOriginal = await tx.invoice.findUniqueOrThrow({
      where: original,
      select: invoiceSelect
    })

    return { creditNote, original: updatedOriginal }
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
  organizationId: string,
  id: string,
  feeOre: number,
  sentAt: Date
): Promise<InvoiceRecord | null> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.updateMany({
      where: {
        id,
        organizationId,
        type: 'INVOICE',
        status: { in: ['SENT', 'OVERDUE'] },
        reminderFeeOre: 0
      },
      data: { reminderFeeOre: feeOre, reminderSentAt: sentAt }
    })
    if (updated.count === 0) return null

    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id_organizationId: { id, organizationId } },
      select: invoiceSelect
    })

    await tx.transaction.create({
      data: {
        organizationId,
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
export async function markReminderSent(
  organizationId: string,
  id: string,
  sentAt: Date
): Promise<void> {
  await prisma.invoice.updateMany({
    where: { id, organizationId },
    data: { reminderSentAt: sentAt }
  })
}
