// token.service.ts — creates and verifies both kinds of token.
//
// Two tokens, two completely different designs:
//
//   Access token  — a JWT. Self-describing, verified by signature alone, so
//                   no database round trip on every request. 15 minutes.
//   Refresh token — 32 random bytes. Carries no meaning at all; it is a
//                   lookup key into the RefreshToken table. 30 days.
//
// We use fast-jwt directly rather than @fastify/jwt so this file stays
// framework-free: no `app`, no `request`. A seed script or a BullMQ worker
// can call it exactly like an HTTP route can.

import { createSigner, createVerifier } from 'fast-jwt'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { env } from '../lib/env.ts'
import { redis } from '../lib/redis.ts'
import { UnauthenticatedError } from '../lib/errors.ts'
import type { Role } from '../generated/prisma/client.ts'

// iss/aud pin the token to THIS service. If we later run a second API sharing
// the same secret, a token minted for one cannot be replayed against the
// other — the verifier rejects a mismatched audience.
const ISSUER = 'fakturly'
const AUDIENCE = 'fakturly-api'

const ACCESS_TOKEN_MS = env.ACCESS_TOKEN_MINUTES * 60 * 1000
const REFRESH_TOKEN_MS = env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000

/**
 * What we put in an access token — and, just as importantly, what we do NOT.
 *
 * A JWT is base64, not encryption. Anyone holding it can read every claim.
 * So: no email, no name, no invoice data. Only an opaque user id, the role and
 * — for staff — the organization id we need for authorisation.
 */
export type AccessTokenClaims = {
  /** Subject — the user id. */
  sub: string
  role: Role
  /**
   * The staff member's organization id: an opaque cuid, not PII. Carried in
   * the token so scoping a query to the caller's tenant costs no database
   * lookup. Present on every ADMIN token and on no CLIENT token — a customer
   * login belongs to no organization (ADR 56). verifyAccessToken enforces
   * both halves.
   */
  org?: string
  /** JWT ID — unique per token. This is what logout adds to the denylist. */
  jti: string
  iat: number
  exp: number
  iss: string
  aud: string
}

// HS256 is symmetric: the same secret signs and verifies. That is correct here
// because only this service does both. The moment a SECOND service needs to
// verify our tokens without being able to mint them, we would switch to RS256
// or EdDSA and hand out only the public key.
const signAccessToken = createSigner({
  key: env.JWT_SECRET,
  algorithm: 'HS256',
  expiresIn: ACCESS_TOKEN_MS,
  iss: ISSUER,
  aud: AUDIENCE
})

const verifyAccessTokenSignature = createVerifier({
  key: env.JWT_SECRET,
  // Pinning the algorithm list is a real security control, not ceremony.
  // A verifier that accepts whatever the token's own header claims can be
  // fed alg:"none" — an unsigned token that verifies fine. Classic JWT bug.
  algorithms: ['HS256'],
  allowedIss: ISSUER,
  allowedAud: AUDIENCE,
  // iss and aud are listed because allowedIss/allowedAud only check a claim
  // that is PRESENT: fast-jwt skips the validator when the claim is missing,
  // so a token with no `aud` at all would pass the audience pin. `org` is not
  // here: whether it must be present depends on the role, which a static
  // list cannot express. verifyAccessToken checks it.
  requiredClaims: ['sub', 'jti', 'exp', 'role', 'iss', 'aud']
})

// ─────────────────────────────────────────────────────────────
// Access tokens
// ─────────────────────────────────────────────────────────────

export type CreatedAccessToken = {
  token: string
  jti: string
  expiresAt: Date
}

/**
 * organizationId is the staff member's organization, and must be null for a
 * customer login. Passing the wrong combination is a bug in the caller, not
 * a token to mint: refused here rather than discovered at the next request.
 */
export function createAccessToken(
  userId: string,
  role: Role,
  organizationId: string | null
): CreatedAccessToken {
  if ((role === 'ADMIN') !== (organizationId !== null)) {
    throw new Error(`createAccessToken: a ${role} token ${organizationId ? 'must not' : 'must'} carry an organization`)
  }

  const jti = randomUUID()
  const token = signAccessToken({
    sub: userId,
    role,
    ...(organizationId !== null ? { org: organizationId } : {}),
    jti
  })

  return {
    token,
    jti,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_MS)
  }
}

