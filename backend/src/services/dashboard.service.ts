// dashboard.service.ts — the admin overview, assembled from the ledger.
//
// The repository answers four separate questions; this file turns them into
// one screen. The only logic here is filling the gaps: a month with no
// invoices must still appear on the chart as zero, or the bars silently
// shift and February's figure sits under March's label.

import * as dashboardRepository from '../repositories/dashboard.repository.ts'
import type { AmountWithCount, ClientBalance, MonthlyRow } from '../repositories/dashboard.repository.ts'

export type AdminDashboard = {
  outstanding: AmountWithCount
  overdue: AmountWithCount
  thisMonth: { invoicedOre: number; receivedOre: number }
  /** Oldest first, always exactly `MONTHS_SHOWN` entries. */
  months: MonthlyRow[]
  topClients: ClientBalance[]
}

const MONTHS_SHOWN = 12
const TOP_CLIENTS = 5

/**
 * The first moment of a month, in Stockholm time, expressed as a UTC instant.
 *
 * `monthsBack: 0` is the current month. The Intl API is used to find the
 * Stockholm calendar date rather than `getMonth()`, which would answer in
 * the server's time zone — and a server in a Frankfurt or Virginia data
 * centre has a different idea of when the month started.
 */
function startOfMonthStockholm(now: Date, monthsBack: number): Date {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(now)

  const year = Number(parts.find((p) => p.type === 'year')?.value)
  const month = Number(parts.find((p) => p.type === 'month')?.value)

  // Date.UTC handles month underflow: month -3 in 2026 is October 2025.
  const target = new Date(Date.UTC(year, month - 1 - monthsBack, 1))

  // That is midnight UTC on the 1st. Stockholm is ahead of UTC, so the
  // Stockholm month actually began one or two hours EARLIER in UTC terms.
  // Shift back by the offset in force on that date.
  const offsetMinutes = stockholmOffsetMinutes(target)
  return new Date(target.getTime() - offsetMinutes * 60_000)
}

/** Minutes ahead of UTC that Stockholm is at the given instant (60 or 120). */
function stockholmOffsetMinutes(at: Date): number {
  const local = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(at)
  const hour = Number(local.find((p) => p.type === 'hour')?.value) % 24
  const minute = Number(local.find((p) => p.type === 'minute')?.value)
  const localMinutes = hour * 60 + minute
  const utcMinutes = at.getUTCHours() * 60 + at.getUTCMinutes()
  // Wraps across midnight: 01:00 local vs 23:00 UTC the day before.
  return ((localMinutes - utcMinutes + 1440 + 720) % 1440) - 720
}

function monthKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(date)
  const year = parts.find((p) => p.type === 'year')?.value
  const month = parts.find((p) => p.type === 'month')?.value
  return `${year}-${month}`
}

export async function getAdminDashboard(now: Date = new Date()): Promise<AdminDashboard> {
  const from = startOfMonthStockholm(now, MONTHS_SHOWN - 1)

  // Independent queries, so they run concurrently. Four sequential round
  // trips would be four times the latency for no reason.
  const [outstanding, overdue, rawMonths, topClients] = await Promise.all([
    dashboardRepository.sumOutstanding(),
    dashboardRepository.sumOverdue(),
    dashboardRepository.sumByMonth(from),
    dashboardRepository.topClientsByOutstanding(TOP_CLIENTS)
  ])

  // Zero-fill. The database only returns months that had activity.
  const byKey = new Map(rawMonths.map((row) => [row.month, row]))
  const months: MonthlyRow[] = []

  for (let back = MONTHS_SHOWN - 1; back >= 0; back -= 1) {
    const key = monthKey(startOfMonthStockholm(now, back))
    months.push(byKey.get(key) ?? { month: key, invoicedOre: 0, receivedOre: 0 })
  }

  const current = months[months.length - 1] ?? { invoicedOre: 0, receivedOre: 0 }

  return {
    outstanding,
    overdue,
    thisMonth: { invoicedOre: current.invoicedOre, receivedOre: current.receivedOre },
    months,
    topClients
  }
}
