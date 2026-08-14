// middleware.test.ts — authenticate and authorize.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { FastifyInstance } from 'fastify'
import {
  buildTestApp,
  createTestUser,
  loginAs,
  clearRateLimits,
  cleanupUsers,
  uniqueSuffix,
  prisma
} from '../helpers.ts'
import { authenticate } from '../../src/middleware/authenticate.ts'
import { authorize } from '../../src/middleware/authorize.ts'
import { createAccessToken } from '../../src/services/token.service.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `mw-admin-${suffix}@exempel.se`
const CLIENT_EMAIL = `mw-client-${suffix}@exempel.se`

let adminId: string
let clientId: string
let adminToken: string
let clientToken: string

beforeAll(async () => {
  app = await buildTestApp((instance) => {
    instance.get('/_t/admin', { onRequest: [authenticate, authorize('ADMIN')] }, async (req) => ({
      role: req.authUser?.role
    }))
    instance.get('/_t/client', { onRequest: [authenticate, authorize('CLIENT')] }, async () => ({
      ok: true
    }))
    instance.get(
      '/_t/both',
      { onRequest: [authenticate, authorize('ADMIN', 'CLIENT')] },
      async () => ({ ok: true })
    )
    // Deliberately misconfigured: authorize WITHOUT authenticate.
    instance.get('/_t/misconfigured', { onRequest: [authorize('ADMIN')] }, async () => ({
      ok: true
    }))
  })

  adminId = (await createTestUser(ADMIN_EMAIL, 'ADMIN')).id
  clientId = (await createTestUser(CLIENT_EMAIL, 'CLIENT')).id

  adminToken = (await loginAs(app, ADMIN_EMAIL, '198.51.100.30')).accessToken
  clientToken = (await loginAs(app, CLIENT_EMAIL, '198.51.100.31')).accessToken
})

afterAll(async () => {
  await cleanupUsers([adminId, clientId])
  await clearRateLimits()
})

const get = (url: string, authorization?: string) =>
  app.inject({
    method: 'GET',
    url,
    headers: authorization ? { authorization } : {},
    remoteAddress: '198.51.100.30'
  })

describe('authenticate rejects bad tokens', () => {
  const cases: Array<[string, string | undefined]> = [
    ['no Authorization header', undefined],
    ['empty Bearer', 'Bearer '],
    ['wrong scheme', 'Basic abc123'],
    ['garbage token', 'Bearer not-a-jwt']
  ]

  for (const [label, header] of cases) {
    test(`${label} -> 401`, async () => {
      expect((await get('/auth/me', header)).statusCode).toBe(401)
    })
  }

  test('tampered payload -> 401', async () => {
    const [head, , sig] = adminToken.split('.')
    const forged = Buffer.from(JSON.stringify({ sub: 'hacker', role: 'ADMIN' })).toString(
      'base64url'
    )
    expect((await get('/auth/me', `Bearer ${head}.${forged}.${sig}`)).statusCode).toBe(401)
  })

  test('tampered signature -> 401', async () => {
    expect((await get('/auth/me', `Bearer ${adminToken.slice(0, -6)}AAAAAA`)).statusCode).toBe(401)
  })

  test('🔒 every rejection returns the SAME code', async () => {
    const codes = await Promise.all(
      [...cases.map(([, h]) => h), `Bearer ${adminToken.slice(0, -6)}AAAAAA`].map((h) =>
        get('/auth/me', h).then((r) => r.json().error.code)
      )
    )
    // Distinguishing "expired" from "malformed" tells a prober how far they
    // got, which is free reconnaissance.
    expect(new Set(codes).size).toBe(1)
  })
})

describe('authenticate accepts a valid token', () => {
  test('200 and the correct user', async () => {
    const res = await get('/auth/me', `Bearer ${adminToken}`)

    expect(res.statusCode).toBe(200)
    expect(res.json().user.id).toBe(adminId)
    expect(res.json().user.email).toBe(ADMIN_EMAIL)
  })

  test('/auth/me reads the database, so the email is present despite not being in the token', async () => {
    const res = await get('/auth/me', `Bearer ${adminToken}`)
    expect(res.json().user.email).toBe(ADMIN_EMAIL)
  })
})

describe('🎯 the denylist is what makes logout real', () => {
  test('the same token works, then stops working after logout', async () => {
    const session = await loginAs(app, ADMIN_EMAIL, '198.51.100.32')

    expect((await get('/auth/me', `Bearer ${session.accessToken}`)).statusCode).toBe(200)

    await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        cookie: `fakturly_refresh=${session.refreshCookie}`
      },
      remoteAddress: '198.51.100.32'
    })

    expect((await get('/auth/me', `Bearer ${session.accessToken}`)).statusCode).toBe(401)
    // The token is still cryptographically valid — correct signature, not
    // expired. Only the denylist stops it.
  })
})

describe('authorize — the role gate', () => {
  test('ADMIN passes an admin route', async () => {
    expect((await get('/_t/admin', `Bearer ${adminToken}`)).statusCode).toBe(200)
  })

  test('CLIENT gets 403 on an admin route — not 401', async () => {
    const res = await get('/_t/admin', `Bearer ${clientToken}`)

    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('FORBIDDEN')
    // 401 would tell the client to refresh its token, which cannot help.
  })

  test('CLIENT passes a client route', async () => {
    expect((await get('/_t/client', `Bearer ${clientToken}`)).statusCode).toBe(200)
  })

  test('roles are NOT hierarchical: ADMIN is refused on a CLIENT-only route', async () => {
    expect((await get('/_t/client', `Bearer ${adminToken}`)).statusCode).toBe(403)
    // "Admin can do everything" is how admin endpoints quietly become the way
    // staff read customer data they should not. Hierarchy must be explicit.
  })

  test('a multi-role route accepts both', async () => {
    expect((await get('/_t/both', `Bearer ${adminToken}`)).statusCode).toBe(200)
    expect((await get('/_t/both', `Bearer ${clientToken}`)).statusCode).toBe(200)
  })

  test('no token on a role-gated route is 401, not 403', async () => {
    expect((await get('/_t/admin')).statusCode).toBe(401)
  })
})

describe('a misconfigured route fails CLOSED', () => {
  test('authorize without authenticate denies everyone', async () => {
    const res = await get('/_t/misconfigured', `Bearer ${adminToken}`)

    expect(res.statusCode).toBe(401)
    // A 500 would surface the wiring bug faster but turns a misconfiguration
    // into an outage. Denying presents as "nobody can access this", which is
    // noticed in minutes and harms nobody.
  })
})

describe('a token outliving its user', () => {
  test('stops working once the user is deleted', async () => {
    const ghost = await createTestUser(`ghost-${suffix}@exempel.se`, 'CLIENT')
    const token = createAccessToken(ghost.id, 'CLIENT').token

    expect((await get('/auth/me', `Bearer ${token}`)).statusCode).toBe(200)

    await prisma.user.delete({ where: { id: ghost.id } })

    expect((await get('/auth/me', `Bearer ${token}`)).statusCode).toBe(401)
  })
})
