// auth.service.ts — the login, refresh and logout flows.
//
// This is where everything built so far connects: the rate limiter, the
// password service, the token service and the repositories.
//
// Takes plain arguments (email, password, ip, userAgent) and returns plain
// data. It never sees `request` or `reply`, so it can be driven from a test
// or a script exactly like from an HTTP route.

import {
  assertAccountNotLocked,
  recordFailedAttempt,
  clearFailedAttempts,
  applyProgressiveDelay
} from './loginAttempts.service.ts'
import {
  verifyPasswordOrDummy,
  hashPassword,
  needsRehash
} from './password.service.ts'
import {
  createAccessToken,
  createRefreshToken,
  createTokenFamilyId,
  hashRefreshToken,
  revokeAccessToken,
  type AccessTokenClaims
} from './token.service.ts'
import * as userRepository from '../repositories/user.repository.ts'
import * as refreshTokenRepository from '../repositories/refreshToken.repository.ts'
import { record, AuditAction, AuditResource } from './audit.service.ts'
import { InvalidCredentialsError, UnauthenticatedError } from '../lib/errors.ts'
import type { Role } from '../generated/prisma/client.ts'

/** Context about the caller, used for the audit trail and token forensics. */
export type RequestContext = {
  ip?: string | undefined
  userAgent?: string | undefined
}

export type AuthResult = {
  accessToken: string
  /** Raw refresh token — the controller puts this in an httpOnly cookie. */
  refreshToken: string
  refreshTokenExpiresAt: Date
  user: { id: string; email: string; role: Role }
}

/**
 * Issues a fresh access + refresh pair and stores the refresh token's hash.
 *
 * familyId groups every token descended from one login. On login we start a
 * new family; on refresh we keep the existing one, so the whole chain can be
 * revoked together if theft is detected.
 */
async function issueTokenPair(
  user: { id: string; email: string; role: Role },
  familyId: string,
  context: RequestContext
): Promise<AuthResult> {
  const access = createAccessToken(user.id, user.role)
  const refresh = createRefreshToken()

  await refreshTokenRepository.createRefreshToken({
    tokenHash: refresh.tokenHash,
    userId: user.id,
    familyId,
    expiresAt: refresh.expiresAt,
    createdByIp: context.ip,
    userAgent: context.userAgent
  })

  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt,
    user: { id: user.id, email: user.email, role: user.role }
  }
}

// ─────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────

/**
 * Verifies credentials and issues a token pair.
 *
 * The order of operations here is deliberate and security-relevant:
 *
 *   1. Rate limit check FIRST — before touching the database, so a flood of
 *      guesses cannot be turned into a flood of queries.
 *   2. Look up the user, but do not branch on whether it exists yet.
 *   3. Verify the password — against a dummy hash if there is no user, so
 *      both paths cost the same ~10 ms and timing reveals nothing.
 *   4. On failure: count it, wait out the progressive delay, then throw the
 *      SAME generic error for every cause.
 */
export async function login(
  email: string,
  password: string,
  context: RequestContext = {}
): Promise<AuthResult> {
  // Throws RateLimitError (429) when this address has too many recent
  // failures. Counted for addresses that do not exist too, so a locked
  // response does not confirm the account is real.
  try {
    await assertAccountNotLocked(email)
  } catch (error) {
    // Log the block before rethrowing. Repeated entries here are the signal
    // that someone is actively grinding one account.
    await record({
      action: AuditAction.LOGIN_BLOCKED_RATE_LIMIT,
      resource: AuditResource.USER,
      email,
      ipAddress: context.ip,
      userAgent: context.userAgent
    })
    throw error
  }

  const user = await userRepository.findAuthUserByEmail(email)

  // No early return when the user is missing. verifyPasswordOrDummy runs a
  // full Argon2id verification against a throwaway hash instead, so the
  // response time is identical either way.
  const passwordMatches = await verifyPasswordOrDummy(user?.password, password)

  if (!user || !passwordMatches) {
    const attempts = await recordFailedAttempt(email)

    // Record the attempt. userId is null when the address does not exist —
    // and those rows are the whole point. A burst of LOGIN_FAILED entries
    // against addresses that were never registered is what credential
    // stuffing looks like, and the old required-userId schema made them
    // impossible to store at all.
    await record({
      action: AuditAction.LOGIN_FAILED,
      resource: AuditResource.USER,
      userId: user?.id ?? null,
      email,
      resourceId: user?.id ?? null,
      ipAddress: context.ip,
      userAgent: context.userAgent
    })

    // Wait BEFORE responding, so an attacker's tooling is actually slowed.
    await applyProgressiveDelay(attempts)
    throw new InvalidCredentialsError()
  }

  // Success — clear the counter so old failures cannot lock out a valid user.
  await clearFailedAttempts(email)

  // A successful login is the only moment we hold the plaintext password, so
  // it is the only moment we can upgrade a hash made with weaker parameters.
  if (needsRehash(user.password)) {
    const upgraded = await hashPassword(password)
    await userRepository.updatePasswordHash(user.id, upgraded)
    await record({
      action: AuditAction.PASSWORD_REHASHED,
      resource: AuditResource.USER,
      userId: user.id,
      resourceId: user.id,
      ipAddress: context.ip
    })
  }

  const result = await issueTokenPair(user, createTokenFamilyId(), context)

  await record({
    action: AuditAction.LOGIN_SUCCESS,
    resource: AuditResource.USER,
    userId: user.id,
    email: user.email,
    resourceId: user.id,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })

  return result
}

