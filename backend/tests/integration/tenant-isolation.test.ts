// tenant-isolation.test.ts — no organization can see or touch another's data (ADR 56).
//
// The whole multi-tenancy design rests on one property: every query a staff
// member makes is scoped to their organization. Unit-testing each repository
// would prove each function; this proves the property, end to end, through
// the real routes — the way an attacker with a valid login would try it.
//
// Part 1 (phase 2): every route that takes an id, the lists, invoice
// creation, and a customer who buys from two sellers. Part 2 (phase 3) adds
// the aggregates — dashboard, reports, audit log — and a guard that fails
// when a new route has no row here.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import {
  buildTestApp,
  createTestTenant,
  withUserId,
  loginAs,
  authed,
  clearRateLimits,
  cleanupOrganizations,
  testPasswordHash,
  uniqueSuffix,
  prisma
} from '../helpers.ts'
import { peekLastNumber } from '../../src/repositories/invoiceNumber.repository.ts'
import { VatRate, stockholmYear } from '../../src/lib/money.ts'

const suffix = uniqueSuffix()
const ADMIN_A = `iso-admin-a-${suffix}@alfa.example.se`
const ADMIN_B = `iso-admin-b-${suffix}@beta.example.se`
const CUSTOMER = `iso-kund-${suffix}@kund.example.se`

/** Shaped like a cuid, belongs to nobody. The baseline every refusal is compared to. */
const NEVER_EXISTED = 'cnobodyeverhadthisid00000'

const ITEMS = [{ description: 'Konsulttimme', quantity: 2, unitPriceOre: 95_000, vatRate: VatRate.STANDARD }]

let app: FastifyInstance
let orgA: string
let orgB: string
let tokenA: string
let tokenB: string
let customerOfA: { id: string; userId: string }
let draftOfA: string
let sentOfA: string

const as = (token: string) => authed(app, token)

async function createInvoice(token: string, clientId: string, send: boolean): Promise<string> {
  const res = await as(token)('POST', '/invoices', {
    clientId,
    dueDate: '2026-12-31T00:00:00.000Z',
    items: ITEMS
  })
  if (res.statusCode !== 201) throw new Error(`setup: invoice ${res.statusCode} ${res.body}`)
  const id: string = res.json().invoice.id
  if (send) await as(token)('POST', `/invoices/${id}/send`)
  return id
}

beforeAll(async () => {
  app = await buildTestApp()

  const a = await createTestTenant(ADMIN_A, 'Alfa AB')
  const b = await createTestTenant(ADMIN_B, 'Beta AB')
  orgA = a.organization.id
  orgB = b.organization.id
  tokenA = (await loginAs(app, ADMIN_A, '198.51.100.200')).accessToken
  tokenB = (await loginAs(app, ADMIN_B, '198.51.100.201')).accessToken

  const provisioned = await as(tokenA)('POST', '/clients', { email: CUSTOMER, name: 'Kund hos Alfa' })
  customerOfA = await withUserId(provisioned.json().client)

  // One of each state, so every write below WOULD succeed for A's own admin:
  // a refusal can only come from the organization, never from the status.
  draftOfA = await createInvoice(tokenA, customerOfA.id, false)
  sentOfA = await createInvoice(tokenA, customerOfA.id, true)
})

afterAll(async () => {
  await cleanupOrganizations([orgA, orgB])
  await clearRateLimits()
})

/** Everything of A's that B's attempts could conceivably have changed. */
async function snapshotOfA() {
  return {
    invoices: await prisma.invoice.findMany({
      where: { organizationId: orgA },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        status: true,
        sentAt: true,
        reminderFeeOre: true,
        reminderSentAt: true,
        stripePaymentId: true,
        updatedAt: true
      }
    }),
    ledgerRows: await prisma.transaction.count({ where: { organizationId: orgA } }),
    clients: await prisma.client.findMany({
      where: { organizationId: orgA },
      orderBy: { id: 'asc' },
      select: { id: true, name: true, phone: true, address: true }
    }),
    series: await prisma.invoiceNumberSeries.findMany({ where: { organizationId: orgA } })
  }
}

/** A response with its request id removed — the one part that always differs. */
function comparable(res: LightMyRequestResponse) {
  const body = res.json()
  if (body?.error) delete body.error.requestId
  return { status: res.statusCode, body }
}

// ─────────────────────────────────────────────────────────────
// Every route that takes an id
// ─────────────────────────────────────────────────────────────

type IdRoute = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  id: () => string
  payload?: unknown
}

