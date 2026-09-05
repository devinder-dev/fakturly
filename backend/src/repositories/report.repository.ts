// report.repository.ts — the reads behind the reports. Nothing is written.

import { prisma } from '../lib/prisma.ts'
import type { TransactionType } from '../generated/prisma/client.ts'

export type OpenInvoice = {
  id: string
  invoiceNumber: string
  clientId: string
  clientName: string
  dueDate: Date
  grossTotalOre: number
  lateFeeOre: number
  reminderFeeOre: number
}

/**
 * Every unpaid invoice — the raw material for the aging report.
 *
 * Bucketing by days overdue happens in the service, not in SQL: the set of
 * OPEN invoices is bounded by how much a business is owed at once, which is
 * small, and the bucket edges are a business rule that belongs where it can
 * be read and tested without a database.
 */
export async function findOpenInvoices(): Promise<OpenInvoice[]> {
  const rows = await prisma.invoice.findMany({
    where: { type: 'INVOICE', status: { in: ['SENT', 'OVERDUE'] } },
    select: {
      id: true,
      invoiceNumber: true,
      clientId: true,
      dueDate: true,
      grossTotalOre: true,
      lateFeeOre: true,
      reminderFeeOre: true,
      client: { select: { name: true } }
    },
    orderBy: [{ clientId: 'asc' }, { dueDate: 'asc' }]
  })

  return rows.map((row) => ({
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    clientId: row.clientId,
    clientName: row.client.name,
    dueDate: row.dueDate,
    grossTotalOre: row.grossTotalOre,
    lateFeeOre: row.lateFeeOre,
    reminderFeeOre: row.reminderFeeOre
  }))
}

export type VatByRate = {
  vatRate: number
  netOre: number
  vatOre: number
  lineCount: number
}

/**
 * Net and VAT per rate over every document ISSUED in the period.
 *
 * Issued means sentAt in [from, to): a draft is not a tax event, and a
 * credit note is one with negative lines — it reduces the period's VAT
 * exactly as Skatteverket expects it to.
 *
 * Grouped in the database. A quarter of line items is not a lot, but it is
 * exactly the query that grows with the business, and SUM ... GROUP BY is
 * what the database is for.
 */
export async function sumVatByRate(from: Date, to: Date): Promise<VatByRate[]> {
  const groups = await prisma.invoiceItem.groupBy({
    by: ['vatRate'],
    where: {
      invoice: {
        status: { not: 'DRAFT' },
        sentAt: { gte: from, lt: to }
      }
    },
    _sum: { netOre: true, vatOre: true },
    _count: { _all: true },
    orderBy: { vatRate: 'desc' }
  })

  return groups.map((group) => ({
    vatRate: group.vatRate,
    netOre: group._sum.netOre ?? 0,
    vatOre: group._sum.vatOre ?? 0,
    lineCount: group._count._all
  }))
}

/** How many documents the VAT figures are drawn from. */
export async function countIssuedInPeriod(from: Date, to: Date): Promise<number> {
  return prisma.invoice.count({
    where: { status: { not: 'DRAFT' }, sentAt: { gte: from, lt: to } }
  })
}

export type LedgerRowForExport = {
  id: string
  type: TransactionType
  amountOre: number
  description: string
  createdAt: Date
  invoice: {
    invoiceNumber: string
    type: 'INVOICE' | 'CREDIT_NOTE'
    items: Array<{ vatRate: number; netOre: number; vatOre: number }>
  }
}

/**
 * Every ledger row in a year, with the line items needed to split an
 * invoice across revenue and VAT accounts. Oldest first — a SIE file is
 * numbered in order.
 */
export async function findLedgerRowsForYear(year: number): Promise<LedgerRowForExport[]> {
  const from = new Date(Date.UTC(year, 0, 1))
  const to = new Date(Date.UTC(year + 1, 0, 1))

  return prisma.transaction.findMany({
    where: { createdAt: { gte: from, lt: to } },
    select: {
      id: true,
      type: true,
      amountOre: true,
      description: true,
      createdAt: true,
      invoice: {
        select: {
          invoiceNumber: true,
          type: true,
          items: { select: { vatRate: true, netOre: true, vatOre: true } }
        }
      }
    },
    orderBy: { createdAt: 'asc' }
  })
}
