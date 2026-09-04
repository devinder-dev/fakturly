// report.service.ts — the three reports an accounts department asks for.
//
//   Kundreskontra (aging)   who owes what, and how late
//   Momsrapport (VAT)       net and VAT per rate for a period
//   SIE-export              the ledger as journal entries, for the books
//
// Each is a pure transformation of what the repository returns. No dates
// are read from the clock inside; `asOf` and the period are arguments, so
// "what did the receivables look like on 31 December" is a normal call.

import * as reportRepository from '../repositories/report.repository.ts'
import { totalDueOre, daysBetween } from '../lib/money.ts'
import { toCsv, csvAmount } from '../lib/csv.ts'
import { buildSie, encodeCp437, type SieVerification, type SieAccount } from '../lib/sie.ts'
import { env } from '../lib/env.ts'
import { record, AuditAction } from './audit.service.ts'
import type { RequestContext } from './auth.service.ts'

// ─────────────────────────────────────────────────────────────
// Aging — kundreskontra
// ─────────────────────────────────────────────────────────────

/**
 * The buckets every aging report uses. Days past due, upper bound inclusive.
 * "current" is not yet due.
 */
export const AGING_BUCKETS = [
  { key: 'current', label: 'Ej förfallet', maxDays: 0 },
  { key: 'days1to30', label: '1–30 dagar', maxDays: 30 },
  { key: 'days31to60', label: '31–60 dagar', maxDays: 60 },
  { key: 'days61to90', label: '61–90 dagar', maxDays: 90 },
  { key: 'over90', label: '> 90 dagar', maxDays: Infinity }
] as const

export type AgingBucketKey = (typeof AGING_BUCKETS)[number]['key']
export type AgingAmounts = Record<AgingBucketKey, number> & { totalOre: number }

export type AgingRow = AgingAmounts & {
  clientId: string
  clientName: string
  invoiceCount: number
  /** The single most overdue invoice, for the "call them" column. */
  oldestDueDate: Date
}

export type AgingReport = {
  asOf: Date
  rows: AgingRow[]
  totals: AgingAmounts
}

function emptyAmounts(): AgingAmounts {
  return { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, totalOre: 0 }
}

/** Which bucket an invoice falls in, given how many days past due it is. */
export function agingBucket(daysLate: number): AgingBucketKey {
  for (const bucket of AGING_BUCKETS) {
    if (daysLate <= bucket.maxDays) return bucket.key
  }
  return 'over90'
}

export async function agingReport(asOf: Date = new Date()): Promise<AgingReport> {
  const open = await reportRepository.findOpenInvoices()
  const byClient = new Map<string, AgingRow>()
  const totals = emptyAmounts()

  for (const invoice of open) {
    const owed = totalDueOre(invoice)
    const bucket = agingBucket(daysBetween(invoice.dueDate, asOf))

    const row =
      byClient.get(invoice.clientId) ??
      ({
        ...emptyAmounts(),
        clientId: invoice.clientId,
        clientName: invoice.clientName,
        invoiceCount: 0,
        oldestDueDate: invoice.dueDate
      } satisfies AgingRow)

    row[bucket] += owed
    row.totalOre += owed
    row.invoiceCount += 1
    if (invoice.dueDate < row.oldestDueDate) row.oldestDueDate = invoice.dueDate
    byClient.set(invoice.clientId, row)

    totals[bucket] += owed
    totals.totalOre += owed
  }

  // Largest debt first — the order someone chasing payments wants.
  const rows = [...byClient.values()].sort((a, b) => b.totalOre - a.totalOre)

  return { asOf, rows, totals }
}

export function agingReportCsv(report: AgingReport): string {
  const header = [
    'Kund',
    'Antal fakturor',
    'Äldsta förfallodatum',
    ...AGING_BUCKETS.map((b) => b.label),
    'Totalt'
  ]

  const rows = report.rows.map((row) => [
    row.clientName,
    row.invoiceCount,
    row.oldestDueDate.toISOString().slice(0, 10),
    ...AGING_BUCKETS.map((b) => csvAmount(row[b.key])),
    csvAmount(row.totalOre)
  ])

  rows.push([
    'Summa',
    report.rows.reduce((n, r) => n + r.invoiceCount, 0),
    '',
    ...AGING_BUCKETS.map((b) => csvAmount(report.totals[b.key])),
    csvAmount(report.totals.totalOre)
  ])

  return toCsv(header, rows)
}

