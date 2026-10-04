// organization.repository.ts — database queries for Organization. Nothing else.
//
// An organization is the tenant itself, so these functions do not take an
// organizationId "scope" the way client or invoice queries will: there is
// nothing above an organization to scope it by. That is also why they must
// never be reachable with an id from a request — an admin's own organization
// comes from their token, not from a URL.

import { prisma } from '../lib/prisma.ts'

/** Every column an organization has. Explicit, so a column added later is
 *  not returned anywhere until someone decides it should be. */
const organizationSelect = {
  id: true,
  name: true,
  orgNumber: true,
  vatNumber: true,
  address: true,
  email: true,
  bankgiro: true,
  fSkatt: true,
  paymentTermsDays: true,
  createdAt: true,
  updatedAt: true
} as const

export type OrganizationRecord = {
  id: string
  name: string
  orgNumber: string
  vatNumber: string | null
  address: string
  email: string
  bankgiro: string | null
  fSkatt: boolean
  paymentTermsDays: number
  createdAt: Date
  updatedAt: Date
}

export type CreateOrganizationData = {
  name: string
  orgNumber: string
  vatNumber?: string | undefined
  address: string
  email: string
  bankgiro?: string | undefined
  fSkatt: boolean
  paymentTermsDays: number
}

export async function createOrganization(
  data: CreateOrganizationData
): Promise<OrganizationRecord> {
  return prisma.organization.create({
    data: {
      name: data.name,
      orgNumber: data.orgNumber,
      vatNumber: data.vatNumber ?? null,
      address: data.address,
      email: data.email,
      bankgiro: data.bankgiro ?? null,
      fSkatt: data.fSkatt,
      paymentTermsDays: data.paymentTermsDays
    },
    select: organizationSelect
  })
}

/**
 * Looks an organization up by its organisationsnummer.
 *
 * For operator tools (seeding the first admin), where a human knows the
 * company's number but not our internal id. The caller must pass the
 * normalised form — see orgNumberSchema.
 */
export async function findOrganizationByOrgNumber(
  orgNumber: string
): Promise<OrganizationRecord | null> {
  return prisma.organization.findUnique({ where: { orgNumber }, select: organizationSelect })
}
