// organizations.test.ts — the tenant itself: creation, duplicates, and the
// database guarantees the organizations migration put in place.

import { describe, test, expect, afterAll } from 'bun:test'
import { randomInt } from 'node:crypto'
import {
  createTestOrganization,
  createTestUser,
  cleanupOrganizations,
  uniqueSuffix,
  prisma
} from '../helpers.ts'
import { createOrganization } from '../../src/services/organization.service.ts'
import { createOrganizationSchema } from '../../src/validators/organization.validator.ts'
import { ConflictError } from '../../src/lib/errors.ts'
import { Prisma } from '../../src/generated/prisma/client.ts'

const suffix = uniqueSuffix()
const organizationIds: string[] = []

afterAll(async () => {
  await cleanupOrganizations(organizationIds)
})

/**
 * The Postgres error underneath a Prisma error.
 *
 * Asserting "it threw" is too weak for a database guarantee: a typo in the
 * test's own SQL throws too, and the test would pass while proving nothing.
 * The SQLSTATE code says WHICH rule fired, and the message or constraint
 * name says on WHICH column.
 */
async function postgresError(run: () => Promise<unknown>) {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error
    const adapterError = error.meta?.driverAdapterError as
      | { cause?: { originalCode?: string; originalMessage?: string; constraint?: { index?: string } } }
      | undefined
    return adapterError?.cause ?? {}
  }
  throw new Error('Expected the database to refuse this, but it succeeded')
}

/** Ten random digits, as the operator might type them — no dash. */
const randomOrgDigits = () => String(randomInt(0, 10_000_000_000)).padStart(10, '0')

/** `orgNumber` exactly as typed; the VAT number is built from its digits. */
const validInput = (orgNumber: string) =>
  createOrganizationSchema.parse({
    name: 'Organisationstest AB',
    orgNumber,
    vatNumber: `SE${orgNumber.replace('-', '')}01`,
    address: 'Testvägen 2, 222 22 Lund',
    email: `Faktura-${suffix}@Org.example.se`
  })

describe('createOrganization', () => {
  test('stores normalised details and records who-did-what in the audit log', async () => {
    const digits = randomOrgDigits()
    const organization = await createOrganization(validInput(digits))
    organizationIds.push(organization.id)

    expect(organization.orgNumber).toBe(`${digits.slice(0, 6)}-${digits.slice(6)}`)
    expect(organization.email).toBe(`faktura-${suffix}@org.example.se`)
    expect(organization.fSkatt).toBe(true)
    expect(organization.paymentTermsDays).toBe(30)

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'ORGANIZATION_CREATED', resourceId: organization.id }
    })
    expect(audit).not.toBeNull()
    // An operator ran a command; no user of the system did this.
    expect(audit!.userId).toBeNull()
  })

  test('🔑 the same organisationsnummer twice is a conflict, however it is spelled', async () => {
    const digits = randomOrgDigits()
    const first = await createOrganization(validInput(digits))
    organizationIds.push(first.id)

    // Without the dash this time. Normalisation is what makes the unique
    // index catch it — compared as typed, the two strings differ.
    const dashed = `${digits.slice(0, 6)}-${digits.slice(6)}`
    expect(validInput(dashed).orgNumber).toBe(first.orgNumber)
    await expect(createOrganization(validInput(dashed))).rejects.toBeInstanceOf(ConflictError)

    expect(await prisma.organization.count({ where: { orgNumber: first.orgNumber } })).toBe(1)
  })
})

describe('🏢 what the database itself guarantees', () => {
  test('a user without an organization cannot be inserted, even bypassing Prisma', async () => {
    // Prisma's types already refuse this at compile time. Raw SQL is how a
    // future script or migration would slip past them; NOT NULL is the floor.
    const error = await postgresError(() => prisma.$executeRaw`
      INSERT INTO "User" ("id", "email", "password", "role", "updatedAt")
      VALUES (${`orgless-${suffix}`}, ${`orgless-${suffix}@exempel.se`}, 'x', 'CLIENT', now())
    `)

    // 23502 = not_null_violation, and on organizationId specifically — every
    // other NOT NULL column is supplied above.
    expect(error.originalCode).toBe('23502')
    expect(error.originalMessage).toContain('"organizationId"')

    expect(await prisma.user.count({ where: { email: `orgless-${suffix}@exempel.se` } })).toBe(0)
  })

  test('an organization that still has users cannot be deleted', async () => {
    const organization = await createTestOrganization()
    organizationIds.push(organization.id)
    await createTestUser(organization.id, `kvar-${suffix}@exempel.se`)

    // ON DELETE RESTRICT: removing a tenant must be a deliberate sequence,
    // never a side effect that orphans — or cascades through — its data.
    const error = await postgresError(() =>
      prisma.organization.delete({ where: { id: organization.id } })
    )

    // 23503 = foreign_key_violation, raised by the User -> Organization key.
    expect(error.originalCode).toBe('23503')
    expect(error.constraint?.index).toBe('User_organizationId_fkey')
    expect(await prisma.organization.count({ where: { id: organization.id } })).toBe(1)
  })
})
