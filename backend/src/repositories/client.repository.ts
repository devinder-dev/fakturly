// client.repository.ts — database queries for Client.
//
// A Client row is ONE SELLER'S record of a customer (ADR 56). The same person
// buying from two sellers has two Client rows, one per organization, and one
// login (User). Every function that reads or writes a seller's customers
// takes that seller's organizationId FIRST and puts it in the WHERE clause,
// so a query for another organization's customer finds nothing at all.
//
// The exceptions are scoped by the LOGIN instead — "every seller this
// customer buys from" — and say so in their names.

import { prisma } from '../lib/prisma.ts'

export type ProvisionClientInput = {
  email: string
  /** Used only if no login exists for this email yet. */
  passwordHash: string
  name: string
  phone?: string | undefined
  address?: string | undefined
}

export type ProvisionedClient = {
  userId: string
  clientId: string
  email: string
  name: string
  organizationName: string
  /**
   * What happened to the LOGIN, which decides the email the person gets:
   *   'created'          — a brand-new login: invite them to set a password
   *   'existing-pending' — a customer login whose owner never set a password
   *                        (another seller's invite went unanswered or
   *                        expired): invite them again — "log in as usual"
   *                        means nothing to someone who never chose one
   *   'existing-client'  — an activated customer login: tell them this
   *                        seller added them; their password is unchanged
   *   'existing-staff'   — the address is a staff login somewhere: tell them
   *                        without a portal link, which that login cannot use
   * Internal only: the HTTP response is identical in every case.
   */
  login: 'created' | 'existing-pending' | 'existing-client' | 'existing-staff'
}

/**
 * Adds a customer to an organization — creating the login only if none exists.
 *
 * Atomic: the login (when new) and the Client row land together, or neither
 * does. A login with no customer record would let someone log in to an empty
 * portal while holding an email address no one can provision again.
 *
 * WHY createMany({ skipDuplicates }) AND NOT "find, then create": two sellers
 * adding the same brand-new address at the same moment would both find no
 * login and both try to create one; the loser would fail on the unique email
 * and roll back a perfectly good customer. skipDuplicates is
 * INSERT ... ON CONFLICT DO NOTHING — one atomic statement. Whoever comes
 * second simply finds the login the first one made. And unlike catching the
 * unique violation, it does not abort the surrounding transaction.
 *
 * The role of a NEW login is hardcoded to CLIENT, and a customer login gets
 * no organizationId (the database's CHECK enforces both). Nothing reachable
 * over HTTP can create an ADMIN.
 *
 * A duplicate WITHIN this organization (same email or same login twice)
 * still fails on the Client unique keys: that is the seller's own customer
 * list, so saying "already exists" leaks nothing from anyone else.
 */
export async function provisionClient(
  organizationId: string,
  input: ProvisionClientInput
): Promise<ProvisionedClient> {
  return prisma.$transaction(async (tx) => {
    const inserted = await tx.user.createMany({
      data: [{ email: input.email, password: input.passwordHash, role: 'CLIENT' }],
      skipDuplicates: true
    })

    const user = await tx.user.findUniqueOrThrow({
      where: { email: input.email },
      select: { id: true, email: true, role: true, passwordSetAt: true }
    })

    const client = await tx.client.create({
      data: {
        organizationId,
        userId: user.id,
        name: input.name,
        email: input.email,
        phone: input.phone ?? null,
        address: input.address ?? null
      },
      select: { id: true, name: true, organization: { select: { name: true } } }
    })

    return {
      userId: user.id,
      clientId: client.id,
      email: user.email,
      name: client.name,
      organizationName: client.organization.name,
      login:
        inserted.count === 1
          ? 'created'
          : user.role !== 'CLIENT'
            ? 'existing-staff'
            : user.passwordSetAt === null
              ? 'existing-pending'
              : 'existing-client'
    }
  })
}

/** The fields every client endpoint returns. One definition, so no endpoint
 *  accidentally leaks a column added to the model later. */
const clientSelect = {
  id: true,
  organizationId: true,
  organization: { select: { id: true, name: true } },
  userId: true,
  name: true,
  email: true,
  phone: true,
  address: true,
  createdAt: true
} as const

export type ClientRecord = {
  id: string
  organizationId: string
  /** The seller this record belongs to — what the portal groups by. */
  organization: { id: string; name: string }
  userId: string
  name: string
  email: string
  phone: string | null
  address: string | null
  createdAt: Date
}

/** One of this organization's customers, or null — also for another
 *  organization's id, indistinguishably. */
export async function findClientById(
  organizationId: string,
  id: string
): Promise<ClientRecord | null> {
  return prisma.client.findUnique({
    where: { id_organizationId: { id, organizationId } },
    select: clientSelect
  })
}

/**
 * Every customer record a login has — one per seller it buys from.
 *
 * Scoped by the LOGIN, not by an organization, on purpose: this is the
 * customer portal's view, and a customer of two sellers must see both. It is
 * not a crossing: every row returned belongs to the caller.
 */
export async function findClientsOfUser(userId: string): Promise<ClientRecord[]> {
  return prisma.client.findMany({
    where: { userId },
    select: clientSelect,
    orderBy: { createdAt: 'asc' }
  })
}

/** One of the login's own customer records, or null if it is not theirs. */
export async function findClientOfUser(
  userId: string,
  id: string
): Promise<ClientRecord | null> {
  return prisma.client.findFirst({ where: { id, userId }, select: clientSelect })
}

export type ListClientsResult = {
  clients: ClientRecord[]
  total: number
}

/**
 * Lists one organization's customers, newest first.
 *
 * The count runs in the same transaction as the page, so `total` cannot
 * describe a different set of rows than the one returned — without that,
 * a client created between the two queries makes the pagination inconsistent.
 */
export async function listClients(
  organizationId: string,
  limit: number,
  offset: number
): Promise<ListClientsResult> {
  const where = { organizationId }
  const [clients, total] = await prisma.$transaction([
    prisma.client.findMany({
      where,
      select: clientSelect,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset
    }),
    prisma.client.count({ where })
  ])

  return { clients, total }
}

export type UpdateClientData = {
  name?: string | undefined
  phone?: string | null | undefined
  address?: string | null | undefined
}

/**
 * Updates one of this organization's customers. Returns null when there is
 * no such customer HERE — including when the id is another organization's.
 */
export async function updateClient(
  organizationId: string,
  id: string,
  data: UpdateClientData
): Promise<ClientRecord | null> {
  // updateMany, because its WHERE may hold the organization. A plain update
  // addresses the row by id alone and would edit another tenant's customer.
  const updated = await prisma.client.updateMany({
    where: { id, organizationId },
    // Only the three fields we allow. Passing the request body straight
    // through would be mass assignment — a caller adding "userId" would
    // repoint the client at somebody else's login account.
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.phone !== undefined ? { phone: data.phone } : {}),
      ...(data.address !== undefined ? { address: data.address } : {})
    }
  })
  if (updated.count === 0) return null

  return findClientById(organizationId, id)
}