// ─────────────────────────────────────────────────────────────
// VAT — momsrapport
// ─────────────────────────────────────────────────────────────

export type VatReport = {
  from: Date
  to: Date
  documentCount: number
  rows: Array<{ vatRate: number; netOre: number; vatOre: number; lineCount: number }>
  totals: { netOre: number; vatOre: number }
}

/**
 * Net and VAT per rate for a period. This is what goes in the boxes on the
 * VAT return: "beskattningsunderlag" per rate and "utgående moms" per rate.
 *
 * Credit notes are included with their negative lines, so a credited invoice
 * and its credit note cancel to zero within the period — or, if the credit
 * note came in a later period, correctly reduce that period instead.
 */
export async function vatReport(from: Date, to: Date): Promise<VatReport> {
  const [rows, documentCount] = await Promise.all([
    reportRepository.sumVatByRate(from, to),
    reportRepository.countIssuedInPeriod(from, to)
  ])

  const totals = rows.reduce(
    (sum, row) => ({ netOre: sum.netOre + row.netOre, vatOre: sum.vatOre + row.vatOre }),
    { netOre: 0, vatOre: 0 }
  )

  return { from, to, documentCount, rows, totals }
}

export function vatReportCsv(report: VatReport): string {
  const header = ['Momssats', 'Beskattningsunderlag', 'Utgående moms', 'Antal rader']
  const rows = report.rows.map((row) => [
    `${row.vatRate / 100} %`,
    csvAmount(row.netOre),
    csvAmount(row.vatOre),
    row.lineCount
  ])
  rows.push(['Summa', csvAmount(report.totals.netOre), csvAmount(report.totals.vatOre), ''])
  return toCsv(header, rows)
}

// ─────────────────────────────────────────────────────────────
// SIE — the ledger as journal entries
// ─────────────────────────────────────────────────────────────

/**
 * The BAS chart of accounts, the standard every Swedish business uses.
 *
 * Revenue is split by VAT rate because the VAT return is filed per rate,
 * and the accountant reconciles 3001 against 2611, 3002 against 2621, and
 * so on. One "sales" account would make that reconciliation impossible.
 */
const ACCOUNTS: Record<string, SieAccount> = {
  receivables: { number: '1510', name: 'Kundfordringar' },
  bank: { number: '1930', name: 'Företagskonto' },
  sales25: { number: '3001', name: 'Försäljning 25 % moms' },
  sales12: { number: '3002', name: 'Försäljning 12 % moms' },
  sales6: { number: '3003', name: 'Försäljning 6 % moms' },
  sales0: { number: '3004', name: 'Försäljning momsfri' },
  vat25: { number: '2611', name: 'Utgående moms 25 %' },
  vat12: { number: '2621', name: 'Utgående moms 12 %' },
  vat6: { number: '2631', name: 'Utgående moms 6 %' },
  interest: { number: '8313', name: 'Ränteintäkter kundfordringar' },
  fees: { number: '3590', name: 'Påminnelseavgifter' }
}

function salesAccount(vatRate: number): SieAccount {
  switch (vatRate) {
    case 2500: return ACCOUNTS.sales25!
    case 1200: return ACCOUNTS.sales12!
    case 600: return ACCOUNTS.sales6!
    default: return ACCOUNTS.sales0!
  }
}

function vatAccount(vatRate: number): SieAccount | null {
  switch (vatRate) {
    case 2500: return ACCOUNTS.vat25!
    case 1200: return ACCOUNTS.vat12!
    case 600: return ACCOUNTS.vat6!
    default: return null
  }
}

/**
 * Turns one ledger row into one balanced journal entry.
 *
 * Every entry moves the receivable (1510) against something. Debit is
 * positive, credit negative, and the two sides cancel — buildSie refuses
 * anything that does not.
 *
 *   INVOICE_CREATED     debit 1510 gross; credit 300x net and 26xx VAT per rate
 *   CREDIT_NOTE_ISSUED  the mirror image, from the credit note's own lines
 *   PAYMENT_RECEIVED    debit 1930 bank; credit 1510
 *   LATE_FEE_ADDED      debit 1510; credit 8313 interest income
 *   REMINDER_FEE_ADDED  debit 1510; credit 3590 fee income
 *   *_WAIVED            the reverse of the two above
 *
 * REFUND and ADJUSTMENT are not written by any current code path and are
 * skipped with a note in the text; an importer would rather see a gap than a
 * guess at which account a generic adjustment belongs to.
 */
