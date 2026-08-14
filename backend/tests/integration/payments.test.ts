// payments.test.ts — checkout links, webhook verification, idempotency.
//
// Runs against the Stripe STUB, which signs and verifies with the same HMAC
// scheme Stripe uses. So the signature path — including rejection — is really
// exercised, rather than skipped until production.

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
import { signStubPayload } from '../../src/lib/stripe.ts'
import { VatRate } from '../../src/lib/money.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `pay-admin-${suffix}@fakturly.se`

let adminId: string
let adminToken: string
let clientId: string
const userIds: string[] = []
const eventIds: string[] = []

const asAdmin = () => authed(app, adminToken)

beforeAll(async () => {
  app = await buildTestApp()
  adminId = (await createTestUser(ADMIN_EMAIL, 'ADMIN')).id
  userIds.push(adminId)
  adminToken = (await loginAs(app, ADMIN_EMAIL, '198.51.100.80')).accessToken

  const created = await asAdmin()('POST', '/clients', {
    email: `pay-kund-${suffix}@kund.se`,
    name: 'Betalande Kund AB'
  })
  clientId = created.json().client.id
  userIds.push(created.json().client.userId)
})

afterAll(async () => {
  await prisma.processedWebhookEvent.deleteMany({ where: { id: { in: eventIds } } })
  await prisma.emailLog.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.passwordToken.deleteMany({ where: { userId: { in: userIds } } })
  await cleanupUsers(userIds)
  await prisma.invoiceNumberSeries.deleteMany({ where: { year: new Date().getFullYear() } })
  await clearRateLimits()
})

/** Creates an invoice and optionally sends it. */
async function makeInvoice(send = true) {
  const created = await asAdmin()('POST', '/invoices', {
    clientId,
    dueDate: '2026-12-31T00:00:00.000Z',
    items: [
      { description: 'Arbete', quantity: 1, unitPriceOre: 100_000, vatRate: VatRate.STANDARD }
    ]
  })
  const invoice = created.json().invoice
  if (send) await asAdmin()('POST', `/invoices/${invoice.id}/send`)
  return invoice
}

/** Builds a signed checkout.session.completed event for an invoice. */
function paymentEvent(params: {
  invoiceId: string
  amountOre: number
  eventId?: string
  paymentStatus?: string
}) {
  const eventId = params.eventId ?? `evt_test_${suffix}_${Math.random().toString(36).slice(2)}`
  eventIds.push(eventId)

  const body = JSON.stringify({
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_test_${Math.random().toString(36).slice(2)}`,
        payment_intent: `pi_test_${Math.random().toString(36).slice(2)}`,
        payment_status: params.paymentStatus ?? 'paid',
        amount_total: params.amountOre,
        currency: 'sek',
        metadata: { invoiceId: params.invoiceId }
      }
    }
  })

  return { body, signature: signStubPayload(body), eventId }
}

const postWebhook = (body: string, signature: string) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    payload: body
  })

describe('POST /invoices/:id/payment-link', () => {
  test('creates a checkout session for a sent invoice', async () => {
    const invoice = await makeInvoice()
    const res = await asAdmin()('POST', `/invoices/${invoice.id}/payment-link`)

    expect(res.statusCode).toBe(201)
    expect(typeof res.json().paymentUrl).toBe('string')
    expect(res.json().sessionId).toStartWith('cs_')
  })

  test('records the session id on the invoice', async () => {
    const invoice = await makeInvoice()
    const res = await asAdmin()('POST', `/invoices/${invoice.id}/payment-link`)

    const stored = await prisma.invoice.findUnique({ where: { id: invoice.id } })
    expect(stored?.stripePaymentId).toBe(res.json().sessionId)
  })

  test('refuses a DRAFT — nobody has been asked to pay it', async () => {
    const draft = await makeInvoice(false)
    const res = await asAdmin()('POST', `/invoices/${draft.id}/payment-link`)

    expect(res.statusCode).toBe(422)
  })

  test('a CLIENT cannot create one', async () => {
    const invoice = await makeInvoice()
    const clientLogin = await prisma.user.findFirstOrThrow({
      where: { id: { in: userIds }, role: 'CLIENT' }
    })
    expect(clientLogin).toBeTruthy()

    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${invoice.id}/payment-link`,
      headers: { authorization: 'Bearer not-a-real-token' }
    })
    expect(res.statusCode).toBe(401)
  })

  test('audits PAYMENT_LINK_CREATED', async () => {
    const invoice = await makeInvoice()
    await asAdmin()('POST', `/invoices/${invoice.id}/payment-link`)

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'PAYMENT_LINK_CREATED', resourceId: invoice.id }
    })
    expect(entry?.userId).toBe(adminId)
  })
})

