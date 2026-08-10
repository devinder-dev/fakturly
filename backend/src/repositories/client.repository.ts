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

export async function findClientByUserId(userId: string) {
  return prisma.client.findUnique({
    where: { userId },
    select: { id: true, name: true, email: true, phone: true, address: true }
  })
}
