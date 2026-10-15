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
import { setChosenPassword } from '../../src/repositories/user.repository.ts'
import * as invoiceRepository from '../../src/repositories/invoice.repository.ts'
import * as clientRepository from '../../src/repositories/client.repository.ts'
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
// Each write, on its own
// ─────────────────────────────────────────────────────────────
//
// The routes above load an invoice through a scoped read BEFORE writing, so
// they mostly prove the read. These call every write directly with the
// wrong organization: each must refuse by itself, so that a future caller
// that skips the read — a job, a script, a new route — is still safe.

describe('🏢 every scoped write refuses the wrong organization by itself', () => {
  const now = () => new Date()
  const WRITES: Array<[string, () => Promise<unknown>, unknown]> = [
    ['markSent', () => invoiceRepository.markSent(orgB, draftOfA), null],
    ['deleteDraftInvoice', () => invoiceRepository.deleteDraftInvoice(orgB, draftOfA), false],
    ['chargeReminderFee', () => invoiceRepository.chargeReminderFee(orgB, sentOfA, 6_000, now()), null],
    ['markReminderSent', () => invoiceRepository.markReminderSent(orgB, sentOfA, now()), false],
    ['attachCheckoutSession', () => invoiceRepository.attachCheckoutSession(orgB, sentOfA, 'cs_kapad'), false],
    [
      'markPaid',
      () => invoiceRepository.markPaid(orgB, sentOfA, { stripePaymentId: 'pi_kapad', amountOre: 1 }),
      null
    ],
    [
      'createCreditNote',
      () =>
        invoiceRepository.createCreditNote(orgB, {
          originalId: sentOfA,
          creditNoteNumber: '2026-9999',
          clientId: customerOfA.id,
          currency: 'SEK',
          issuedAt: now(),
          netTotalOre: -1,
          vatTotalOre: 0,
          grossTotalOre: -1,
          items: []
        }),
      null
    ],
    ['updateClient', () => clientRepository.updateClient(orgB, customerOfA.id, { name: 'Kapad AB' }), null]
  ]

  for (const [name, write, refused] of WRITES) {
    test(`${name}(B, A's id) → ${String(refused)}, and nothing of A's changes`, async () => {
      const before = await snapshotOfA()

      expect(await write()).toBe(refused)
      expect(await snapshotOfA()).toEqual(before)
    })
  }
})

// ─────────────────────────────────────────────────────────────
// Positive controls: A's own admin, on fresh rows of A's
// ─────────────────────────────────────────────────────────────

describe('…while A\'s own admin can do every one of those writes', () => {
  // Fresh rows per route: each write changes state, and the B-side tests
  // above must keep finding A's rows exactly as they were.
  const CONTROLS: Array<[string, 'PATCH' | 'POST' | 'DELETE', () => Promise<string>, number, unknown?]> = [
    ['PATCH /clients/{id}', 'PATCH', async () => customerOfA.id, 200, { phone: '070-0000000' }],
    ['POST /invoices/{id}/send', 'POST', () => createInvoice(tokenA, customerOfA.id, false), 200],
    ['POST /invoices/{id}/payment-link', 'POST', () => createInvoice(tokenA, customerOfA.id, true), 201],
    ['POST /invoices/{id}/credit-note', 'POST', () => createInvoice(tokenA, customerOfA.id, true), 201],
    ['POST /invoices/{id}/reminder', 'POST', () => createInvoice(tokenA, customerOfA.id, true), 200],
    ['DELETE /invoices/{id}', 'DELETE', () => createInvoice(tokenA, customerOfA.id, false), 204]
  ]

  for (const [label, method, make, status, payload] of CONTROLS) {
    test(`${label} → ${status}`, async () => {
      const id = await make()
      const path = label.split(' ')[1]!.replace('{id}', id)

      expect((await as(tokenA)(method, path, payload)).statusCode).toBe(status)
    })
  }
})

// ─────────────────────────────────────────────────────────────
// A customer of A alone
// ─────────────────────────────────────────────────────────────