const ID_ROUTES: IdRoute[] = [
  { method: 'GET', path: '/clients/{id}', id: () => customerOfA.id },
  { method: 'PATCH', path: '/clients/{id}', id: () => customerOfA.id, payload: { name: 'Kapad AB' } },
  { method: 'GET', path: '/invoices/{id}', id: () => sentOfA },
  { method: 'GET', path: '/invoices/{id}/pdf', id: () => sentOfA },
  { method: 'POST', path: '/invoices/{id}/send', id: () => draftOfA },
  { method: 'POST', path: '/invoices/{id}/payment-link', id: () => sentOfA },
  { method: 'POST', path: '/invoices/{id}/credit-note', id: () => sentOfA },
  { method: 'POST', path: '/invoices/{id}/reminder', id: () => sentOfA },
  { method: 'DELETE', path: '/invoices/{id}', id: () => draftOfA }
]

describe('🏢 admin B on admin A\'s ids', () => {
  for (const route of ID_ROUTES) {
    test(`${route.method} ${route.path} — 404, identical to an id that never existed, and A is untouched`, async () => {
      const before = await snapshotOfA()
      const url = (id: string) => route.path.replace('{id}', id)

      const theirs = await as(tokenB)(route.method, url(route.id()), route.payload)
      const nobodys = await as(tokenB)(route.method, url(NEVER_EXISTED), route.payload)

      expect(theirs.statusCode).toBe(404)
      // Not just "also 404": the same body. Any difference — a word, a
      // field — would let B tell A's ids from random ones.
      expect(comparable(theirs)).toEqual(comparable(nobodys))
      expect(await snapshotOfA()).toEqual(before)
    })
  }

  test('…while A\'s own admin reaches the same ids (the table is not vacuous)', async () => {
    for (const route of ID_ROUTES.filter((r) => r.method === 'GET')) {
      const res = await as(tokenA)('GET', route.path.replace('{id}', route.id()))
      expect(res.statusCode).toBe(200)
    }
  })
})

// ─────────────────────────────────────────────────────────────
// Lists and creation
// ─────────────────────────────────────────────────────────────

describe('🏢 lists contain only the caller\'s organization', () => {
  test('GET /invoices', async () => {
    const theirInvoice = await createInvoice(tokenB, (await as(tokenB)('POST', '/clients', {
      email: `iso-egen-${suffix}@kund.example.se`,
      name: 'Betas egen kund'
    })).json().client.id, false)

    const res = await as(tokenB)('GET', '/invoices?limit=100')
    const ids = res.json().invoices.map((i: { id: string }) => i.id)

    expect(ids).toContain(theirInvoice)
    expect(ids).not.toContain(sentOfA)
    expect(ids).not.toContain(draftOfA)
    expect(res.json().invoices.every((i: { seller: { id: string } }) => i.seller.id === orgB)).toBe(true)
  })

  test('GET /invoices filtered by A\'s client id is simply empty — not refused', async () => {
    // Refusing would confirm the id is real. Empty says nothing.
    const res = await as(tokenB)('GET', `/invoices?clientId=${customerOfA.id}`)

    expect(res.statusCode).toBe(200)
    expect(res.json().pagination.total).toBe(0)
  })

  test('GET /clients', async () => {
    const res = await as(tokenB)('GET', '/clients?limit=100')
    const ids = res.json().clients.map((c: { id: string }) => c.id)

    expect(ids).not.toContain(customerOfA.id)
  })
})

describe('🏢 POST /invoices with A\'s client id', () => {
  test('404 like a client that never existed, and no number is spent in either series', async () => {
    const year = stockholmYear()
    const seriesA = await peekLastNumber(orgA, year)
    const seriesB = await peekLastNumber(orgB, year)

    const body = (clientId: string) => ({ clientId, dueDate: '2026-12-31T00:00:00.000Z', items: ITEMS })
    const theirs = await as(tokenB)('POST', '/invoices', body(customerOfA.id))
    const nobodys = await as(tokenB)('POST', '/invoices', body(NEVER_EXISTED))

    expect(theirs.statusCode).toBe(404)
    expect(comparable(theirs)).toEqual(comparable(nobodys))
    // The client is checked BEFORE a number is allocated. A number burned on
    // a refused invoice is a gap in B's series that B would have to explain.
    expect(await peekLastNumber(orgB, year)).toBe(seriesB)
    expect(await peekLastNumber(orgA, year)).toBe(seriesA)
  })
})

// ─────────────────────────────────────────────────────────────
// One customer, two sellers
// ─────────────────────────────────────────────────────────────

