// auth.ts — the shape of an authenticated caller.
//
// Lives in its own file because both the middleware (which sets it) and the
// Fastify type augmentation (which declares it) need it, and a .d.ts file is
// an awkward place to import a value type from.

import { ForbiddenError } from '../lib/errors.ts'

type CallerBase = {
  id: string
  /** The token's unique id — needed if this request triggers a logout. */
  jti: string
  /** Unix seconds. Used to size the denylist TTL on logout. */
  expiresAtEpoch: number
}

/**
 * What we know about the caller after authenticate() has run.
 *
 * Deliberately minimal: ids and a role. No email, no name. Those come from
 * the access token, which is base64 and readable by anyone holding it, so it
 * carries no PII. A handler that needs more loads it from the database — and
 * that way a role changed five minutes ago is not stale for the rest of the
 * token's life.
 *
 * A union, not one shape with an optional field, because the two roles
 * relate to organizations differently (ADR 56):
 *
 *   ADMIN  — staff of exactly one organization. Every query they make is
 *            scoped to it. The id comes from the verified token, never from
 *            the request, so nothing a caller sends can choose it.
 *   CLIENT — a customer login, which belongs to NO organization. It reaches
 *            each seller through its own Client rows, and is scoped by its
 *            user id instead.
 *
 * Checking `role` narrows the type: after `caller.role === 'ADMIN'`, the
 * compiler knows organizationId is a string.
 */
export type AuthenticatedUser =
  | (CallerBase & { role: 'ADMIN'; organizationId: string })
  | (CallerBase & { role: 'CLIENT'; organizationId: null })

/**
 * Who is performing an admin write, as services see it.
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

/**
 * The actor for an admin route.
 *
 * Every route that calls this is already behind authorize('ADMIN'). The
 * check is the second lock, not the first: if a route were ever wired
 * without authorize, a customer must still never reach an admin write —
 * and without an organization there is nothing to scope it to anyway.
 */
export function toActor(caller: AuthenticatedUser): Actor {
  if (caller.role !== 'ADMIN') {
    throw new ForbiddenError()
  }
  return { userId: caller.id, organizationId: caller.organizationId }
}
