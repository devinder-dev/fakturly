// helpers.ts — shared test utilities.
//
// Tests run against a REAL Postgres and Redis, not mocks. That is deliberate:
// most of what this codebase does that could go wrong is at the boundary —
// a transaction that must roll back, a unique constraint, an atomic counter
// under concurrency, a TTL expiring. A mock would happily confirm behaviour
// the real database does not have.
//
// The cost is that tests must not collide with each other. Every test file
// generates its own unique identifiers and cleans up after itself.

import { buildApp } from '../src/app.ts'
import { prisma } from '../src/lib/prisma.ts'
import { redis } from '../src/lib/redis.ts'
import { hashPassword } from '../src/services/password.service.ts'
import type { FastifyInstance } from 'fastify'
import type { Role } from '../src/generated/prisma/client.ts'

/** Password used by every test user. Long enough to satisfy the real policy. */
export const TEST_PASSWORD = 'ett riktigt bra lösenord för tester'

/** Hashing costs ~10ms, so we do it once per file rather than per user. */
let cachedHash: string | undefined
export async function testPasswordHash(): Promise<string> {
  cachedHash ??= await hashPassword(TEST_PASSWORD)
  return cachedHash
}

/**
 * A unique suffix for this test run.
 *
 * Every email, and anything else that must not collide, includes it. Without
 * this, a re-run after a failed cleanup hits a unique constraint and the
 * failure looks like a bug in the code rather than leftover state.
 */
export function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
}

/**
 * Builds the real app for a test file.
 *
 * `registerExtra` is for test-only routes — ones that throw a specific error,
 * or exercise a middleware combination no real route uses yet. It runs BEFORE
 * ready(), because Fastify refuses to add a route to an app that has already
 * booted (FST_ERR_INSTANCE_ALREADY_LISTENING).
 *
 * Note there is no matching teardown: a test file must NOT close the app.
 * Doing so runs the plugins' onClose hooks, which disconnect the shared
 * Prisma and Redis singletons for every file that has not run yet. The single
 * teardown lives in tests/setup.ts.
 */
export async function buildTestApp(
  registerExtra?: (app: FastifyInstance) => void
): Promise<FastifyInstance> {
  const app = await buildApp()
  registerExtra?.(app)
  await app.ready()
  return app
}

/**
 * Clears rate-limit and login-attempt state.
 *
 * Call between tests that log in. Both limiters are shared, global and
 * Redis-backed, so one test's failed logins would otherwise lock out the
 * next test's user — a failure that only appears when tests run together
 * and disappears when you run the file alone.
 */
export async function clearRateLimits(): Promise<void> {
  for (const pattern of ['fakturly:rl:*', 'fakturly:login:fail:*']) {
    const keys = await redis.keys(pattern)
    if (keys.length > 0) await redis.del(...keys)
  }
}

export type TestUser = {
  id: string
  email: string
  role: Role
}

export async function createTestUser(
  email: string,
  role: Role = 'CLIENT'
): Promise<TestUser> {
  const user = await prisma.user.create({
    data: { email, password: await testPasswordHash(), role },
    select: { id: true, email: true, role: true }
  })
  return user
}

export type LoginResult = {
  accessToken: string
  refreshCookie: string
}

export async function loginAs(
  app: FastifyInstance,
  email: string,
  ip = '198.51.100.1'
): Promise<LoginResult> {
  await clearRateLimits()

  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
    remoteAddress: ip
  })

  if (response.statusCode !== 200) {
    throw new Error(`Test login failed for ${email}: ${response.statusCode} ${response.body}`)
  }

  const cookie = response.cookies.find((c) => c.name === 'fakturly_refresh')
  if (!cookie) throw new Error('Test login returned no refresh cookie')

  return { accessToken: response.json().accessToken, refreshCookie: cookie.value }
}

/** Authenticated request helper. */
export function authed(app: FastifyInstance, token: string) {
  return (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload } : {}),
      remoteAddress: '198.51.100.1'
    })
}

/**
 * Removes every row created by a test run, in foreign-key order.
 *
 * Note this deletes audit rows, which production code must never do — that is
 * why it lives here and not in a repository. Test data is not evidence.
 */
export async function cleanupUsers(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return

  // Order matters: every table referencing User must be cleared before the
  // users themselves, or Postgres refuses with a foreign-key violation.
  //
  // This list must grow whenever a new table gains a userId. It has already
  // caught us once — adding PasswordToken and EmailLog broke three suites
  // that had nothing to do with invites, which is exactly the signal you want.
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.passwordToken.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.emailLog.deleteMany({ where: { userId: { in: userIds } } })

  const clients = await prisma.client.findMany({
    where: { userId: { in: userIds } },
    select: { id: true }
  })
  const clientIds = clients.map((c) => c.id)

  if (clientIds.length > 0) {
    const invoices = await prisma.invoice.findMany({
      where: { clientId: { in: clientIds } },
      select: { id: true }
    })
    const invoiceIds = invoices.map((i) => i.id)

    if (invoiceIds.length > 0) {
      await prisma.transaction.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
      await prisma.emailLog.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
      await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
      await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
    }

    await prisma.client.deleteMany({ where: { id: { in: clientIds } } })
  }

  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
}

/** Audit rows written for an attempted email that never became a user. */
export async function cleanupAuditByEmail(emailFragment: string): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { email: { contains: emailFragment } } })
}

export { prisma, redis }
