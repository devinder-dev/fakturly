// auth.ts — the shape of an authenticated caller.
//
// Lives in its own file because both the middleware (which sets it) and the
// Fastify type augmentation (which declares it) need it, and a .d.ts file is
// an awkward place to import a value type from.

import type { Role } from '../generated/prisma/client.ts'

/**
 * What we know about the caller after authenticate() has run.
 *
 * Deliberately minimal: an id, a role and an organization id. No email, no
 * name. Those come from the access token, which is base64 and readable by
 * anyone holding it, so it carries no PII. A handler that needs more loads it
 * from the database — and that way a role changed five minutes ago is not
 * stale for the rest of the token's life.
 */
export type AuthenticatedUser = {
  id: string
  role: Role
  /**
   * The tenant the caller belongs to. Comes from the verified token, never
   * from the request — so nothing a caller sends can move them into another
   * organization's data.
   */
  organizationId: string
  /** The token's unique id — needed if this request triggers a logout. */
  jti: string
  /** Unix seconds. Used to size the denylist TTL on logout. */
  expiresAtEpoch: number
}

/**
 * Who is performing a write, as services see it.
 *
 * One object rather than two loose string arguments: `(adminId, orgId)` and
 * `(orgId, adminId)` type-check identically, and swapping them would file a
 * row under the wrong tenant without a single compiler complaint.
 *
 * Plain data, no `request` — a BullMQ worker or a CLI script can build one
 * just as well as a route can.
 */
export type Actor = {
  userId: string
  organizationId: string
}

export function toActor(caller: AuthenticatedUser): Actor {
  return { userId: caller.id, organizationId: caller.organizationId }
}
