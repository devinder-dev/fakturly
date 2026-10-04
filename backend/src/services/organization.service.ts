// organization.service.ts — creating tenants.
//
// There is no HTTP route that creates an organization. A new tenant is an
// operator decision (a contract, a customer of Fakturly itself), so it comes
// from `bun run org:create` on the server — the same reasoning that keeps
// the first ADMIN out of reach of HTTP (prisma/seed.ts). Admins will edit
// their OWN organization's details later; they never create or pick one.

import { Prisma } from '../generated/prisma/client.ts'
import * as organizationRepository from '../repositories/organization.repository.ts'
import type { OrganizationRecord } from '../repositories/organization.repository.ts'
import type { CreateOrganizationInput } from '../validators/organization.validator.ts'
import { record, AuditAction, AuditResource } from './audit.service.ts'
import { ConflictError } from '../lib/errors.ts'

/**
 * Creates an organization from already-validated input.
 *
 * The unique index on orgNumber is the real duplicate check. A lookup first
 * ("does it exist? no? insert") would race: two runs at once both find
 * nothing and both insert. Catching P2002 cannot race.
 */
export async function createOrganization(
  input: CreateOrganizationInput
): Promise<OrganizationRecord> {
  let organization: OrganizationRecord
  try {
    organization = await organizationRepository.createOrganization(input)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Specific on purpose, unlike the API's deliberately vague 409: only an
      // operator can reach this. It still does not echo the number back —
      // for an enskild firma the organisationsnummer IS the owner's
      // personnummer, i.e. personal data, so it stays out of messages and logs.
      throw new ConflictError('Det finns redan en organisation med det organisationsnumret')
    }
    throw error
  }

  // userId null: no person in the system did this. The row still says what
  // was created and when, which is what a later "where did this tenant come
  // from?" needs.
  await record({
    action: AuditAction.ORGANIZATION_CREATED,
    resource: AuditResource.ORGANIZATION,
    userId: null,
    organizationId: organization.id,
    resourceId: organization.id
  })

  return organization
}
