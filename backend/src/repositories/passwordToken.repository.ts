// passwordToken.repository.ts — one-time tokens for setting a password.

import { prisma } from '../lib/prisma.ts'
import type { PasswordTokenType } from '../generated/prisma/client.ts'

export type StoredPasswordToken = {
  id: string
  userId: string
  type: PasswordTokenType
  expiresAt: Date
  usedAt: Date | null
}

export async function createPasswordToken(data: {
  tokenHash: string
  userId: string
  type: PasswordTokenType
  expiresAt: Date
}): Promise<void> {
  await prisma.passwordToken.create({ data })
}

export async function findByTokenHash(
  tokenHash: string
): Promise<StoredPasswordToken | null> {
  return prisma.passwordToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, type: true, expiresAt: true, usedAt: true }
  })
}

/**
 * Marks a token as used, but only if it has not been used already.
 *
 * The `usedAt: null` condition is in the WHERE clause rather than checked
 * beforehand. Two requests arriving with the same token would both read
 * usedAt as null and both proceed; here, the second update matches no rows
 * and the caller finds out.
 *
 * Returns false when the token was already spent.
 */
export async function markUsed(id: string): Promise<boolean> {
  const result = await prisma.passwordToken.updateMany({
    where: { id, usedAt: null },
    data: { usedAt: new Date() }
  })
  return result.count > 0
}

/**
 * Invalidates every outstanding token for a user.
 *
 * Called after a password is set. Otherwise an older invite still sitting in
 * an inbox — or an attacker's copy of one — would remain usable against an
 * account whose password has since changed.
 */
export async function invalidateAllForUser(userId: string): Promise<number> {
  const result = await prisma.passwordToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() }
  })
  return result.count
}
