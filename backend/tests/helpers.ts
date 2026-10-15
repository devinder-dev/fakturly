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

import { randomInt } from 'node:crypto'
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

// ─────────────────────────────────────────────────────────────
// Tenants
// ─────────────────────────────────────────────────────────────

export type TestOrganization = {
  id: string
  name: string
  orgNumber: string
}

/**
 * An organization with a random, unique organisationsnummer.
 *
 * Written straight to the table, not through organization.service: these are
 * fixtures, and a test about invoices should not depend on the org validator.
 * (Random digits are not a valid Luhn number, which is exactly why.)
 */
export async function createTestOrganization(
  name = 'Testbolaget AB'
): Promise<TestOrganization> {
  const digits = String(randomInt(0, 10_000_000_000)).padStart(10, '0')
  return prisma.organization.create({
    data: {
      name,
      orgNumber: `${digits.slice(0, 6)}-${digits.slice(6)}`,
      address: 'Testgatan 1, 111 11 Stockholm',
      email: 'faktura@testbolaget.example.se'
    },
    select: { id: true, name: true, orgNumber: true }
  })
}

export type TestTenant = {
  organization: TestOrganization
  admin: TestUser
}

/** An organization with one ADMIN in it — the unit cross-tenant tests compare. */
export async function createTestTenant(
  adminEmail: string,
  name?: string
): Promise<TestTenant> {
  const organization = await createTestOrganization(name)
  const admin = await createTestUser(organization.id, adminEmail, 'ADMIN')
  return { organization, admin }
}

export type TestUser = {
  id: string
  email: string
  role: Role
}

/**
 * A login belonging to an organization, the way each role belongs (ADR 56).
 *
 *   ADMIN  — staff of `organizationId`.
 *   CLIENT — a customer login (which has no organization of its own, the
 *            database's CHECK insists) plus a customer record in
 *            `organizationId`, so the login is that seller's customer.
 *
 * organizationId is required and first, like in the tenant repositories, so
 * a test cannot create someone who belongs nowhere.
 */
export async function createTestUser(
  organizationId: string,
  email: string,
  role: Role = 'CLIENT'
): Promise<TestUser> {
  const user = await prisma.user.create({
    data: {
      email,
      password: await testPasswordHash(),
      role,
      organizationId: role === 'ADMIN' ? organizationId : null,
      // A known password the test logs in with: an activated login.
      passwordSetAt: new Date()
    },
    select: { id: true, email: true, role: true }
  })

  if (role === 'CLIENT') {
    await prisma.client.create({
      data: { organizationId, userId: user.id, name: email, email }
    })
  }
  return user
}

/**
 * The login behind a customer record. POST /clients deliberately does not
 * return it — a cuid starts with its creation time, which would reveal
 * whether the login already existed — so tests read it from the database.
 */
export async function clientUserId(clientId: string): Promise<string> {
  const client = await prisma.client.findUniqueOrThrow({
    where: { id: clientId },
    select: { userId: true }
  })
  return client.userId
}

/** A provisioned client as returned by POST /clients, plus its login id. */
export async function withUserId<T extends { id: string }>(
  client: T
): Promise<T & { userId: string }> {
  return { ...client, userId: await clientUserId(client.id) }
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

/**
 * Removes organizations and EVERYTHING in them.
 *
 * Every user still in the organization goes first — including client users a
 * test provisioned through POST /clients and never tracked — because the
 * foreign key refuses to delete an organization anyone belongs to. Call it
 * after (or instead of) cleanupUsers.
 */
export async function cleanupOrganizations(organizationIds: string[]): Promise<void> {
  if (organizationIds.length === 0) return

  // Staff carry the organization; customer logins reach it only through a
  // Client row. Both kinds go, with everything they own.
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { organizationId: { in: organizationIds } },
        { clients: { some: { organizationId: { in: organizationIds } } } }
      ]
    },
    select: { id: true }
  })
  await cleanupUsers(users.map((u) => u.id))

  // Rows with no user that still belong to the organization: the overdue
  // job's and Stripe's audit entries, ORGANIZATION_CREATED, ADMIN_CREATED.
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: organizationIds } } })
  await prisma.auditLog.deleteMany({
    where: { resource: 'Organization', resourceId: { in: organizationIds } }
  })
  await prisma.invoiceNumberSeries.deleteMany({
    where: { organizationId: { in: organizationIds } }
  })
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } })
}

/** Audit rows written for an attempted email that never became a user. */
export async function cleanupAuditByEmail(emailFragment: string): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { email: { contains: emailFragment } } })
}

export { prisma, redis }