/**
 * Verifies signature, expiry, issuer and audience.
 *
 * Throws UnauthenticatedError for every failure mode — expired, tampered,
 * wrong audience, malformed. The caller must not learn WHICH check failed;
 * "your signature is invalid" versus "your token expired" is free
 * reconnaissance for someone probing the API.
 *
 * NOTE: this does not check the denylist. That is a separate concern and
 * lives in isAccessTokenRevoked, because verification is pure and the
 * denylist needs Redis.
 */
export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const claims = verifyAccessTokenSignature(token) as AccessTokenClaims

    // The org rule, by role. An ADMIN token without a usable org would leave
    // a caller with NO tenant — every scoped query would filter on nothing.
    // (requiredClaims could only prove presence: `null` or "" would pass.)
    // A token minted before multi-tenancy has none, so it is refused: one
    // 401, the frontend refreshes, and the refresh reads the org from the
    // database. A CLIENT token WITH an org is refused just as firmly: it
    // describes a customer bound to one seller, which no longer exists.
    if (claims.role === 'ADMIN') {
      if (typeof claims.org !== 'string' || claims.org === '') {
        throw new UnauthenticatedError()
      }
    } else if (claims.role === 'CLIENT') {
      if ('org' in claims) throw new UnauthenticatedError()
    } else {
      throw new UnauthenticatedError()
    }
    return claims
  } catch {
    throw new UnauthenticatedError()
  }
}

// ─────────────────────────────────────────────────────────────
// The access-token denylist (logout)
// ─────────────────────────────────────────────────────────────
//
// A plain JWT cannot be revoked — that is the trade for not hitting the
// database on every request. Logout would be a lie: the token stays valid
// until it expires.
//
// So logout writes the token's jti to Redis, and authenticate checks it.
//
// The elegant part is the TTL. We set it to exactly the token's remaining
// lifetime, so the entry evicts itself at the moment the token would have
// expired anyway. The denylist can never grow unbounded, and there is no
// cleanup job to write, schedule or forget.

function denylistKey(jti: string): string {
  return `fakturly:denylist:${jti}`
}

export async function revokeAccessToken(jti: string, expiresAtEpoch: number): Promise<void> {
  const secondsLeft = expiresAtEpoch - Math.floor(Date.now() / 1000)

  // Already expired? Then it is unusable anyway and needs no entry.
  if (secondsLeft <= 0) return

  await redis.set(denylistKey(jti), '1', 'EX', secondsLeft)
}

export async function isAccessTokenRevoked(jti: string): Promise<boolean> {
  return (await redis.exists(denylistKey(jti))) === 1
}

// ─────────────────────────────────────────────────────────────
// Refresh tokens
// ─────────────────────────────────────────────────────────────

export type CreatedRefreshToken = {
  /** The value sent to the client. We never store this. */
  token: string
  /** SHA-256 of the token. This is what goes in the database. */
  tokenHash: string
  expiresAt: Date
}

/**
 * Hashes a refresh token for storage and lookup.
 *
 * SHA-256, not Argon2id — deliberately. Match the hash to the entropy of the
 * input: a refresh token is 256 bits from a CSPRNG, so there is nothing to
 * guess and a slow hash buys exactly zero security while making every refresh
 * expensive. A password is human-chosen and guessable; there, slowness is the
 * entire defence.
 *
 * Also: this must be deterministic, because we look tokens up by hash.
 * Argon2id salts randomly and could not be used as a lookup key at all.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createRefreshToken(): CreatedRefreshToken {
  // 32 bytes = 256 bits of entropy. Brute-forcing this is not a threat model,
  // it is a physics problem.
  const token = randomBytes(32).toString('base64url')

  return {
    token,
    tokenHash: hashRefreshToken(token),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_MS)
  }
}

/**
 * A new token family — one per login.
 *
 * Every refresh token descended from the same login shares this id. When we
 * detect that a spent token was replayed, we revoke by familyId and the whole
 * chain dies at once, whichever link the attacker happened to hold.
 */
export function createTokenFamilyId(): string {
  return randomUUID()
}

export const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_MS
