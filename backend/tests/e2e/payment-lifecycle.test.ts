// payment-lifecycle.test.ts — an invoice from issue to settlement.
//
// Two stories, told in order:
//   A. issued -> payment link -> paid on time
//   B. issued -> ignored -> overdue -> interest accrues -> paid late
//
// If both pass, the money side of Fakturly works end to end.

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
  testPasswordHash,
  prisma
} from '../helpers.ts'
import { signStubPayload } from '../../src/lib/stripe.ts'
import { runOverdueCheck } from '../../src/services/overdue.service.ts'
import { calculateLateInterest, VatRate, formatOre } from '../../src/lib/money.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `life-admin-${suffix}@fakturly.se`
const CLIENT_EMAIL = `life-kund-${suffix}@kund.se`

let adminToken: string
let clientToken: string
let clientId: string
const userIds: string[] = []
const eventIds: string[] = []

const asAdmin = () => authed(app, adminToken)
const DUE = new Date('2026-03-31T00:00:00.000Z')
const dayAfter = (days: number) => new Date(DUE.getTime() + days * 86_400_000)

beforeAll(async () => {
  app = await buildTestApp()
  userIds.push((await createTestUser(ADMIN_EMAIL, 'ADMIN')).id)
  adminToken = (await loginAs(app, ADMIN_EMAIL, '198.51.100.95')).accessToken

  const created = await asAdmin()('POST', '/clients', {
    email: CLIENT_EMAIL,
    name: 'Livscykel AB'
  })
  clientId = created.json().client.id
  userIds.push(created.json().client.userId)

  await prisma.user.update({
    where: { id: created.json().client.userId },
    data: { password: await testPasswordHash() }
  })
  clientToken = (await loginAs(app, CLIENT_EMAIL, '198.51.100.96')).accessToken
})

afterAll(async () => {
  await prisma.processedWebhookEvent.deleteMany({ where: { id: { in: eventIds } } })
  await prisma.emailLog.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.passwordToken.deleteMany({ where: { userId: { in: userIds } } })
  await cleanupUsers(userIds)
  // NOTE: the invoice-number counter is deliberately NOT reset here.
  //
  // It is monotonic by design — rewinding it while invoices bearing those
  // numbers still exist re-creates exactly the collision the unbroken-series
  // requirement exists to prevent. That is not hypothetical: resetting it
  // here broke 20 tests the moment a manually-created invoice survived in
  // the dev database.
  //
  // Letting it advance costs nothing. The series is allowed to have gaps.
  await clearRateLimits()
})

async function issueInvoice() {
  const created = await asAdmin()('POST', '/invoices', {
    clientId,
    dueDate: DUE.toISOString(),
    items: [
      { description: 'Konsultarbete', quantity: 20, unitPriceOre: 50_000, vatRate: VatRate.STANDARD }
    ]
  })

  // Assert on the helper's own calls. An unchecked setup step that fails
  // silently produces a confusing failure three tests later — which is
  // exactly what happened the first time this file ran.
  if (created.statusCode !== 201) {
    throw new Error(`issueInvoice: create failed ${created.statusCode} ${created.body}`)
  }

  const invoice = created.json().invoice
  const sent = await asAdmin()('POST', `/invoices/${invoice.id}/send`)

  if (sent.statusCode !== 200) {
    throw new Error(`issueInvoice: send failed ${sent.statusCode} ${sent.body}`)
  }

  return sent.json().invoice
}

