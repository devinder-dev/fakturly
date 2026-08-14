// client.repository.ts — database queries for Client.
//
// Creating a client is the one place where two rows must appear together, so
// this file exposes it as a single atomic operation rather than letting a
// caller create a User and then a Client and hope both succeed.

import { prisma } from '../lib/prisma.ts'

export type CreateClientWithUserInput = {
  email: string
  passwordHash: string
  name: string
  phone?: string | undefined
  address?: string | undefined
}

export type CreatedClient = {
  userId: string
  clientId: string
  email: string
  name: string
}

/**
 * Creates the User and Client rows together, or neither.
 *
 * Why this MUST be one transaction: Client.userId is required and unique. If
 * the User insert succeeded and the Client insert failed, we would be left
 * with a user who can log in but has no client record — so their portal
 * shows nothing, no invoice can be addressed to them, and the email address
 * is now taken so the admin cannot even retry.
 *
 * prisma.$transaction makes both land or neither. There is no half state.
 *
 * Note the role is hardcoded to CLIENT here, not taken from an argument.
 * Nothing reachable from an HTTP request can create an ADMIN.
 */
export async function createClientWithUser(
  input: CreateClientWithUserInput
): Promise<CreatedClient> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        password: input.passwordHash,
        role: 'CLIENT'
      },
      select: { id: true, email: true }
    })

    const client = await tx.client.create({
      data: {
        userId: user.id,
        name: input.name,
        email: input.email,
        phone: input.phone ?? null,
        address: input.address ?? null
      },
      select: { id: true, name: true }
    })

    return {
      userId: user.id,
      clientId: client.id,
      email: user.email,
      name: client.name
    }
  })
}

/** The fields every client endpoint returns. One definition, so no endpoint
 *  accidentally leaks a column added to the model later. */
const clientSelect = {
  id: true,
  userId: true,
  name: true,
  email: true,
  phone: true,
  address: true,
  createdAt: true
} as const

export type ClientRecord = {
  id: string
  userId: string
  name: string
  email: string
  phone: string | null
  address: string | null
  createdAt: Date
}

export async function findClientByUserId(userId: string): Promise<ClientRecord | null> {
  return prisma.client.findUnique({ where: { userId }, select: clientSelect })
}

export async function findClientById(id: string): Promise<ClientRecord | null> {
  return prisma.client.findUnique({ where: { id }, select: clientSelect })
}

export type ListClientsResult = {
  clients: ClientRecord[]
  total: number
}

/**
 * Lists clients, newest first.
 *
 * The count runs in the same transaction as the page, so `total` cannot
 * describe a different set of rows than the one returned — without that,
 * a client created between the two queries makes the pagination inconsistent.
 */
export async function listClients(
  limit: number,
  offset: number
): Promise<ListClientsResult> {
  const [clients, total] = await prisma.$transaction([
    prisma.client.findMany({
      select: clientSelect,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset
    }),
    prisma.client.count()
  ])

  return { clients, total }
}

export type UpdateClientData = {
  name?: string | undefined
  phone?: string | null | undefined
  address?: string | null | undefined
}

export async function updateClient(
  id: string,
  data: UpdateClientData
): Promise<ClientRecord> {
  return prisma.client.update({
    where: { id },
    // Only the three fields we allow. Passing the request body straight
    // through would be mass assignment — a caller adding "userId" would
    // repoint the client at somebody else's login account.
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.phone !== undefined ? { phone: data.phone } : {}),
      ...(data.address !== undefined ? { address: data.address } : {})
    },
    select: clientSelect
  })
}
