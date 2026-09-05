// dashboard.repository.ts — aggregate queries for the admin overview.
//
// Read-only. Every figure here is a SUM over rows that already exist; nothing
// is written and nothing is cached. That is deliberate: a dashboard that
// stores its own totals is a second copy of the truth, and two copies drift.
//
// Two sources, chosen per question:
//
//   "What is owed right now?"      -> the Invoice table. Status and the
//                                     accumulated fee are current state.
//   "What happened this month?"    -> the Transaction ledger. Money invoiced
//                                     or received is an EVENT with a date,
//                                     and the ledger is the record of events.
//
// Reading "received this month" from Invoice.paidAt would give the same
// answer today and a different one the day someone corrects a payment: the
// ledger keeps the original row and adds an adjustment, paidAt just changes.

import { prisma } from '../lib/prisma.ts'

export type AmountWithCount = {
  amountOre: number
  count: number
}

/**
 * Everything invoiced and not yet settled: gross plus accrued interest.
 *
 * Prisma's _sum returns null over an empty set rather than 0 — an easy way
 * to send `null` to a frontend that expected a number.
 */
export async function sumOutstanding(): Promise<AmountWithCount> {
  const result = await prisma.invoice.aggregate({
    // type: INVOICE — a credit note is SENT too, with a negative gross, and
    // would silently shrink the figure.
    where: { type: 'INVOICE', status: { in: ['SENT', 'OVERDUE'] } },
    _sum: { grossTotalOre: true, lateFeeOre: true, reminderFeeOre: true },
    _count: true
  })

  return {
    amountOre:
      (result._sum.grossTotalOre ?? 0) +
      (result._sum.lateFeeOre ?? 0) +
      (result._sum.reminderFeeOre ?? 0),
    count: result._count
  }
}

/** The subset of outstanding that is past its due date. */
export async function sumOverdue(): Promise<AmountWithCount> {
  const result = await prisma.invoice.aggregate({
    where: { type: 'INVOICE', status: 'OVERDUE' },
    _sum: { grossTotalOre: true, lateFeeOre: true, reminderFeeOre: true },
    _count: true
  })

  return {
    amountOre:
      (result._sum.grossTotalOre ?? 0) +
      (result._sum.lateFeeOre ?? 0) +
      (result._sum.reminderFeeOre ?? 0),
    count: result._count
  }
}

export type MonthlyRow = {
  /** First day of the month, as "YYYY-MM". */
  month: string
  invoicedOre: number
  receivedOre: number
}

/**
 * Invoiced and received per calendar month, from the ledger.
 *
 * THE ONE RAW QUERY IN THE READ PATH, and why: Prisma's groupBy can group by
 * a column but cannot truncate a timestamp to its month. Fetching every
 * ledger row and bucketing in JavaScript would work today and fall over the
 * year the ledger reaches a million rows — the database is built for exactly
 * this, so we let it do it.
 *
 * Safety: this is a tagged template. `${from}` is sent as a bound parameter,
 * never spliced into the SQL text. The enum names are string literals in the
 * query itself, not values from anywhere.
 *
 * Time zone: `AT TIME ZONE 'Europe/Stockholm'` before truncating, or an
 * invoice sent at 00:30 on the 1st (Swedish time) lands in the previous
 * month — because the column is stored in UTC, where it is still 22:30 on
 * the 31st.
 *
 * SUM over an integer column comes back as a BIGINT, which the driver hands
 * us as a JavaScript bigint. Converted to number below: every value is far
 * below 2^53, and the API speaks numbers.
 */
export async function sumByMonth(from: Date): Promise<MonthlyRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{ month: Date; type: string; total: bigint }>
  >`
    SELECT
      date_trunc('month', "createdAt" AT TIME ZONE 'Europe/Stockholm') AS month,
      "type",
      SUM("amountOre") AS total
    FROM "Transaction"
    WHERE "createdAt" >= ${from}
      AND "type" IN ('INVOICE_CREATED', 'PAYMENT_RECEIVED')
    GROUP BY 1, 2
    ORDER BY 1
  `

  const byMonth = new Map<string, MonthlyRow>()

  for (const row of rows) {
    // date_trunc on a timestamp WITHOUT time zone comes back as a Date at
    // UTC midnight of that day, so the year and month are exactly the ones
    // we truncated to. Read them in UTC to avoid re-shifting.
    const key = `${row.month.getUTCFullYear()}-${String(row.month.getUTCMonth() + 1).padStart(2, '0')}`
    const entry = byMonth.get(key) ?? { month: key, invoicedOre: 0, receivedOre: 0 }

    if (row.type === 'INVOICE_CREATED') entry.invoicedOre += Number(row.total)
    if (row.type === 'PAYMENT_RECEIVED') entry.receivedOre += Number(row.total)

    byMonth.set(key, entry)
  }

  return [...byMonth.values()]
}

export type ClientBalance = {
  clientId: string
  name: string
  outstandingOre: number
  invoiceCount: number
}

/**
 * The clients who owe the most, right now.
 *
 * groupBy gives the totals per client id; a second query attaches the names.
 * Two round trips rather than a JOIN, because Prisma's groupBy cannot
 * include relations — and five names is not a query worth writing raw.
 */
export async function topClientsByOutstanding(limit: number): Promise<ClientBalance[]> {
  const groups = await prisma.invoice.groupBy({
    by: ['clientId'],
    where: { type: 'INVOICE', status: { in: ['SENT', 'OVERDUE'] } },
    _sum: { grossTotalOre: true, lateFeeOre: true, reminderFeeOre: true },
    _count: { _all: true },
    orderBy: { _sum: { grossTotalOre: 'desc' } },
    take: limit
  })

  if (groups.length === 0) return []

  const clients = await prisma.client.findMany({
    where: { id: { in: groups.map((group) => group.clientId) } },
    select: { id: true, name: true }
  })
  const nameById = new Map(clients.map((client) => [client.id, client.name]))

  return groups.map((group) => ({
    clientId: group.clientId,
    name: nameById.get(group.clientId) ?? '—',
    outstandingOre:
      (group._sum.grossTotalOre ?? 0) +
      (group._sum.lateFeeOre ?? 0) +
      (group._sum.reminderFeeOre ?? 0),
    invoiceCount: group._count._all
  }))
}