describe('🏢 a customer who buys from both A and B', () => {
  let customerOfB: string
  let invoiceFromB: string
  let customerToken: string

  test('B adding A\'s customer looks exactly like adding a brand-new one', async () => {
    const before = await snapshotOfA()

    const fresh = await as(tokenB)('POST', '/clients', {
      email: `iso-ny-${suffix}@kund.example.se`,
      name: 'Helt ny kund'
    })
    const existing = await as(tokenB)('POST', '/clients', { email: CUSTOMER, name: 'Kund hos Beta' })

    // Same status, same fields. The old design answered 409 here — telling
    // B that the address was someone else's customer, and letting B block A
    // from adding it by getting there first.
    expect(existing.statusCode).toBe(201)
    expect(fresh.statusCode).toBe(201)
    expect(Object.keys(existing.json().client).sort()).toEqual(Object.keys(fresh.json().client).sort())
    expect(existing.json().client).not.toHaveProperty('userId')

    customerOfB = existing.json().client.id
    // A's records are exactly as they were.
    expect(await snapshotOfA()).toEqual(before)
  })

  test('one login, two customer records — and an email, not a second invite', async () => {
    const records = await prisma.client.findMany({
      where: { userId: customerOfA.userId },
      select: { organizationId: true }
    })
    expect(records.map((r) => r.organizationId).sort()).toEqual([orgA, orgB].sort())

    const emails = await prisma.emailLog.findMany({
      where: { userId: customerOfA.userId },
      select: { type: true }
    })
    // INVITE from A (the first provisioning); CUSTOMER_ADDED from B. A second
    // invite would let B's admin trigger a password change on a login B does
    // not own.
    expect(emails.map((e) => e.type).sort()).toEqual(['CUSTOMER_ADDED', 'INVITE'])
  })

  test('the portal shows both sellers\' invoices, each naming its seller', async () => {
    invoiceFromB = await createInvoice(tokenB, customerOfB, true)

    await prisma.user.update({
      where: { id: customerOfA.userId },
      data: { password: await testPasswordHash() }
    })
    customerToken = (await loginAs(app, CUSTOMER, '198.51.100.202')).accessToken

    const res = await as(customerToken)('GET', '/invoices?limit=100')
    const sellers = new Map(
      res.json().invoices.map((i: { id: string; seller: { name: string } }) => [i.id, i.seller.name])
    )

    expect(sellers.get(sentOfA)).toBe('Alfa AB')
    expect(sellers.get(invoiceFromB)).toBe('Beta AB')
    // Nothing that is not addressed to one of this login's own records.
    const own = new Set([customerOfA.id, customerOfB])
    expect(res.json().invoices.every((i: { clientId: string }) => own.has(i.clientId))).toBe(true)
  })

  test('…and both records, at GET /clients/me', async () => {
    const res = await as(customerToken)('GET', '/clients/me')
    const sellers = res.json().clients.map((c: { seller: { name: string } }) => c.seller.name).sort()

    expect(sellers).toEqual(['Alfa AB', 'Beta AB'])
  })

  test('…but not B\'s invoices to anyone else', async () => {
    const someoneElses = await createInvoice(
      tokenB,
      (await as(tokenB)('POST', '/clients', {
        email: `iso-annan-${suffix}@kund.example.se`,
        name: 'Annan kund hos Beta'
      })).json().client.id,
      true
    )

    expect((await as(customerToken)('GET', `/invoices/${invoiceFromB}`)).statusCode).toBe(200)
    expect((await as(customerToken)('GET', `/invoices/${someoneElses}`)).statusCode).toBe(404)
  })

  test('B adding a STAFF address: the same 201, and the staff login is untouched', async () => {
    const res = await as(tokenB)('POST', '/clients', { email: ADMIN_A, name: 'Alfas admin som kund' })

    expect(res.statusCode).toBe(201)
    expect(res.json().client).not.toHaveProperty('userId')

    const adminA = await prisma.user.findUniqueOrThrow({
      where: { email: ADMIN_A },
      select: { id: true, role: true, organizationId: true }
    })
    expect(adminA.role).toBe('ADMIN')
    expect(adminA.organizationId).toBe(orgA)
    // Exactly one email, as in every other branch, so response time cannot
    // tell the branches apart — without a portal link, since one login has
    // one role and this one cannot open the customer portal.
    const emails = await prisma.emailLog.findMany({ where: { userId: adminA.id }, select: { type: true } })
    expect(emails.map((e) => e.type)).toEqual(['CUSTOMER_ADDED'])
  })

  test('🔒 B\'s own audit trail is the same whatever the address already was', async () => {
    // Phase 3 lets an admin read their organization's audit log. If adding a
    // brand-new address left a different trail there than adding someone
    // else's customer or staff, the identical 201 would be for nothing.
    const trailOf = async (email: string) => {
      const res = await as(tokenB)('POST', '/clients', { email, name: 'Spårkund' })
      expect(res.statusCode).toBe(201)
      const rows = await prisma.auditLog.findMany({
        where: {
          organizationId: orgB,
          OR: [{ resourceId: res.json().client.id }, { email }]
        },
        select: { action: true }
      })
      return rows.map((r) => r.action).sort()
    }

    const brandNew = await trailOf(`iso-spar-${suffix}@kund.example.se`)
    // Another seller's customer: give A a fresh one for this.
    const elsewhere = `iso-spar-a-${suffix}@kund.example.se`
    await as(tokenA)('POST', '/clients', { email: elsewhere, name: 'Alfas kund' })
    const existingCustomer = await trailOf(elsewhere)

    expect(existingCustomer).toEqual(brandNew)
    expect(brandNew).toEqual(['CLIENT_CREATED'])
  })
})