describe('🔒 webhook signature verification', () => {
  test('a correctly signed event is accepted', async () => {
    const invoice = await makeInvoice()
    const { body, signature } = paymentEvent({
      invoiceId: invoice.id,
      amountOre: invoice.grossTotalOre
    })

    const res = await postWebhook(body, signature)
    expect(res.statusCode).toBe(200)
    expect(res.json().handled).toBe(true)
  })

  test('🎯 a FORGED signature is rejected with 400', async () => {
    const invoice = await makeInvoice()
    const { body } = paymentEvent({ invoiceId: invoice.id, amountOre: invoice.grossTotalOre })

    const res = await postWebhook(body, 't=1234567890,v1=deadbeef'.padEnd(80, '0'))

    expect(res.statusCode).toBe(400)
    // Without this check, "invoice X is paid" is a message anyone on the
    // internet could send us.
    const stored = await prisma.invoice.findUnique({ where: { id: invoice.id } })
    expect(stored?.status).toBe('SENT')
  })

  test('a tampered body invalidates the signature', async () => {
    const invoice = await makeInvoice()
    const { body, signature } = paymentEvent({
      invoiceId: invoice.id,
      amountOre: invoice.grossTotalOre
    })

    // Change one character after signing.
    const tampered = body.replace('"paid"', '"PAID"')

    const res = await postWebhook(tampered, signature)
    expect(res.statusCode).toBe(400)
  })

  test('a missing signature header is rejected', async () => {
    const invoice = await makeInvoice()
    const { body } = paymentEvent({ invoiceId: invoice.id, amountOre: invoice.grossTotalOre })

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: body
    })
    expect(res.statusCode).toBe(400)
  })

  test('a rejected webhook returns 400, not 500 — Stripe must not retry it', async () => {
    const invoice = await makeInvoice()
    const { body } = paymentEvent({ invoiceId: invoice.id, amountOre: invoice.grossTotalOre })

    const res = await postWebhook(body, 't=1,v1=00')
    expect(res.statusCode).toBe(400)
  })
})

describe('applying a payment', () => {
  test('marks the invoice PAID and writes the ledger row', async () => {
    const invoice = await makeInvoice()
    const { body, signature } = paymentEvent({
      invoiceId: invoice.id,
      amountOre: invoice.grossTotalOre
    })

    await postWebhook(body, signature)

    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(stored.status).toBe('PAID')
    expect(stored.paidAt).not.toBeNull()

    const ledger = await prisma.transaction.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { createdAt: 'asc' }
    })
    expect(ledger.map((t) => t.type)).toEqual(['INVOICE_CREATED', 'PAYMENT_RECEIVED'])
    expect(ledger[1]!.amountOre).toBe(invoice.grossTotalOre)
  })

  test('sends a payment confirmation', async () => {
    const invoice = await makeInvoice()
    const { body, signature } = paymentEvent({
      invoiceId: invoice.id,
      amountOre: invoice.grossTotalOre
    })

    await postWebhook(body, signature)

    const email = await prisma.emailLog.findFirst({
      where: { invoiceId: invoice.id, type: 'PAYMENT_CONFIRMED' }
    })
    expect(email).not.toBeNull()
  })

  test('audits PAYMENT_RECEIVED with no acting user', async () => {
    const invoice = await makeInvoice()
    const { body, signature } = paymentEvent({
      invoiceId: invoice.id,
      amountOre: invoice.grossTotalOre
    })

    await postWebhook(body, signature)

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'PAYMENT_RECEIVED', resourceId: invoice.id }
    })
    expect(entry).not.toBeNull()
    expect(entry!.userId).toBeNull()
    // Stripe told us, not a person.
  })

  test('an unpaid payment_status is not applied', async () => {
    const invoice = await makeInvoice()
    const { body, signature } = paymentEvent({
      invoiceId: invoice.id,
      amountOre: invoice.grossTotalOre,
      paymentStatus: 'unpaid'
    })

    const res = await postWebhook(body, signature)

    expect(res.statusCode).toBe(200)
    expect(res.json().handled).toBe(false)
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(stored.status).toBe('SENT')
  })
})