function toVerification(row: reportRepository.LedgerRowForExport): SieVerification | null {
  const rcv = ACCOUNTS.receivables!.number
  const number = row.invoice.invoiceNumber

  switch (row.type) {
    case 'INVOICE_CREATED':
    case 'CREDIT_NOTE_ISSUED': {
      // For a credit note the row sits on the ORIGINAL invoice (its ledger
      // is what balances to zero), but the lines to split across accounts
      // are the ORIGINAL's, negated — the same figures, opposite sign.
      const sign = row.type === 'CREDIT_NOTE_ISSUED' ? -1 : 1
      const byRate = new Map<number, { net: number; vat: number }>()
      for (const item of row.invoice.items) {
        const group = byRate.get(item.vatRate) ?? { net: 0, vat: 0 }
        group.net += item.netOre * sign
        group.vat += item.vatOre * sign
        byRate.set(item.vatRate, group)
      }

      const transactions = [{ account: rcv, amountOre: row.amountOre }]
      for (const [rate, sums] of byRate) {
        transactions.push({ account: salesAccount(rate).number, amountOre: -sums.net })
        const vat = vatAccount(rate)
        if (vat && sums.vat !== 0) transactions.push({ account: vat.number, amountOre: -sums.vat })
      }

      return {
        date: row.createdAt,
        text: row.type === 'INVOICE_CREATED' ? `Faktura ${number}` : `Kreditering av faktura ${number}`,
        transactions
      }
    }

    case 'PAYMENT_RECEIVED':
      return {
        date: row.createdAt,
        text: `Betalning faktura ${number}`,
        transactions: [
          { account: ACCOUNTS.bank!.number, amountOre: row.amountOre },
          { account: rcv, amountOre: -row.amountOre }
        ]
      }

    case 'LATE_FEE_ADDED':
    case 'LATE_FEE_WAIVED':
      return {
        date: row.createdAt,
        text: row.type === 'LATE_FEE_ADDED' ? `Dröjsmålsränta faktura ${number}` : `Ränta avskriven faktura ${number}`,
        transactions: [
          { account: rcv, amountOre: row.amountOre },
          { account: ACCOUNTS.interest!.number, amountOre: -row.amountOre }
        ]
      }

    case 'REMINDER_FEE_ADDED':
    case 'REMINDER_FEE_WAIVED':
      return {
        date: row.createdAt,
        text: row.type === 'REMINDER_FEE_ADDED' ? `Påminnelseavgift faktura ${number}` : `Avgift avskriven faktura ${number}`,
        transactions: [
          { account: rcv, amountOre: row.amountOre },
          { account: ACCOUNTS.fees!.number, amountOre: -row.amountOre }
        ]
      }

    case 'REFUND':
    case 'ADJUSTMENT':
      return null
  }
}

export type SieExport = {
  bytes: Buffer
  filename: string
  verificationCount: number
  skipped: number
}

export async function sieExport(
  year: number,
  actingAdminId: string,
  context: RequestContext = {}
): Promise<SieExport> {
  const rows = await reportRepository.findLedgerRowsForYear(year)

  const verifications: SieVerification[] = []
  let skipped = 0
  for (const row of rows) {
    const verification = toVerification(row)
    if (verification) verifications.push(verification)
    else skipped += 1
  }

  const text = buildSie({
    companyName: env.COMPANY_NAME,
    orgNumber: env.COMPANY_ORG_NUMBER,
    year,
    generatedAt: new Date(),
    accounts: Object.values(ACCOUNTS),
    verifications
  })

  // Handing the ledger to an outside system is worth a line in the audit
  // log — it is the moment the data leaves Fakturly.
  await record({
    action: AuditAction.REPORT_EXPORTED,
    resource: 'Report',
    resourceId: `sie:${year}`,
    userId: actingAdminId,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })

  return {
    bytes: encodeCp437(text),
    filename: `fakturly-${year}.se`,
    verificationCount: verifications.length,
    skipped
  }
}
