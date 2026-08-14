// refreshToken.repository.ts — database queries for RefreshToken. Nothing else.

import { prisma } from '../lib/prisma.ts'

export type StoredRefreshToken = {
  id: string
  userId: string
  familyId: string
  expiresAt: Date
  rotatedAt: Date | null
  revokedAt: Date | null
}

export type CreateRefreshTokenInput = {
  tokenHash: string
  userId: string
  familyId: string
  expiresAt: Date
  createdByIp?: string | undefined
  userAgent?: string | undefined
}

export async function createRefreshToken(
  input: CreateRefreshTokenInput
): Promise<void> {
  await prisma.refreshToken.create({
    data: {
      tokenHash: input.tokenHash,
      userId: input.userId,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      createdByIp: input.createdByIp ?? null,
      userAgent: input.userAgent ?? null
    }
  })
}

/**
 * Looks a token up by its SHA-256 hash.
 *
 * We never store or query the raw token, so a database dump gives an attacker
 * nothing usable. tokenHash is @unique, which makes this an index lookup.
 */
export async function findByTokenHash(
  tokenHash: string
): Promise<StoredRefreshToken | null> {
  return prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      familyId: true,
      expiresAt: true,
      rotatedAt: true,
      revokedAt: true
    }
  })
}

/**
 * Marks a token as spent.
 *
 * We do NOT delete it. The row is the evidence: if this same token shows up
 * again later, rotatedAt being set is what proves it was stolen. Delete the
 * row and a replayed token would just look like an unknown token, which is
 * indistinguishable from a typo — and we would miss the theft entirely.
 */
export async function markRotated(id: string): Promise<void> {
  await prisma.refreshToken.update({
    where: { id },
    data: { rotatedAt: new Date() }
  })
}

/**
 * Revokes every token descended from one login.
 *
 * Called on logout, and on theft detection. Using familyId rather than a
 * single id means it does not matter which link in the chain the attacker
 * holds — the whole chain dies at once.
 *
 * updateMany, not delete: revoked rows stay for the audit trail.
 */
export async function revokeFamily(familyId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() }
  })
  return result.count
}

/** Revokes every session a user has. For "log out everywhere" and after a password change. */
export async function revokeAllForUser(userId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() }
  })
  return result.count
}