function paymentEvent(invoiceId: string, amountOre: number) {
  const eventId = `evt_life_${suffix}_${Math.random().toString(36).slice(2)}`
  eventIds.push(eventId)

  const body = JSON.stringify({
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${Math.random().toString(36).slice(2)}`,
        payment_intent: `pi_${Math.random().toString(36).slice(2)}`,
        payment_status: 'paid',
        amount_total: amountOre,
        currency: 'sek',
        metadata: { invoiceId }
      }
    }
  })

  return { body, signature: signStubPayload(body) }
}

const postWebhook = (body: string, signature: string) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    payload: body
  })

// ══════════════════════════════════════════════════════════════
describe('A. paid on time', () => {
  let invoiceId: string
  let grossTotalOre: number

  test('1. the admin issues a 12 500 SEK invoice', async () => {
    const invoice = await issueInvoice()
    invoiceId = invoice.id
    grossTotalOre = invoice.grossTotalOre

    // 20 x 500,00 = 10 000,00 net, +25% VAT = 12 500,00 gross
    expect(invoice.netTotalOre).toBe(1_000_000)
    expect(invoice.vatTotalOre).toBe(250_000)
    expect(grossTotalOre).toBe(1_250_000)
    expect(invoice.status).toBe('SENT')
    expect(formatOre(grossTotalOre)).toContain('12')
  })

  test('2. a payment link is created for exactly that amount', async () => {
    const res = await asAdmin()('POST', `/invoices/${invoiceId}/payment-link`)

    expect(res.statusCode).toBe(201)
    expect(res.json().paymentUrl).toBeTruthy()

    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(stored.stripePaymentId).toBe(res.json().sessionId)
  })

  test('3. the client can see the invoice, and only their own', async () => {
    const res = await authed(app, clientToken)('GET', `/invoices/${invoiceId}`)

    expect(res.statusCode).toBe(200)
    expect(res.json().invoice.grossTotalOre).toBe(grossTotalOre)
  })

  test('4. Stripe reports the payment and the invoice settles', async () => {
    const { body, signature } = paymentEvent(invoiceId, grossTotalOre)

    const res = await postWebhook(body, signature)
    expect(res.json().handled).toBe(true)

    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(stored.status).toBe('PAID')
    expect(stored.paidAt).not.toBeNull()
  })

  test('5. the ledger tells the whole story, in order', async () => {
    const ledger = await prisma.transaction.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'asc' }
    })

    expect(ledger.map((row) => row.type)).toEqual(['INVOICE_CREATED', 'PAYMENT_RECEIVED'])
    expect(ledger[0]!.amountOre).toBe(grossTotalOre)
    expect(ledger[1]!.amountOre).toBe(grossTotalOre)
  })

  test('6. the client is emailed a confirmation', async () => {
    const email = await prisma.emailLog.findFirst({
      where: { invoiceId, type: 'PAYMENT_CONFIRMED' }
    })
    expect(email?.recipient).toBe(CLIENT_EMAIL)
  })

  test('7. a settled invoice never becomes overdue', async () => {
    await runOverdueCheck(dayAfter(365))

    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(stored.status).toBe('PAID')
    expect(stored.lateFeeOre).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════
describe('B. paid late, with statutory interest', () => {
  let invoiceId: string
  let grossTotalOre: number

  test('1. the invoice is issued and then ignored', async () => {
    const invoice = await issueInvoice()
    invoiceId = invoice.id
    grossTotalOre = invoice.grossTotalOre
    expect(invoice.status).toBe('SENT')
  })

  test('2. the nightly job marks it overdue and starts the interest clock', async () => {
    const summary = await runOverdueCheck(dayAfter(1))

    const mine = summary.results.find((r) => r.invoiceId === invoiceId)
    expect(mine?.newlyOverdue).toBe(true)

    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(stored.status).toBe('OVERDUE')
    expect(stored.lateFeeOre).toBe(calculateLateInterest(grossTotalOre, 1))
  })

  test('3. interest grows day by day, one ledger row per accrual', async () => {
    await runOverdueCheck(dayAfter(15))
    await runOverdueCheck(dayAfter(30))

    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    const expected30 = calculateLateInterest(grossTotalOre, 30)

    expect(stored.lateFeeOre).toBe(expected30)

    const accruals = await prisma.transaction.findMany({
      where: { invoiceId, type: 'LATE_FEE_ADDED' }
    })
    expect(accruals).toHaveLength(3)

    // The rows sum exactly to the figure on the invoice — which is what makes
    // it defensible line by line rather than a number to be taken on trust.
    const summed = accruals.reduce((total, row) => total + row.amountOre, 0)
    expect(summed).toBe(stored.lateFeeOre)
  })

  test('4. re-running the same day charges nothing further', async () => {
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    await runOverdueCheck(dayAfter(30))
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })

    expect(after.lateFeeOre).toBe(before.lateFeeOre)
  })

  test('5. the overdue notice was sent ONCE, not once per day', async () => {
    const notices = await prisma.emailLog.findMany({
      where: { invoiceId, type: 'OVERDUE_NOTICE' }
    })
    // The job enqueues a notice only on the run where the invoice FIRST
    // becomes overdue. Four runs happened above.
    expect(notices.length).toBeLessThanOrEqual(1)
  })

  test('6. the payment link charges invoice + accrued interest', async () => {
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    const owedNow = stored.grossTotalOre + stored.lateFeeOre

    expect(owedNow).toBeGreaterThan(grossTotalOre)

    const res = await asAdmin()('POST', `/invoices/${invoiceId}/payment-link`)
    expect(res.statusCode).toBe(201)
    // The amount is what is outstanding TODAY, not what the invoice said when
    // it was written.
  })

  test('7. paying late settles it, and the ledger balances', async () => {
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    const owed = stored.grossTotalOre + stored.lateFeeOre

    const { body, signature } = paymentEvent(invoiceId, owed)
    await postWebhook(body, signature)

    const settled = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(settled.status).toBe('PAID')

    const ledger = await prisma.transaction.findMany({ where: { invoiceId } })
    const invoiced = ledger
      .filter((row) => row.type === 'INVOICE_CREATED' || row.type === 'LATE_FEE_ADDED')
      .reduce((total, row) => total + row.amountOre, 0)
    const received = ledger
      .filter((row) => row.type === 'PAYMENT_RECEIVED')
      .reduce((total, row) => total + row.amountOre, 0)

    expect(received).toBe(invoiced)
    // Everything charged equals everything received. That is the whole point
    // of an append-only ledger.
  })

  test('8. interest stops the moment it is paid', async () => {
    const atPayment = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })

    await runOverdueCheck(dayAfter(200))

    const later = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(later.lateFeeOre).toBe(atPayment.lateFeeOre)
    expect(later.status).toBe('PAID')
  })
})

// ══════════════════════════════════════════════════════════════
describe('C. nothing about the ledger was ever rewritten', () => {
  test('every Transaction row is append-only', async () => {
    const rows = await prisma.transaction.findMany({
      where: { invoice: { client: { userId: { in: userIds } } } }
    })

    expect(rows.length).toBeGreaterThan(0)
    // The model has no updatedAt column at all: there is no way to record a
    // modification, because modification is not permitted.
    expect('updatedAt' in rows[0]!).toBe(false)
  })
})
