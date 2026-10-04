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

const suffix = uniqueSuffix()
const organizationIds: string[] = []

afterAll(async () => {
  await cleanupOrganizations(organizationIds)
})

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
    // (Wrapped in an async arrow: Bun's .rejects wants a native Promise, and
    // Prisma returns a lazy PrismaPromise that only runs when awaited.)
    await expect(
      (async () => prisma.$executeRaw`
        INSERT INTO "User" ("id", "email", "password", "role", "updatedAt")
        VALUES (${`orgless-${suffix}`}, ${`orgless-${suffix}@exempel.se`}, 'x', 'CLIENT', now())
      `)()
    ).rejects.toThrow()

    expect(await prisma.user.count({ where: { email: `orgless-${suffix}@exempel.se` } })).toBe(0)
  })

  test('an organization that still has users cannot be deleted', async () => {
    const organization = await createTestOrganization()
    organizationIds.push(organization.id)
    await createTestUser(organization.id, `kvar-${suffix}@exempel.se`)

    // ON DELETE RESTRICT: removing a tenant must be a deliberate sequence,
    // never a side effect that orphans — or cascades through — its data.
    await expect(
      (async () => prisma.organization.delete({ where: { id: organization.id } }))()
    ).rejects.toThrow()
    expect(await prisma.organization.count({ where: { id: organization.id } })).toBe(1)
  })
})