describe('🏢 a customer of A alone, on B\'s ids', () => {
  let onlyAToken: string
  let clientOfB: string
  let invoiceOfB: string

  beforeAll(async () => {
    const email = `iso-endast-a-${suffix}@kund.example.se`
    const record = await withUserId(
      (await as(tokenA)('POST', '/clients', { email, name: 'Bara Alfas kund' })).json().client
    )
    await setChosenPassword(record.userId, await testPasswordHash())
    onlyAToken = (await loginAs(app, email, '198.51.100.203')).accessToken

    clientOfB = (await as(tokenB)('POST', '/clients', {
      email: `iso-b-kund-${suffix}@kund.example.se`,
      name: 'Betas kund'
    })).json().client.id
    invoiceOfB = await createInvoice(tokenB, clientOfB, true)
  })

  const READS: Array<[string, () => string]> = [
    ['/clients/{id}', () => clientOfB],
    ['/invoices/{id}', () => invoiceOfB],
    ['/invoices/{id}/pdf', () => invoiceOfB]
  ]

  for (const [path, id] of READS) {
    test(`GET ${path} — 404, identical to an id that never existed`, async () => {
      const theirs = await as(onlyAToken)('GET', path.replace('{id}', id()))
      const nobodys = await as(onlyAToken)('GET', path.replace('{id}', NEVER_EXISTED))

      expect(theirs.statusCode).toBe(404)
      expect(comparable(theirs)).toEqual(comparable(nobodys))
    })
  }
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
    // The customer accepted A's invite: the same call redemption makes.
    await setChosenPassword(customerOfA.userId, await testPasswordHash())
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
    // INVITE from A (the first provisioning); CUSTOMER_ADDED from B — the
    // login is active. A second invite here would let any seller push "set
    // a new password" links at someone else's customer, and void a reset
    // link the customer asked for themselves.
    expect(emails.map((e) => e.type).sort()).toEqual(['CUSTOMER_ADDED', 'INVITE'])
  })

  test('the portal shows both sellers\' invoices, each naming its seller', async () => {
    invoiceFromB = await createInvoice(tokenB, customerOfB, true)

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

    // Another seller's customer who never accepted their invite (pending)…
    const pending = `iso-spar-a-${suffix}@kund.example.se`
    await as(tokenA)('POST', '/clients', { email: pending, name: 'Alfas kund' })
    const pendingTrail = await trailOf(pending)

    // …and one who did (active).
    const active = `iso-spar-aktiv-${suffix}@kund.example.se`
    const activeRecord = await withUserId(
      (await as(tokenA)('POST', '/clients', { email: active, name: 'Alfas aktiva kund' })).json().client
    )
    await setChosenPassword(activeRecord.userId, await testPasswordHash())
    const activeTrail = await trailOf(active)

    expect(pendingTrail).toEqual(brandNew)
    expect(activeTrail).toEqual(brandNew)
    expect(brandNew).toEqual(['CLIENT_CREATED'])
  })
})

describe('🏢 a customer who never accepted the first seller\'s invite', () => {
  test('an expired invite, then a second seller adds them: a fresh invite, not "log in as usual"', async () => {
    const PENDING = `iso-vantar-${suffix}@kund.example.se`
    const first = await as(tokenA)('POST', '/clients', { email: PENDING, name: 'Väntande hos Alfa' })
    const login = await withUserId(first.json().client)

    // A's invite goes unanswered until it expires.
    await prisma.passwordToken.updateMany({
      where: { userId: login.userId },
      data: { expiresAt: new Date(Date.now() - 60_000) }
    })
    const earlier = (await prisma.passwordToken.findMany({ where: { userId: login.userId } })).map((t) => t.id)

    const second = await as(tokenB)('POST', '/clients', { email: PENDING, name: 'Väntande hos Beta' })

    // The admin sees the same 201 as always…
    expect(second.statusCode).toBe(201)
    expect(Object.keys(second.json().client).sort()).toEqual(['email', 'id', 'name'])

    // …the person gets a new, working invite — exactly one, since issuing it
    // voided every earlier link…
    const working = await prisma.passwordToken.findMany({
      where: { userId: login.userId, type: 'INVITE', usedAt: null, expiresAt: { gt: new Date() } }
    })
    expect(working).toHaveLength(1)
    expect(earlier).not.toContain(working[0]!.id)

    // …and no "log in with your usual password": they never chose one.
    const emails = await prisma.emailLog.findMany({ where: { userId: login.userId }, select: { type: true } })
    expect(emails.map((e) => e.type)).toEqual(['INVITE', 'INVITE'])

    // Still pending until they redeem it.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: login.userId } })
    expect(user.passwordSetAt).toBeNull()
  })
})
