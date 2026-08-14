// auth.test.ts — login, refresh rotation, theft detection, logout.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import type { FastifyInstance } from 'fastify'
import {
  buildTestApp,
  createTestUser,
  clearRateLimits,
  cleanupUsers,
  cleanupAuditByEmail,
  uniqueSuffix,
  TEST_PASSWORD,
  prisma,
  redis
} from '../helpers.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()
const EMAIL = `auth-${suffix}@exempel.se`
let userId: string

beforeAll(async () => {
  app = await buildTestApp()
  const user = await createTestUser(EMAIL, 'ADMIN')
  userId = user.id
})

afterAll(async () => {
  await cleanupUsers([userId])
  await cleanupAuditByEmail(suffix)
  await clearRateLimits()
})

beforeEach(async () => {
  await clearRateLimits()
})

const login = (email = EMAIL, password = TEST_PASSWORD, ip = '203.0.113.99') =>
  app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
    remoteAddress: ip
  })

const refreshCookieOf = (res: { cookies: Array<{ name: string; value: string }> }) =>
  res.cookies.find((c) => c.name === 'fakturly_refresh')

const decodeJwt = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1]!, 'base64').toString())

describe('POST /auth/login', () => {
  test('returns an access token and a refresh cookie', async () => {
    const res = await login()

    expect(res.statusCode).toBe(200)
    expect(typeof res.json().accessToken).toBe('string')
    expect(res.json().accessToken.split('.')).toHaveLength(3)
    expect(res.json().user.email).toBe(EMAIL)
    expect(res.json().user.role).toBe('ADMIN')
  })

  test('the refresh token is NOT in the response body', async () => {
    const res = await login()
    // It travels only as an httpOnly cookie, where page JavaScript cannot
    // reach it. Putting it in the body would undo that entirely.
    expect(JSON.stringify(res.json())).not.toContain('refreshToken')
  })

  test('the password hash never leaks', async () => {
    const res = await login()
    expect(JSON.stringify(res.json())).not.toContain('$argon2')
  })

  test('the cookie is httpOnly, sameSite=strict and scoped to /auth', async () => {
    const cookie = refreshCookieOf(await login()) as unknown as {
      httpOnly?: boolean
      sameSite?: string
      path?: string
    }

    expect(cookie.httpOnly).toBe(true)
    expect(String(cookie.sameSite).toLowerCase()).toBe('strict')
    expect(cookie.path).toBe('/auth')
  })

  test('🔒 the JWT carries no PII', async () => {
    const claims = decodeJwt((await login()).json().accessToken)

    expect(claims).toHaveProperty('sub')
    expect(claims).toHaveProperty('role')
    expect(claims).toHaveProperty('jti')
    expect(claims).toHaveProperty('iss')
    expect(claims).toHaveProperty('aud')
    // A JWT is base64, not encryption. Anyone holding it reads every claim.
    expect(JSON.stringify(claims)).not.toContain('@')
  })

  test('expires in 15 minutes', async () => {
    const claims = decodeJwt((await login()).json().accessToken)
    const minutes = (claims.exp - Math.floor(Date.now() / 1000)) / 60

    expect(minutes).toBeGreaterThan(14)
    expect(minutes).toBeLessThanOrEqual(15)
  })
})

describe('🔑 failure modes are indistinguishable', () => {
  test('wrong password and unknown email return identical responses', async () => {
    const wrongPassword = await login(EMAIL, 'helt fel lösenord', '203.0.113.1')
    await clearRateLimits()
    const unknownEmail = await login(
      `finns-inte-${suffix}@ingenstans.se`,
      'helt fel lösenord',
      '203.0.113.2'
    )

    expect(wrongPassword.statusCode).toBe(401)
    expect(unknownEmail.statusCode).toBe(401)
    expect(unknownEmail.json().error.code).toBe(wrongPassword.json().error.code)
    expect(unknownEmail.json().error.message).toBe(wrongPassword.json().error.message)
  })

  test('no refresh cookie is set on failure', async () => {
    const res = await login(EMAIL, 'fel', '203.0.113.3')
    expect(refreshCookieOf(res)).toBeUndefined()
  })

  test('a short password reaches 401, not 400 — the policy is not leaked', async () => {
    const res = await login(EMAIL, 'kort', '203.0.113.4')
    expect(res.statusCode).toBe(401)
  })

  test('a malformed email is a 400 validation error', async () => {
    const res = await login('inte-en-epost', TEST_PASSWORD, '203.0.113.5')
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
  })
})

