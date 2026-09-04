// audit-log.test.ts — reading the log.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { FastifyInstance } from 'fastify'
import {
  buildTestApp,
  createTestUser,
  loginAs,
  authed,
  clearRateLimits,
  cleanupUsers,
  uniqueSuffix
} from '../helpers.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `audit-admin-${suffix}@fakturly.se`

let adminId: string
let adminToken: string
let clientToken: string
let clientId: string
const userIds: string[] = []
const asAdmin = () => authed(app, adminToken)

beforeAll(async () => {
  app = await buildTestApp()
  adminId = (await createTestUser(ADMIN_EMAIL, 'ADMIN')).id
  userIds.push(adminId)
  adminToken = (await loginAs(app, ADMIN_EMAIL, '198.51.100.180')).accessToken

  const created = await asAdmin()('POST', '/clients', {
    email: `audit-kund-${suffix}@kund.se`,
    name: 'Logg AB'
  })
  clientId = created.json().client.id
  userIds.push(created.json().client.userId)

  const other = await createTestUser(`audit-kund2-${suffix}@kund.se`, 'CLIENT')
  userIds.push(other.id)
  clientToken = (await loginAs(app, other.email, '198.51.100.181')).accessToken
})

afterAll(async () => {
  await cleanupUsers(userIds)
  await clearRateLimits()
})

describe('GET /audit-log', () => {
  test('lists entries newest first, with the actor resolved to an email', async () => {
    const res = await asAdmin()('GET', `/audit-log?userId=${adminId}`)

    expect(res.statusCode).toBe(200)
    const entries = res.json().entries as Array<{ action: string; actorEmail: string; createdAt: string }>
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((e) => e.actorEmail === ADMIN_EMAIL)).toBe(true)
    expect(entries.map((e) => e.action)).toContain('CLIENT_CREATED')

    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i - 1]!.createdAt >= entries[i]!.createdAt).toBe(true)
    }
  })

  test('filters by resourceId — everything that happened to one row', async () => {
    const res = await asAdmin()('GET', `/audit-log?resourceId=${clientId}`)
    const actions = res.json().entries.map((e: { action: string }) => e.action)
    expect(actions).toContain('CLIENT_CREATED')
  })

  test('filters by action, and refuses one that does not exist', async () => {
    const ok = await asAdmin()('GET', '/audit-log?action=LOGIN_SUCCESS&limit=5')
    expect(ok.statusCode).toBe(200)
    expect(ok.json().entries.every((e: { action: string }) => e.action === 'LOGIN_SUCCESS')).toBe(true)

    const bad = await asAdmin()('GET', '/audit-log?action=DELETE_EVERYTHING')
    expect(bad.statusCode).toBe(400)
  })

  test('exposes the closed set of actions for a filter dropdown', async () => {
    const res = await asAdmin()('GET', '/audit-log?limit=1')
    expect(res.json().actions).toContain('CREDIT_NOTE_ISSUED')
    expect(res.json().actions).toContain('LOGIN_FAILED')
  })

  test('paginates', async () => {
    const res = await asAdmin()('GET', '/audit-log?limit=2&offset=0')
    expect(res.json().entries.length).toBeLessThanOrEqual(2)
    expect(res.json().pagination.limit).toBe(2)
    expect(typeof res.json().pagination.total).toBe('number')
  })

  test('a CLIENT is refused — the log is for staff', async () => {
    const res = await authed(app, clientToken)('GET', '/audit-log')
    expect(res.statusCode).toBe(403)
  })

  test('there is no way to write or delete through HTTP', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const res = await asAdmin()(method, '/audit-log', {})
      expect(res.statusCode).toBe(404)
    }
  })
})
