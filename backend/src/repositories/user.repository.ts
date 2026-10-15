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
  /** Read on every login AND every refresh — the token's `org` claim is
   *  always minted from this row, never copied from an older token. Null for
   *  a customer login, which belongs to no organization (ADR 56). */
  organization: { id: string; name: string } | null
}

const authUserSelect = {
  id: true,
  email: true,
  password: true,
  role: true,
  organization: { select: { id: true, name: true } }
} as const

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
  return prisma.user.findUnique({ where: { email }, select: authUserSelect })
}

export async function findAuthUserById(id: string): Promise<AuthUser | null> {
  return prisma.user.findUnique({ where: { id }, select: authUserSelect })
}

/**
 * The organization a user's actions are filed under in the audit log: the
 * staff member's own, or null for a customer login (and for an unknown id).
 */
export async function findOrganizationIdOfUser(id: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id }, select: { organizationId: true } })
  return user?.organizationId ?? null
}

/**
 * Stores a password the user CHOSE — redeeming an invite or a reset link —
 * and records when. The first such moment activates a provisioned login.
 */
export async function setChosenPassword(userId: string, passwordHash: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { password: passwordHash, passwordSetAt: new Date() }
  })
}

/**
 * Replaces a user's password hash, leaving passwordSetAt alone.
 *
 * For the silent upgrade of an old hash to stronger Argon2id parameters
 * after a successful login: the same password, a better hash — not a new
 * choice, so not an activation.
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