describe('POST /auth/refresh — rotation', () => {
  test('issues a new pair and spends the old token', async () => {
    const first = await login(EMAIL, TEST_PASSWORD, '203.0.113.50')
    const cookie1 = refreshCookieOf(first)!

    await clearRateLimits()
    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `fakturly_refresh=${cookie1.value}` },
      remoteAddress: '203.0.113.50'
    })

    expect(refreshed.statusCode).toBe(200)
    const cookie2 = refreshCookieOf(refreshed)!
    expect(cookie2.value).not.toBe(cookie1.value)
    expect(typeof refreshed.json().accessToken).toBe('string')
  })

  test('the spent row is marked rotated, not deleted, and shares a family', async () => {
    await prisma.refreshToken.deleteMany({ where: { userId } })

    const first = await login(EMAIL, TEST_PASSWORD, '203.0.113.51')
    await clearRateLimits()
    await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `fakturly_refresh=${refreshCookieOf(first)!.value}` },
      remoteAddress: '203.0.113.51'
    })

    const rows = await prisma.refreshToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' }
    })

    expect(rows).toHaveLength(2)
    expect(rows[0]!.rotatedAt).not.toBeNull()
    expect(rows[1]!.rotatedAt).toBeNull()
    expect(rows[0]!.familyId).toBe(rows[1]!.familyId)
    // Deleting the spent row would make a replay look merely "unknown" —
    // indistinguishable from a typo — and the theft would go unnoticed.
  })

  test('🔒 the raw token is never stored; only a SHA-256 digest', async () => {
    await prisma.refreshToken.deleteMany({ where: { userId } })
    const res = await login(EMAIL, TEST_PASSWORD, '203.0.113.52')
    const raw = refreshCookieOf(res)!.value

    const rows = await prisma.refreshToken.findMany({ where: { userId } })
    expect(rows.some((r) => r.tokenHash === raw)).toBe(false)
    expect(/^[a-f0-9]{64}$/.test(rows[0]!.tokenHash)).toBe(true)
  })

  test('rejects a request with no cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/refresh' })
    expect(res.statusCode).toBe(401)
  })
})

describe('🎯 theft detection', () => {
  test('replaying a spent token revokes the ENTIRE family', async () => {
    await prisma.refreshToken.deleteMany({ where: { userId } })

    const first = await login(EMAIL, TEST_PASSWORD, '203.0.113.60')
    const stolen = refreshCookieOf(first)!.value

    // The legitimate user refreshes, spending the token the thief also holds.
    await clearRateLimits()
    const legit = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `fakturly_refresh=${stolen}` },
      remoteAddress: '203.0.113.60'
    })
    const newest = refreshCookieOf(legit)!.value

    // Now the thief uses their copy.
    await clearRateLimits()
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `fakturly_refresh=${stolen}` },
      remoteAddress: '203.0.113.200'
    })

    expect(replay.statusCode).toBe(401)

    const family = await prisma.refreshToken.findMany({ where: { userId } })
    expect(family.every((t) => t.revokedAt !== null)).toBe(true)

    // And the victim is logged out too — we cannot tell which caller is which.
    await clearRateLimits()
    const victim = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `fakturly_refresh=${newest}` },
      remoteAddress: '203.0.113.60'
    })
    expect(victim.statusCode).toBe(401)
  })
})

describe('POST /auth/logout', () => {
  test('204, clears the cookie, and denylists the access token', async () => {
    const session = await login(EMAIL, TEST_PASSWORD, '203.0.113.70')
    const token = session.json().accessToken
    const jti = decodeJwt(token).jti
    const cookie = refreshCookieOf(session)!

    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        authorization: `Bearer ${token}`,
        cookie: `fakturly_refresh=${cookie.value}`
      },
      remoteAddress: '203.0.113.70'
    })

    expect(res.statusCode).toBe(204)

    const cleared = res.cookies.find((c) => c.name === 'fakturly_refresh')
    expect(cleared?.value).toBe('')

    expect(await redis.exists(`fakturly:denylist:${jti}`)).toBe(1)
  })

  test('the denylist entry expires with the token, so it cannot grow forever', async () => {
    const session = await login(EMAIL, TEST_PASSWORD, '203.0.113.71')
    const jti = decodeJwt(session.json().accessToken).jti

    await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${session.json().accessToken}` },
      remoteAddress: '203.0.113.71'
    })

    const ttl = await redis.ttl(`fakturly:denylist:${jti}`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(15 * 60)
  })

  test('the refresh token stops working', async () => {
    const session = await login(EMAIL, TEST_PASSWORD, '203.0.113.72')
    const cookie = refreshCookieOf(session)!

    await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        authorization: `Bearer ${session.json().accessToken}`,
        cookie: `fakturly_refresh=${cookie.value}`
      },
      remoteAddress: '203.0.113.72'
    })

    await clearRateLimits()
    const after = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `fakturly_refresh=${cookie.value}` }
    })
    expect(after.statusCode).toBe(401)
  })

  test('is forgiving — logging out twice, or with nothing, still succeeds', async () => {
    const session = await login(EMAIL, TEST_PASSWORD, '203.0.113.73')
    const headers = { authorization: `Bearer ${session.json().accessToken}` }

    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers })).statusCode).toBe(204)
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers })).statusCode).toBe(204)
    expect((await app.inject({ method: 'POST', url: '/auth/logout' })).statusCode).toBe(204)
    // Failing would leave a client unsure whether it is logged out, and
    // protects nothing.
  })
})

describe('audit trail', () => {
  test('records a successful login with the caller IP', async () => {
    await login(EMAIL, TEST_PASSWORD, '198.51.100.77')

    const entry = await prisma.auditLog.findFirst({
      where: { userId, action: 'LOGIN_SUCCESS', ipAddress: '198.51.100.77' }
    })
    expect(entry).not.toBeNull()
  })

  test('🔑 records a failed login for an address that never existed', async () => {
    const ghost = `aldrig-funnits-${suffix}@ingenstans.se`
    await login(ghost, 'fel lösenord', '198.51.100.78')

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'LOGIN_FAILED', email: ghost }
    })

    expect(entry).not.toBeNull()
    // userId is null — which the original schema made impossible, and which
    // is exactly what credential stuffing looks like in the log.
    expect(entry!.userId).toBeNull()
    expect(entry!.email).toBe(ghost)
  })
})
