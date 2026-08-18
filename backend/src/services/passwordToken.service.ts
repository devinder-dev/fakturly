// passwordToken.service.ts — issuing and redeeming set-password links.
//
// The token itself is 32 random bytes, stored as SHA-256 exactly like a
// refresh token: match the hash to the entropy of the input, and the lookup
// must be deterministic.
//
// It is also the only thing standing between an email inbox and an account,
// which is why it is single-use, short-lived, and invalidates its siblings
// when redeemed.

import { createHash, randomBytes } from 'node:crypto'
import * as passwordTokenRepository from '../repositories/passwordToken.repository.ts'
import * as userRepository from '../repositories/user.repository.ts'
import * as refreshTokenRepository from '../repositories/refreshToken.repository.ts'
import { hashPassword, assertPasswordNotBreached } from './password.service.ts'
import { record, AuditAction, AuditResource } from './audit.service.ts'
import { env } from '../lib/env.ts'
import { UnauthenticatedError } from '../lib/errors.ts'
import type { PasswordTokenType } from '../generated/prisma/client.ts'
import type { RequestContext } from './auth.service.ts'

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export type IssuedToken = {
  /** The value that goes in the emailed link. Never stored. */
  token: string
  expiresAt: Date
}

function expiryFor(type: PasswordTokenType): Date {
  const ms =
    type === 'INVITE'
      ? env.INVITE_TOKEN_DAYS * 24 * 60 * 60 * 1000
      : env.RESET_TOKEN_HOURS * 60 * 60 * 1000

  return new Date(Date.now() + ms)
}

/**
 * Issues a token for a user.
 *
 * Any outstanding tokens are invalidated first. Issuing a second invite
 * without doing so would leave two working links, and revoking access would
 * then mean hunting down every one ever sent.
 */
export async function issuePasswordToken(
  userId: string,
  type: PasswordTokenType
): Promise<IssuedToken> {
  await passwordTokenRepository.invalidateAllForUser(userId)

  // 32 bytes = 256 bits. base64url so it survives being pasted into a URL.
  const token = randomBytes(32).toString('base64url')
  const expiresAt = expiryFor(type)

  await passwordTokenRepository.createPasswordToken({
    tokenHash: hashToken(token),
    userId,
    type,
    expiresAt
  })

  return { token, expiresAt }
}

/** Builds the link that goes in the email. */
export function buildSetPasswordUrl(token: string): string {
  return `${env.FRONTEND_URL}/set-password?token=${encodeURIComponent(token)}`
}

/**
 * Redeems a token and sets the password.
 *
 * Every failure — unknown token, expired, already used — raises the SAME
 * error. Distinguishing them would tell someone holding a stale link whether
 * it was ever valid, and whether the account exists.
 *
 * On success:
 *   1. the token is marked used, atomically
 *   2. the password is replaced
 *   3. every other outstanding token is invalidated
 *   4. every existing session is revoked
 *
 * Step 4 is the one people miss. If the password was changed because it may
 * have been compromised, leaving the attacker's sessions alive defeats the
 * entire point of changing it.
 */
export async function redeemPasswordToken(
  rawToken: string,
  newPassword: string,
  context: RequestContext = {}
): Promise<void> {
  const stored = await passwordTokenRepository.findByTokenHash(hashToken(rawToken))

  if (!stored) {
    throw new UnauthenticatedError('Länken är ogiltig eller har gått ut')
  }

  if (stored.usedAt !== null || stored.expiresAt.getTime() <= Date.now()) {
    throw new UnauthenticatedError('Länken är ogiltig eller har gått ut')
  }

  // Check the password BEFORE spending the token. Otherwise a rejected
  // password — too short, or found in a breach — would burn the only link the
  // user has, and they would need a new invite to try again.
  await assertPasswordNotBreached(newPassword)

  // Spend it. The usedAt condition lives in the WHERE clause, so two
  // simultaneous submissions cannot both succeed.
  const claimed = await passwordTokenRepository.markUsed(stored.id)
  if (!claimed) {
    throw new UnauthenticatedError('Länken är ogiltig eller har gått ut')
  }

  await userRepository.updatePasswordHash(stored.userId, await hashPassword(newPassword))

  // Any sibling tokens die with it.
  await passwordTokenRepository.invalidateAllForUser(stored.userId)

  // And so does every existing session.
  await refreshTokenRepository.revokeAllForUser(stored.userId)

  await record({
    action:
      stored.type === 'INVITE' ? AuditAction.PASSWORD_SET : AuditAction.PASSWORD_RESET,
    resource: AuditResource.USER,
    userId: stored.userId,
    resourceId: stored.userId,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })
}
