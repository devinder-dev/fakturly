// user.repository.ts — database queries for User. Nothing else.
//
// No business rules here. This layer does not decide whether a login should
// succeed; it only fetches and writes rows. That keeps the rules in one place
// (the service) and makes them testable without a database.

import { prisma } from '../lib/prisma.ts'
import type { Role } from '../generated/prisma/client.ts'

/** The shape the auth flow needs. Deliberately narrow — see select below. */
export type AuthUser = {
  id: string
  email: string
  password: string
  role: Role
}

/**
 * Looks up a user by email for the login flow.
 *
 * `select` is explicit rather than returning the whole row. Two reasons:
 * we do not want to accidentally carry extra columns into a log line or a
 * response, and adding a sensitive column to the schema later must not
 * silently start leaking it through here.
 *
 * Email is stored lowercase (the Zod schema normalises it), so a plain
 * equality match is correct.
 */
export async function findAuthUserByEmail(email: string): Promise<AuthUser | null> {
  return prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, password: true, role: true }
  })
}

export async function findAuthUserById(id: string): Promise<AuthUser | null> {
  return prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, password: true, role: true }
  })
}

/**
 * Replaces a user's password hash.
 *
 * Used both when someone sets a new password and when we silently upgrade an
 * old hash to stronger Argon2id parameters after a successful login.
 */
export async function updatePasswordHash(
  userId: string,
  passwordHash: string
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { password: passwordHash }
  })
}
