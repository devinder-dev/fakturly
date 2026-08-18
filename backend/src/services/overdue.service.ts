// overdue.service.ts — finding overdue invoices and accruing interest.
//
// Takes plain arguments and returns plain data, so it can be driven from a
// BullMQ worker, a cron trigger, or a test. This is the payoff for the rule
// that services never touch `request` — the whole reason it was worth
// enforcing back in week 1.

import {
  calculateLateInterest,
  daysBetween,
  REFERENCE_RATE_BASIS_POINTS
} from '../lib/money.ts'
import { prisma } from '../lib/prisma.ts'
import { record, AuditAction, AuditResource } from './audit.service.ts'

export type OverdueResult = {
  invoiceId: string
  invoiceNumber: string
  daysLate: number
  interestAddedOre: number
  newlyOverdue: boolean
}

export type OverdueRunSummary = {
  checked: number
  markedOverdue: number
  interestAccruedOre: number
  results: OverdueResult[]
}

/**
 * Finds invoices past their due date and accrues interest on each.
 *
 * `now` is a parameter rather than being read inside. A job whose behaviour
 * depends on a hidden clock can only be tested by waiting, or by mocking
 * time globally — both of which produce tests nobody trusts. Passing it in
 * means "what happens 400 days late" is a one-line test.
 */
export async function runOverdueCheck(now: Date = new Date()): Promise<OverdueRunSummary> {
  // Only SENT and OVERDUE invoices can accrue. A DRAFT was never issued, and
  // a PAID one is settled.
  const candidates = await prisma.invoice.findMany({
    where: {
      status: { in: ['SENT', 'OVERDUE'] },
      dueDate: { lt: now }
    },
    select: {
      id: true,
      invoiceNumber: true,
      status: true,
      dueDate: true,
      grossTotalOre: true,
      lateFeeOre: true,
      currency: true
    }
  })

  const results: OverdueResult[] = []
  let markedOverdue = 0
  let interestAccruedOre = 0

  for (const invoice of candidates) {
    const daysLate = daysBetween(invoice.dueDate, now)

    // Interest owed in TOTAL as of today, on the invoice amount.
    const totalOwed = calculateLateInterest(
      invoice.grossTotalOre,
      daysLate,
      REFERENCE_RATE_BASIS_POINTS
    )

    // Only the increment since the last run. The job runs daily, so charging
    // the total each time would compound it into nonsense within a week.
    const increment = totalOwed - invoice.lateFeeOre

    const newlyOverdue = invoice.status === 'SENT'

    // Nothing to do: already OVERDUE and no further interest has accrued
    // (a same-day second run, or an amount too small to round to an öre).
    if (!newlyOverdue && increment <= 0) {
      continue
    }

    await applyOverdue({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      newLateFeeOre: Math.max(invoice.lateFeeOre, totalOwed),
      incrementOre: Math.max(0, increment),
      currency: invoice.currency,
      daysLate,
      newlyOverdue
    })

    if (newlyOverdue) markedOverdue += 1
    interestAccruedOre += Math.max(0, increment)

    results.push({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      daysLate,
      interestAddedOre: Math.max(0, increment),
      newlyOverdue
    })
  }

  return {
    checked: candidates.length,
    markedOverdue,
    interestAccruedOre,
    results
  }
}

/**
 * Applies one invoice's overdue state and its interest — atomically.
 *
 * The status change, the accumulated fee and the ledger row must land
 * together. An invoice showing a late fee with no ledger entry explaining it
 * is a number the customer can dispute and we cannot justify.
 *
 * The ledger row records the INCREMENT, not the running total. Each row is
 * one day's (or one run's) accrual, so the entries sum to the fee on the
 * invoice — which is what makes it explainable line by line.
 */
async function applyOverdue(params: {
  invoiceId: string
  invoiceNumber: string
  newLateFeeOre: number
  incrementOre: number
  currency: string
  daysLate: number
  newlyOverdue: boolean
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // The status guard is in the WHERE clause, so an invoice paid between the
    // query above and this write is not marked overdue after the fact.
    const updated = await tx.invoice.updateMany({
      where: { id: params.invoiceId, status: { in: ['SENT', 'OVERDUE'] } },
      data: { status: 'OVERDUE', lateFeeOre: params.newLateFeeOre }
    })

    if (updated.count === 0) return

    if (params.incrementOre > 0) {
      await tx.transaction.create({
        data: {
          invoiceId: params.invoiceId,
          type: 'LATE_FEE_ADDED',
          amountOre: params.incrementOre,
          currency: params.currency,
          description:
            `Dröjsmålsränta för faktura ${params.invoiceNumber}, ` +
            `${params.daysLate} dagar efter förfallodatum`
        }
      })
    }
  })

  if (params.newlyOverdue) {
    await record({
      action: AuditAction.INVOICE_OVERDUE,
      resource: AuditResource.INVOICE,
      // No acting user: this was the scheduler, not a person.
      resourceId: params.invoiceId
    })
  }
}
