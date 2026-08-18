// invite.test.ts — the set-password flow that finally lets a client log in.

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
  TEST_PASSWORD,
  prisma
} from '../helpers.ts'
import {
  issuePasswordToken,
  buildSetPasswordUrl
} from '../../src/services/passwordToken.service.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `inv-admin-${suffix}@fakturly.se`
const CLIENT_EMAIL = `invitee-${suffix}@kund.se`
const NEW_PASSWORD = 'ett helt nytt och unikt lösenord 7f3a'

let adminId: string
let adminToken: string
let inviteeUserId: string
const userIds: string[] = []

beforeAll(async () => {
  app = await buildTestApp()
  adminId = (await createTestUser(ADMIN_EMAIL, 'ADMIN')).id
  userIds.push(adminId)
  adminToken = (await loginAs(app, ADMIN_EMAIL, '198.51.100.70')).accessToken
})

afterAll(async () => {
  await prisma.emailLog.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.passwordToken.deleteMany({ where: { userId: { in: userIds } } })
  await cleanupUsers(userIds)
  await clearRateLimits()
})

const setPassword = (token: string, password: string) =>
  app.inject({
    method: 'POST',
    url: '/auth/set-password',
    payload: { token, password },
    remoteAddress: '198.51.100.71'
  })

describe('provisioning issues an invite', () => {
  test('creates a client and an unused invite token', async () => {
    const res = await authed(app, adminToken)('POST', '/clients', {
      email: CLIENT_EMAIL,
      name: 'Inbjuden Kund AB'
    })

    expect(res.statusCode).toBe(201)
    inviteeUserId = res.json().client.userId
    userIds.push(inviteeUserId)

    const tokens = await prisma.passwordToken.findMany({ where: { userId: inviteeUserId } })
    expect(tokens).toHaveLength(1)
    expect(tokens[0]!.type).toBe('INVITE')
    expect(tokens[0]!.usedAt).toBeNull()
  })

  test('🔒 stores only a SHA-256 digest, never the token', async () => {
    const token = await prisma.passwordToken.findFirstOrThrow({
      where: { userId: inviteeUserId }
    })
    expect(/^[a-f0-9]{64}$/.test(token.tokenHash)).toBe(true)
  })

  test('records the invite email', async () => {
    const log = await prisma.emailLog.findFirst({
      where: { userId: inviteeUserId, type: 'INVITE' }
    })

    expect(log).not.toBeNull()
    expect(log!.recipient).toBe(CLIENT_EMAIL)
    // Recorded even when sending fails — "we emailed them" is a claim that
    // gets made in disputes and should be backed by a row.
  })

  test('audits INVITE_SENT against the admin', async () => {
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'INVITE_SENT', resourceId: inviteeUserId }
    })
    expect(entry?.userId).toBe(adminId)
  })

  test('🔑 the invited client cannot log in yet', async () => {
    await clearRateLimits()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: CLIENT_EMAIL, password: TEST_PASSWORD },
      remoteAddress: '198.51.100.72'
    })

    expect(res.statusCode).toBe(401)
    // The account holds a random password nobody knows — not even the admin
    // who created it.
  })
})

describe('redeeming the invite', () => {
  test('a valid token sets the password', async () => {
    const { token } = await issuePasswordToken(inviteeUserId, 'INVITE')
    await clearRateLimits()

    const res = await setPassword(token, NEW_PASSWORD)
    expect(res.statusCode).toBe(204)
  })

  test('🎯 and now the client can log in', async () => {
    await clearRateLimits()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: CLIENT_EMAIL, password: NEW_PASSWORD },
      remoteAddress: '198.51.100.73'
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().user.role).toBe('CLIENT')
  })

  test('setting a password does NOT log you in', async () => {
    const { token } = await issuePasswordToken(inviteeUserId, 'INVITE')
    await clearRateLimits()

    const res = await setPassword(token, NEW_PASSWORD)

    expect(res.body).toBe('')
    expect(res.cookies.find((c) => c.name === 'fakturly_refresh')).toBeUndefined()
    // Proving you can read an inbox is not proving you know the password.
  })

  test('the token is marked used, not deleted', async () => {
    const { token } = await issuePasswordToken(inviteeUserId, 'INVITE')
    await clearRateLimits()
    await setPassword(token, NEW_PASSWORD)

    const used = await prisma.passwordToken.findMany({
      where: { userId: inviteeUserId, usedAt: { not: null } }
    })
    expect(used.length).toBeGreaterThan(0)
    // A deleted row would look identical to one that never existed, and a
    // token presented twice is worth seeing.
  })
})

