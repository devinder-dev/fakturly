// hardening.test.ts — the fixes from the post-launch audit, pinned.
//
// Each test here exists because a reviewer found the opposite behaviour in
// the live demo. ADR 50 has the list.

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
import { env } from '../../src/lib/env.ts'
import { VatRate } from '../../src/lib/money.ts'
import { signStubPayload } from '../../src/lib/stripe.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `hard-admin-${suffix}@fakturly.se`
let adminToken: string
let refreshCookie: string
let clientId: string
const userIds: string[] = []
const eventIds: string[] = []

beforeAll(async () => {
  app = await buildTestApp()
  userIds.push((await createTestUser(ADMIN_EMAIL, 'ADMIN')).id)
  const login = await loginAs(app, ADMIN_EMAIL, '198.51.100.190')
  adminToken = login.accessToken
  refreshCookie = login.refreshCookie

  const created = await authed(app, adminToken)('POST', '/clients', {
    email: `hard-kund-${suffix}@kund.se`,
    name: 'Härdning AB'
  })
  clientId = created.json().client.id
  userIds.push(created.json().client.userId)
})

afterAll(async () => {
  await prisma.processedWebhookEvent.deleteMany({ where: { id: { in: eventIds } } })
  await cleanupUsers(userIds)
  await clearRateLimits()
})

describe('same-origin gate on the cookie endpoints', () => {
  test('🔒 a POST from another site is refused, even with a valid cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { origin: 'https://evil.example', cookie: `fakturly_refresh=${refreshCookie}` }
    })
    expect(res.statusCode).toBe(403)

    // And the cookie was NOT revoked by the attempt.
    const ok = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { origin: env.FRONTEND_URL, cookie: `fakturly_refresh=${refreshCookie}` }
    })
    expect(ok.statusCode).toBe(200)
    refreshCookie = ok.cookies.find((c) => c.name === 'fakturly_refresh')!.value
  })

  test('our own origin passes, and no Origin at all passes (curl, tests)', async () => {
    const own = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { origin: env.FRONTEND_URL, cookie: `fakturly_refresh=${refreshCookie}` }
    })
    expect(own.statusCode).toBe(200)
    refreshCookie = own.cookies.find((c) => c.name === 'fakturly_refresh')!.value

    const none = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `fakturly_refresh=${refreshCookie}` }
    })
    expect(none.statusCode).toBe(200)
    refreshCookie = none.cookies.find((c) => c.name === 'fakturly_refresh')!.value
  })
})

describe('logout clears the cookie with the attributes it was set with', () => {
  test('the clearing Set-Cookie carries path and SameSite', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `fakturly_refresh=${refreshCookie}`, authorization: `Bearer ${adminToken}` }
    })
    expect(res.statusCode).toBe(204)
    const cleared = res.cookies.find((c) => c.name === 'fakturly_refresh')!
    expect(cleared.path).toBe('/auth')
    expect(String(cleared.sameSite ?? '').toLowerCase()).toBe(env.CROSS_SITE_COOKIES ? 'none' : 'strict')
  })

  test('🔑 replaying the revoked token is a plain 401, not a theft alert', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'TOKEN_THEFT_DETECTED' } })

    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { cookie: `fakturly_refresh=${refreshCookie}` }
      })
      expect(res.statusCode).toBe(401)
    }

    const after = await prisma.auditLog.count({ where: { action: 'TOKEN_THEFT_DETECTED' } })
    expect(after).toBe(before)
    // Anyone holding an old cookie could otherwise flood the highest-severity
    // alert the system has.
  })
})

describe('the webhook claim lives inside the payment transaction', () => {
  test('🔑 a paid session for an already-paid invoice is claimed AND audited as unapplied', async () => {
    adminToken = (await loginAs(app, ADMIN_EMAIL, '198.51.100.191')).accessToken
    const asAdmin = authed(app, adminToken)
    const created = await asAdmin('POST', '/invoices', {
      clientId,
      dueDate: '2027-12-31T00:00:00.000Z',
      items: [{ description: 'x', quantity: 1, unitPriceOre: 100_000, vatRate: VatRate.STANDARD }]
    })
    const id = created.json().invoice.id
    await asAdmin('POST', `/invoices/${id}/send`)

    const pay = (eventId: string) => {
      eventIds.push(eventId)
      const body = JSON.stringify({
        id: eventId,
        type: 'checkout.session.completed',
        data: { object: { id: `cs_${eventId}`, payment_status: 'paid', amount_total: 125_000, metadata: { invoiceId: id } } }
      })
      return app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'content-type': 'application/json', 'stripe-signature': signStubPayload(body) },
        payload: body
      })
    }

    const first = await pay(`evt_hard_a_${suffix}`)
    expect(first.json().handled).toBe(true)

    // A DIFFERENT event — a second real charge through an old link.
    const second = await pay(`evt_hard_b_${suffix}`)
    expect(second.json()).toEqual({ received: true, handled: false, reason: 'invoice_not_payable' })

    const unapplied = await prisma.auditLog.findFirst({ where: { action: 'PAYMENT_UNAPPLIED', resourceId: id } })
    expect(unapplied).not.toBeNull()
    // Money we hold and cannot apply must never be a quiet outcome.
  })

  test('an unhandled event type is acknowledged without being claimed', async () => {
    const eventId = `evt_hard_c_${suffix}`
    const body = JSON.stringify({ id: eventId, type: 'customer.created', data: { object: { id: 'cus_x' } } })
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signStubPayload(body) },
      payload: body
    })
    expect(res.json().reason).toBe('unhandled_type:customer.created')
    expect(await prisma.processedWebhookEvent.findUnique({ where: { id: eventId } })).toBeNull()
  })
})

describe('/docs', () => {
  test('pins its CDN assets with integrity hashes and sends a CSP', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' })
    expect(res.headers['content-security-policy']).toContain("script-src https://cdn.jsdelivr.net 'sha256-")
    expect((res.body.match(/integrity="sha384-/g) ?? []).length).toBe(2)
    expect(res.body).toContain('persistAuthorization: false')
  })
})
