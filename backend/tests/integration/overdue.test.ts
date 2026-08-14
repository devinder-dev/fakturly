// overdue.test.ts — the daily job that marks invoices overdue and accrues interest.
//
// runOverdueCheck takes `now` as a parameter, which is what makes these tests
// possible at all: "what happens 400 days late" is a function call, not a wait.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { FastifyInstance } from 'fastify'
import {
  buildTestApp,
  createTestUser,
  loginAs,
  authed,
  clearRateLimits,
  cleanupUsers,
  uniqueSuffix,
  prisma
} from '../helpers.ts'
import { runOverdueCheck } from '../../src/services/overdue.service.ts'
import { calculateLateInterest, VatRate } from '../../src/lib/money.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `od-admin-${suffix}@fakturly.se`

let adminToken: string
let clientId: string
const userIds: string[] = []

const asAdmin = () => authed(app, adminToken)

const DUE = new Date('2026-01-31T00:00:00.000Z')
const dayAfter = (days: number) =>
  new Date(DUE.getTime() + days * 24 * 60 * 60 * 1000)

beforeAll(async () => {
  app = await buildTestApp()
  userIds.push((await createTestUser(ADMIN_EMAIL, 'ADMIN')).id)
  adminToken = (await loginAs(app, ADMIN_EMAIL, '198.51.100.85')).accessToken

  const created = await asAdmin()('POST', '/clients', {
    email: `od-kund-${suffix}@kund.se`,
    name: 'Sen Betalare AB'
  })
  clientId = created.json().client.id
  userIds.push(created.json().client.userId)
})

afterAll(async () => {
  await prisma.emailLog.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.passwordToken.deleteMany({ where: { userId: { in: userIds } } })
  await cleanupUsers(userIds)
  await prisma.invoiceNumberSeries.deleteMany({ where: { year: new Date().getFullYear() } })
  await clearRateLimits()
})

/** An invoice due on DUE, sent unless told otherwise. */
async function makeOverdueInvoice(send = true) {
  const created = await asAdmin()('POST', '/invoices', {
    clientId,
    dueDate: DUE.toISOString(),
    items: [
      // 12 500,00 SEK gross — the figure the unit tests use.
      { description: 'Arbete', quantity: 1, unitPriceOre: 1_000_000, vatRate: VatRate.STANDARD }
    ]
  })
  const invoice = created.json().invoice
  if (send) await asAdmin()('POST', `/invoices/${invoice.id}/send`)
  return invoice
}

describe('marking invoices overdue', () => {
  test('a SENT invoice past its due date becomes OVERDUE', async () => {
    const invoice = await makeOverdueInvoice()

    const summary = await runOverdueCheck(dayAfter(1))

    expect(summary.markedOverdue).toBeGreaterThanOrEqual(1)
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(stored.status).toBe('OVERDUE')
  })

  test('a DRAFT is never touched — it was never issued', async () => {
    const draft = await makeOverdueInvoice(false)

    await runOverdueCheck(dayAfter(30))

    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })
    expect(stored.status).toBe('DRAFT')
    expect(stored.lateFeeOre).toBe(0)
  })

  test('an invoice not yet due is left alone', async () => {
    const invoice = await makeOverdueInvoice()

    // One day BEFORE the due date.
    await runOverdueCheck(new Date(DUE.getTime() - 24 * 60 * 60 * 1000))

    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(stored.status).toBe('SENT')
    expect(stored.lateFeeOre).toBe(0)
  })

  test('audits INVOICE_OVERDUE with no acting user', async () => {
    const invoice = await makeOverdueInvoice()
    await runOverdueCheck(dayAfter(1))

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'INVOICE_OVERDUE', resourceId: invoice.id }
    })
    expect(entry).not.toBeNull()
    expect(entry!.userId).toBeNull()
    // The scheduler did it, not a person.
  })
})