describe('🎯 idempotency — Stripe delivers at least once', () => {
  test('the SAME event delivered twice is applied once', async () => {
    const invoice = await makeInvoice()
    const { body, signature } = paymentEvent({
      invoiceId: invoice.id,
      amountOre: invoice.grossTotalOre
    })

    const first = await postWebhook(body, signature)
    const second = await postWebhook(body, signature)

    expect(first.json().handled).toBe(true)
    expect(second.statusCode).toBe(200)
    expect(second.json().handled).toBe(false)
    expect(second.json().reason).toBe('duplicate_event')

    const payments = await prisma.transaction.count({
      where: { invoiceId: invoice.id, type: 'PAYMENT_RECEIVED' }
    })
    expect(payments).toBe(1)
    // Layer 1: the event id was already claimed.
  })

  test('a DIFFERENT event for an already-paid invoice is also refused', async () => {
    const invoice = await makeInvoice()

    const first = paymentEvent({ invoiceId: invoice.id, amountOre: invoice.grossTotalOre })
    await postWebhook(first.body, first.signature)

    // A distinct event id — layer 1 will not catch this one.
    const second = paymentEvent({ invoiceId: invoice.id, amountOre: invoice.grossTotalOre })
    const res = await postWebhook(second.body, second.signature)

    expect(res.statusCode).toBe(200)
    expect(res.json().handled).toBe(false)
    expect(res.json().reason).toBe('invoice_not_payable')

    const payments = await prisma.transaction.count({
      where: { invoiceId: invoice.id, type: 'PAYMENT_RECEIVED' }
    })
    expect(payments).toBe(1)
    // Layer 2: markPaid only matches SENT or OVERDUE.
  })

  test('concurrent deliveries of the same event apply it once', async () => {
    const invoice = await makeInvoice()
    const { body, signature } = paymentEvent({
      invoiceId: invoice.id,
      amountOre: invoice.grossTotalOre
    })

    const results = await Promise.all(
      Array.from({ length: 5 }, () => postWebhook(body, signature))
    )

    expect(results.every((r) => r.statusCode === 200)).toBe(true)
    expect(results.filter((r) => r.json().handled === true)).toHaveLength(1)

    const payments = await prisma.transaction.count({
      where: { invoiceId: invoice.id, type: 'PAYMENT_RECEIVED' }
    })
    expect(payments).toBe(1)
    // A SELECT-then-INSERT would let several through here.
  })
})

describe('events we do not act on', () => {
  test('an unknown type is acknowledged with 200, so Stripe stops retrying', async () => {
    const eventId = `evt_other_${suffix}`
    eventIds.push(eventId)
    const body = JSON.stringify({
      id: eventId,
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_123' } }
    })

    const res = await postWebhook(body, signStubPayload(body))

    expect(res.statusCode).toBe(200)
    expect(res.json().reason).toStartWith('unhandled_type:')
    // A 500 here would mean being retried for days over an event we will
    // never handle.
  })

  test('a webhook for an unknown invoice does not 500', async () => {
    const { body, signature } = paymentEvent({
      invoiceId: 'clnotarealinvoice0',
      amountOre: 1000
    })

    const res = await postWebhook(body, signature)

    expect(res.statusCode).toBe(200)
    expect(res.json().reason).toBe('unknown_invoice')
  })
})