// ─────────────────────────────────────────────────────────────
// Refresh — rotation with theft detection
// ─────────────────────────────────────────────────────────────

export type RefreshOutcome = AuthResult & {
  /** True when a spent token was replayed and we killed the whole family. */
  theftDetected: false
}

/**
 * Exchanges a refresh token for a brand new pair.
 *
 * The theft detection is the interesting part. Every refresh SPENDS the token
 * it was given: the row is marked rotatedAt and a new token is issued in the
 * same family. A legitimate client therefore never presents a spent token —
 * it always holds the newest one.
 *
 * So if a spent token arrives, two copies of it exist. Someone stole one.
 * We cannot tell whether the thief or the victim is calling right now, so we
 * revoke the ENTIRE family: both are logged out, the attacker loses access
 * within minutes, and the user finds out something happened.
 *
 * Without rotation, a stolen refresh token would work silently for 30 days.
 */
export async function refresh(
  rawToken: string,
  context: RequestContext = {}
): Promise<AuthResult> {
  const stored = await refreshTokenRepository.findByTokenHash(hashRefreshToken(rawToken))

  // Unknown token. Either garbage, or a token from a family we already wiped.
  if (!stored) {
    throw new UnauthenticatedError()
  }

  // ── Theft detection ──────────────────────────────────────────
  // Nobody legitimately reuses a spent token.
  if (stored.rotatedAt !== null) {
    const revokedCount = await refreshTokenRepository.revokeFamily(stored.familyId)

    // The highest-severity event this system produces. Someone holds a copy
    // of a token they should not have. This row is what an alert watches for.
    await record({
      action: AuditAction.TOKEN_THEFT_DETECTED,
      resource: AuditResource.REFRESH_TOKEN,
      userId: stored.userId,
      resourceId: stored.familyId,
      ipAddress: context.ip,
      userAgent: context.userAgent
    })
    void revokedCount

    throw new UnauthenticatedError()
  }

  if (stored.revokedAt !== null) {
    throw new UnauthenticatedError()
  }

  if (stored.expiresAt.getTime() <= Date.now()) {
    throw new UnauthenticatedError()
  }

  const user = await userRepository.findAuthUserById(stored.userId)
  if (!user) {
    // The user was removed but a token survived. Clean up and refuse.
    await refreshTokenRepository.revokeFamily(stored.familyId)
    throw new UnauthenticatedError()
  }

  // Spend the old token, then issue the new pair in the SAME family so the
  // chain stays linked and revocable as a unit.
  await refreshTokenRepository.markRotated(stored.id)

  const result = await issueTokenPair(user, stored.familyId, context)

  await record({
    action: AuditAction.TOKEN_REFRESHED,
    resource: AuditResource.REFRESH_TOKEN,
    userId: user.id,
    resourceId: stored.familyId,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })

  return result
}

// ─────────────────────────────────────────────────────────────
// Logout
// ─────────────────────────────────────────────────────────────

/**
 * Ends a session properly — which means killing BOTH tokens.
 *
 * Revoking only the refresh token is the common mistake: the access token
 * stays valid for up to 15 more minutes, so "log out" does not actually log
 * you out. On a shared computer that is the whole problem.
 *
 * Deliberately forgiving: logging out with an already-invalid token still
 * succeeds. There is nothing to protect by failing, and an error would only
 * leave clients unsure whether they are logged out.
 */
export async function logout(
  rawRefreshToken: string | undefined,
  accessTokenClaims: AccessTokenClaims | undefined,
  context: RequestContext = {}
): Promise<void> {
  let userId: string | null = null
  let familyId: string | null = null

  if (rawRefreshToken) {
    const stored = await refreshTokenRepository.findByTokenHash(
      hashRefreshToken(rawRefreshToken)
    )
    // Revoke the whole family, not just this token: logging out on one device
    // should not leave a rotated sibling alive.
    if (stored) {
      await refreshTokenRepository.revokeFamily(stored.familyId)
      userId = stored.userId
      familyId = stored.familyId
    }
  }

  if (accessTokenClaims) {
    // TTL = the token's remaining lifetime, so the entry evicts itself
    // exactly when the token would have expired anyway.
    await revokeAccessToken(accessTokenClaims.jti, accessTokenClaims.exp)
    userId ??= accessTokenClaims.sub
  }

  // Only record a logout that actually ended something. A request with no
  // valid token still returns 204, but writing an audit row for it would let
  // anyone flood the log with meaningless entries.
  if (userId) {
    await record({
      action: AuditAction.LOGOUT,
      resource: AuditResource.USER,
      userId,
      resourceId: familyId,
      ipAddress: context.ip,
      userAgent: context.userAgent
    })
  }
}

/** Revokes every session for a user. Used after a password change. */
export async function logoutEverywhere(userId: string): Promise<number> {
  return refreshTokenRepository.revokeAllForUser(userId)
}
