// clients.test.ts — client CRUD and the ownership (IDOR) checks.

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

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `cl-admin-${suffix}@fakturly.se`

let adminId: string
let adminToken: string
let aliceToken: string
let bobToken: string
let alice: { id: string; userId: string }
let bob: { id: string; userId: string }
const userIds: string[] = []

beforeAll(async () => {
  app = await buildTestApp()

  adminId = (await createTestUser(ADMIN_EMAIL, 'ADMIN')).id
  userIds.push(adminId)
  adminToken = (await loginAs(app, ADMIN_EMAIL, '198.51.100.40')).accessToken

  const asAdmin = authed(app, adminToken)
  const a = await asAdmin('POST', '/clients', {
    email: `alice-${suffix}@kund.se`,
    name: 'Alice AB',
    phone: '070-1111111'
  })
  const b = await asAdmin('POST', '/clients', {
    email: `bob-${suffix}@kund.se`,
    name: 'Bob AB'
  })

  alice = a.json().client
  bob = b.json().client
  userIds.push(alice.userId, bob.userId)

  // Provisioned clients have an unknown random password, so give them a
  // known one to log in with. (The invite email that would normally do this
  // arrives in week 3.)
  await prisma.user.updateMany({
    where: { id: { in: [alice.userId, bob.userId] } },
    data: { password: await testPasswordHash() }
  })

  aliceToken = (await loginAs(app, `alice-${suffix}@kund.se`, '198.51.100.41')).accessToken
  bobToken = (await loginAs(app, `bob-${suffix}@kund.se`, '198.51.100.42')).accessToken
})

afterAll(async () => {
  await cleanupUsers(userIds)
  await clearRateLimits()
})

describe('POST /clients', () => {
  test('admin can provision, and no password is returned', async () => {
    const res = await authed(app, adminToken)('POST', '/clients', {
      email: `new-${suffix}@kund.se`,
      name: 'Ny Kund AB'
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.stringify(res.json()).toLowerCase()).not.toContain('password')

    const created = await prisma.user.findUnique({ where: { email: `new-${suffix}@kund.se` } })
    expect(created?.role).toBe('CLIENT')
    if (created) userIds.push(created.id)
  })

  test('🔒 a role in the body is ignored', async () => {
    const email = `escalate-${suffix}@kund.se`
    await authed(app, adminToken)('POST', '/clients', { email, name: 'Hacker', role: 'ADMIN' })

    const created = await prisma.user.findUnique({ where: { email } })
    expect(created?.role).toBe('CLIENT')
    if (created) userIds.push(created.id)
  })

  test('a duplicate email creates NEITHER row', async () => {
    const usersBefore = await prisma.user.count()
    const clientsBefore = await prisma.client.count()

    const res = await authed(app, adminToken)('POST', '/clients', {
      email: `alice-${suffix}@kund.se`,
      name: 'Dubblett AB'
    })

    expect(res.statusCode).toBe(409)
    expect(await prisma.user.count()).toBe(usersBefore)
    expect(await prisma.client.count()).toBe(clientsBefore)
    // Client.userId is required and unique, so a half-created account would
    // be a user who can log in, sees nothing, and whose email is taken.
  })

  test('the 409 does not reveal that the email is taken', async () => {
    const res = await authed(app, adminToken)('POST', '/clients', {
      email: `alice-${suffix}@kund.se`,
      name: 'X'
    })
    const body = res.body.toLowerCase()

    expect(body).not.toContain('email')
    expect(body).not.toContain('constraint')
  })

  test('a CLIENT cannot provision', async () => {
    const res = await authed(app, aliceToken)('POST', '/clients', {
      email: `nope-${suffix}@kund.se`,
      name: 'Nope'
    })

    expect(res.statusCode).toBe(403)
    expect(await prisma.user.findUnique({ where: { email: `nope-${suffix}@kund.se` } })).toBeNull()
  })
})

describe('GET /clients', () => {
  test('admin gets a paginated list', async () => {
    const res = await authed(app, adminToken)('GET', '/clients?limit=5')

    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json().clients)).toBe(true)
    expect(res.json().clients.length).toBeLessThanOrEqual(5)
    expect(typeof res.json().pagination.total).toBe('number')
  })

  test('a CLIENT is refused', async () => {
    expect((await authed(app, aliceToken)('GET', '/clients')).statusCode).toBe(403)
  })

  test('an uncapped limit is rejected rather than scanning the table', async () => {
    expect((await authed(app, adminToken)('GET', '/clients?limit=1000000')).statusCode).toBe(400)
    expect((await authed(app, adminToken)('GET', '/clients?limit=0')).statusCode).toBe(400)
    expect((await authed(app, adminToken)('GET', '/clients?offset=-5')).statusCode).toBe(400)
  })

  test('defaults apply when no query is given', async () => {
    const res = await authed(app, adminToken)('GET', '/clients')
    expect(res.json().pagination.limit).toBe(20)
    expect(res.json().pagination.offset).toBe(0)
  })
})

