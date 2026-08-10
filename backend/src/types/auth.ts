// auth.ts — the shape of an authenticated caller.
//
// Lives in its own file because both the middleware (which sets it) and the
// Fastify type augmentation (which declares it) need it, and a .d.ts file is
// an awkward place to import a value type from.

import type { Role } from '../generated/prisma/client.ts'

/**
 * What we know about the caller after authenticate() has run.
 *
 * Deliberately minimal: an id and a role. No email, no name. Those come from
 * the access token, which is base64 and readable by anyone holding it, so it
 * carries no PII. A handler that needs more loads it from the database — and
 * that way a role changed five minutes ago is not stale for the rest of the
 * token's life.
 */
export type AuthenticatedUser = {
  id: string
  role: Role
  /** The token's unique id — needed if this request triggers a logout. */
  jti: string
  /** Unix seconds. Used to size the denylist TTL on logout. */
  expiresAtEpoch: number
}