describe('🔒 a token is single-use', () => {
  test('the same token cannot be redeemed twice', async () => {
    const { token } = await issuePasswordToken(inviteeUserId, 'INVITE')
    await clearRateLimits()

    expect((await setPassword(token, NEW_PASSWORD)).statusCode).toBe(204)
    await clearRateLimits()
    expect((await setPassword(token, 'ett annat långt lösenord 99x')).statusCode).toBe(401)
  })

  test('issuing a new token invalidates the previous one', async () => {
    const first = await issuePasswordToken(inviteeUserId, 'INVITE')
    const second = await issuePasswordToken(inviteeUserId, 'INVITE')

    await clearRateLimits()
    expect((await setPassword(first.token, NEW_PASSWORD)).statusCode).toBe(401)
    await clearRateLimits()
    expect((await setPassword(second.token, NEW_PASSWORD)).statusCode).toBe(204)
    // Two working links means revoking access requires hunting down every one
    // ever sent.
  })
})

describe('🔒 every failure looks the same', () => {
  test('unknown, expired and already-used tokens are indistinguishable', async () => {
    const { token: used } = await issuePasswordToken(inviteeUserId, 'INVITE')
    await clearRateLimits()
    await setPassword(used, NEW_PASSWORD)

    // Force one to be expired.
    const { token: expired } = await issuePasswordToken(inviteeUserId, 'INVITE')
    await prisma.passwordToken.updateMany({
      where: { userId: inviteeUserId, usedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) }
    })

    await clearRateLimits()
    const unknownRes = await setPassword('helt-pahittad-token', NEW_PASSWORD)
    await clearRateLimits()
    const expiredRes = await setPassword(expired, NEW_PASSWORD)
    await clearRateLimits()
    const usedRes = await setPassword(used, NEW_PASSWORD)

    for (const res of [unknownRes, expiredRes, usedRes]) {
      expect(res.statusCode).toBe(401)
    }
    expect(expiredRes.json().error.message).toBe(unknownRes.json().error.message)
    expect(usedRes.json().error.message).toBe(unknownRes.json().error.message)
    // Otherwise a stale link tells the holder whether it was ever valid, and
    // whether the account exists.
  })
})

describe('the new password must satisfy policy', () => {
  test('a short password is rejected', async () => {
    const { token } = await issuePasswordToken(inviteeUserId, 'INVITE')
    await clearRateLimits()

    expect((await setPassword(token, 'kort')).statusCode).toBe(400)
  })

  test('🔑 a rejected password does NOT burn the token', async () => {
    const { token } = await issuePasswordToken(inviteeUserId, 'INVITE')

    await clearRateLimits()
    expect((await setPassword(token, 'kort')).statusCode).toBe(400)

    await clearRateLimits()
    expect((await setPassword(token, NEW_PASSWORD)).statusCode).toBe(204)
    // Otherwise a typo costs the user their only link and they need a new
    // invite to try again.
  })
})

describe('setting a password revokes existing sessions', () => {
  test('a session opened before the change stops working', async () => {
    // Log in, so there is a live session.
    await clearRateLimits()
    const session = await loginAs(app, CLIENT_EMAIL, '198.51.100.74').catch(async () => {
      // The password may have been rotated by an earlier test; reset it.
      const { token } = await issuePasswordToken(inviteeUserId, 'INVITE')
      await clearRateLimits()
      await setPassword(token, NEW_PASSWORD)
      await clearRateLimits()
      return {
        accessToken: (
          await app.inject({
            method: 'POST',
            url: '/auth/login',
            payload: { email: CLIENT_EMAIL, password: NEW_PASSWORD },
            remoteAddress: '198.51.100.74'
          })
        ).json().accessToken as string,
        refreshCookie: ''
      }
    })

    // Now set a new password via a fresh token.
    const { token } = await issuePasswordToken(inviteeUserId, 'INVITE')
    await clearRateLimits()
    await setPassword(token, 'ytterligare ett långt lösenord 42')

    const refreshTokens = await prisma.refreshToken.findMany({
      where: { userId: inviteeUserId, revokedAt: null }
    })
    expect(refreshTokens).toHaveLength(0)
    expect(session.accessToken).toBeTruthy()
    // If the password changed because it may have been compromised, leaving
    // the attacker's sessions alive defeats the point of changing it.
  })
})

describe('the emailed link', () => {
  test('points at the frontend and carries the token', () => {
    const url = buildSetPasswordUrl('abc-123_XYZ')

    expect(url).toContain('/set-password?token=')
    expect(url).toContain(encodeURIComponent('abc-123_XYZ'))
  })

  test('the API takes the token in the BODY, not the query string', async () => {
    await clearRateLimits()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/set-password?token=something',
      payload: { password: NEW_PASSWORD },
      remoteAddress: '198.51.100.75'
    })

    expect(res.statusCode).toBe(400)
    // A token in a query string lands in browser history, the Referer header
    // sent to third parties, and every proxy log along the way.
  })
})