describe('🎯 IDOR — one client reading another', () => {
  test('Alice can read her own record', async () => {
    const res = await authed(app, aliceToken)('GET', `/clients/${alice.id}`)

    expect(res.statusCode).toBe(200)
    expect(res.json().client.name).toBe('Alice AB')
  })

  test("Alice reading Bob's record gets 404, not 403", async () => {
    const res = await authed(app, aliceToken)('GET', `/clients/${bob.id}`)

    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('NOT_FOUND')
  })

  test('🔑 "exists but not yours" is byte-identical to "never existed"', async () => {
    const notYours = await authed(app, aliceToken)('GET', `/clients/${bob.id}`)
    const neverExisted = await authed(app, aliceToken)('GET', '/clients/clnotarealid000000')

    expect(neverExisted.statusCode).toBe(notYours.statusCode)
    expect(neverExisted.json().error.code).toBe(notYours.json().error.code)
    expect(neverExisted.json().error.message).toBe(notYours.json().error.message)
    // A 403 would mean "this exists and is not yours" — walk a range of ids
    // and every 403 is a real customer.
  })

  test('an admin may read any client', async () => {
    expect((await authed(app, adminToken)('GET', `/clients/${alice.id}`)).statusCode).toBe(200)
    expect((await authed(app, adminToken)('GET', `/clients/${bob.id}`)).statusCode).toBe(200)
  })
})

describe('GET /clients/me — no id means no IDOR is possible', () => {
  test('each client gets their own record', async () => {
    const aliceRes = await authed(app, aliceToken)('GET', '/clients/me')
    const bobRes = await authed(app, bobToken)('GET', '/clients/me')

    expect(aliceRes.json().client.name).toBe('Alice AB')
    expect(bobRes.json().client.name).toBe('Bob AB')
  })

  test('"me" is not parsed as an id', async () => {
    const res = await authed(app, aliceToken)('GET', '/clients/me')
    expect(res.json().client.id).toBe(alice.id)
  })

  test('an admin has no client profile', async () => {
    const res = await authed(app, adminToken)('GET', '/clients/me')
    expect(res.statusCode).toBe(403)
    // A role problem, not a missing row — and it leaks nothing an admin does
    // not already know.
  })
})

describe('PATCH /clients/:id', () => {
  test('admin can update, leaving untouched fields alone', async () => {
    const res = await authed(app, adminToken)('PATCH', `/clients/${alice.id}`, {
      name: 'Alice Consulting AB',
      address: 'Storgatan 5'
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().client.name).toBe('Alice Consulting AB')
    expect(res.json().client.address).toBe('Storgatan 5')
    expect(res.json().client.phone).toBe('070-1111111')
  })

  test('a CLIENT cannot update anyone, including themselves', async () => {
    expect(
      (await authed(app, aliceToken)('PATCH', `/clients/${bob.id}`, { name: 'Hacked' })).statusCode
    ).toBe(403)
    expect(
      (await authed(app, aliceToken)('PATCH', `/clients/${alice.id}`, { name: 'Hacked' }))
        .statusCode
    ).toBe(403)
  })

  test('🔒 email, userId and id cannot be changed', async () => {
    await authed(app, adminToken)('PATCH', `/clients/${alice.id}`, {
      name: 'Still Alice',
      email: 'attacker@evil.se',
      userId: bob.userId,
      id: 'hijacked'
    })

    const after = await prisma.client.findUnique({ where: { id: alice.id } })
    expect(after?.email).toBe(`alice-${suffix}@kund.se`)
    expect(after?.userId).toBe(alice.userId)
    expect(after?.id).toBe(alice.id)
    // Repointing userId would hand one client's record to another's login.
  })

  test('an empty body is rejected', async () => {
    expect((await authed(app, adminToken)('PATCH', `/clients/${alice.id}`, {})).statusCode).toBe(
      400
    )
  })

  test('an unknown id is 404', async () => {
    expect(
      (await authed(app, adminToken)('PATCH', '/clients/clnope000000000', { name: 'x' })).statusCode
    ).toBe(404)
  })
})

describe('audit trail', () => {
  test('CLIENT_CREATED and CLIENT_UPDATED are recorded against the acting admin', async () => {
    const created = await prisma.auditLog.count({
      where: { action: 'CLIENT_CREATED', userId: adminId }
    })
    const updated = await prisma.auditLog.findMany({
      where: { action: 'CLIENT_UPDATED', userId: adminId }
    })

    expect(created).toBeGreaterThanOrEqual(2)
    expect(updated.length).toBeGreaterThanOrEqual(1)
    expect(updated.some((entry) => entry.resourceId === alice.id)).toBe(true)
  })

  test('🔒 the audit log does not copy personal data', async () => {
    const entries = await prisma.auditLog.findMany({
      where: { action: 'CLIENT_UPDATED', userId: adminId }
    })
    const serialised = JSON.stringify(entries)

    expect(serialised).not.toContain('Alice Consulting')
    expect(serialised).not.toContain('Storgatan')
    // An audit log is retained for years. Copying PII into it multiplies the
    // places a leak could expose it, and works against an erasure request.
  })
})

describe('without a token', () => {
  const routes: Array<[string, 'GET' | 'PATCH', string]> = [
    ['list', 'GET', '/clients'],
    ['read one', 'GET', '/clients/someid'],
    ['read own', 'GET', '/clients/me'],
    ['update', 'PATCH', '/clients/someid']
  ]

  for (const [label, method, url] of routes) {
    test(`${label} -> 401`, async () => {
      const res = await app.inject({
        method,
        url,
        ...(method === 'PATCH' ? { payload: { name: 'x' } } : {})
      })
      expect(res.statusCode).toBe(401)
    })
  }
})