describe('accruing interest', () => {
  test('matches the statutory calculation', async () => {
    const invoice = await makeOverdueInvoice()

    await runOverdueCheck(dayAfter(30))

    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(stored.lateFeeOre).toBe(calculateLateInterest(invoice.grossTotalOre, 30))
  })

  test('🔑 running twice on the same day does NOT double-charge', async () => {
    const invoice = await makeOverdueInvoice()

    await runOverdueCheck(dayAfter(10))
    const afterFirst = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })

    await runOverdueCheck(dayAfter(10))
    const afterSecond = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })

    expect(afterSecond.lateFeeOre).toBe(afterFirst.lateFeeOre)
    // The job charges the INCREMENT since the last run, not the total. A daily
    // job charging the total each time would compound into nonsense in a week.
  })

  test('accrues only the increment as days pass', async () => {
    const invoice = await makeOverdueInvoice()

    await runOverdueCheck(dayAfter(10))
    const atTen = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })

    await runOverdueCheck(dayAfter(20))
    const atTwenty = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })

    expect(atTwenty.lateFeeOre).toBe(calculateLateInterest(invoice.grossTotalOre, 20))
    expect(atTwenty.lateFeeOre).toBeGreaterThan(atTen.lateFeeOre)
  })

  test('🔑 each accrual is its own ledger row, and they sum to the fee', async () => {
    const invoice = await makeOverdueInvoice()

    await runOverdueCheck(dayAfter(5))
    await runOverdueCheck(dayAfter(15))
    await runOverdueCheck(dayAfter(30))

    const fees = await prisma.transaction.findMany({
      where: { invoiceId: invoice.id, type: 'LATE_FEE_ADDED' }
    })
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })

    expect(fees.length).toBe(3)
    const summed = fees.reduce((total, row) => total + row.amountOre, 0)
    expect(summed).toBe(stored.lateFeeOre)
    // This is what makes the figure explainable line by line rather than a
    // number the customer has to take on trust.
  })

  test('the ledger row names the day count', async () => {
    const invoice = await makeOverdueInvoice()
    await runOverdueCheck(dayAfter(42))

    const fee = await prisma.transaction.findFirstOrThrow({
      where: { invoiceId: invoice.id, type: 'LATE_FEE_ADDED' }
    })
    expect(fee.description).toContain('42 dagar')
    expect(fee.description).toContain('Dröjsmålsränta')
  })
})

describe('a paid invoice is finished', () => {
  test('is never marked overdue or charged interest', async () => {
    const invoice = await makeOverdueInvoice()

    // Settle it directly, as the webhook would.
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'PAID', paidAt: new Date() }
    })

    await runOverdueCheck(dayAfter(90))

    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(stored.status).toBe('PAID')
    expect(stored.lateFeeOre).toBe(0)
  })

  test('paying an OVERDUE invoice stops further accrual', async () => {
    const invoice = await makeOverdueInvoice()

    await runOverdueCheck(dayAfter(10))
    const whileOverdue = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(whileOverdue.status).toBe('OVERDUE')

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'PAID', paidAt: new Date() }
    })

    await runOverdueCheck(dayAfter(100))

    const afterPaid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(afterPaid.lateFeeOre).toBe(whileOverdue.lateFeeOre)
  })
})

describe('the run summary', () => {
  test('reports what it did', async () => {
    const invoice = await makeOverdueInvoice()

    const summary = await runOverdueCheck(dayAfter(7))

    expect(summary.checked).toBeGreaterThanOrEqual(1)
    expect(summary.interestAccruedOre).toBeGreaterThan(0)

    const mine = summary.results.find((r) => r.invoiceId === invoice.id)
    expect(mine).toBeDefined()
    expect(mine!.daysLate).toBe(7)
    expect(mine!.newlyOverdue).toBe(true)
  })

  test('newlyOverdue is true only on the first run', async () => {
    const invoice = await makeOverdueInvoice()

    const first = await runOverdueCheck(dayAfter(3))
    const second = await runOverdueCheck(dayAfter(9))

    expect(first.results.find((r) => r.invoiceId === invoice.id)?.newlyOverdue).toBe(true)
    expect(second.results.find((r) => r.invoiceId === invoice.id)?.newlyOverdue).toBe(false)
    // This is what stops the customer getting an identical overdue email
    // every single day the invoice stays unpaid.
  })
})
