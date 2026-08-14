// invoice.repository.ts — database queries for Invoice.

import { prisma } from '../lib/prisma.ts'
import type { InvoiceStatus } from '../generated/prisma/client.ts'

/** Every field an invoice endpoint returns, defined once. */
const invoiceSelect = {
  id: true,
  invoiceNumber: true,
  clientId: true,
  currency: true,
  status: true,
  netTotalOre: true,
  vatTotalOre: true,
  grossTotalOre: true,
  lateFeeOre: true,
  issueDate: true,
  dueDate: true,
  sentAt: true,
  paidAt: true,
  createdAt: true,
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

export type InvoiceRecord = {
  id: string
  invoiceNumber: string
  clientId: string
  currency: string
  status: InvoiceStatus
  netTotalOre: number
  vatTotalOre: number
  grossTotalOre: number
  lateFeeOre: number
  issueDate: Date
  dueDate: Date
  sentAt: Date | null
  paidAt: Date | null
  createdAt: Date
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
    ...(filter.status ? { status: filter.status } : {})
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

/** Deletes a DRAFT invoice. Items cascade; see the schema. */
export async function deleteDraftInvoice(id: string): Promise<boolean> {
  // The status condition is in the WHERE clause, not just checked beforehand.
  // A check-then-delete could race with a send.
  const result = await prisma.invoice.deleteMany({ where: { id, status: 'DRAFT' } })
  return result.count > 0
}
