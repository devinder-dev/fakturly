// authorize.ts — decides WHAT the caller may do. Always runs after authenticate.
//
// The split matters:
//   authenticate -> "who are you?"   -> 401 if we cannot tell
//   authorize    -> "may you?"       -> 403 if you may not
//
// Returning the wrong one is a real bug, not pedantry: a client that gets 401
// should try refreshing its token. On 403, refreshing is pointless — it needs
// a different account. Mixing them sends clients into refresh loops.

import type { FastifyRequest } from 'fastify'
import { ForbiddenError, UnauthenticatedError } from '../lib/errors.ts'
import type { Role } from '../generated/prisma/client.ts'

/**
 * Builds an onRequest hook that only lets the listed roles through.
 *
 *   app.get('/clients', {
 *     onRequest: [authenticate, authorize('ADMIN')]
 *   }, handler)
 *
 * The array order is load-bearing: authorize reads what authenticate set, so
 * authenticate must come first.
 */
export function authorize(...allowedRoles: Role[]) {
  return async function authorizeHook(request: FastifyRequest): Promise<void> {
    const caller = request.authUser

    // No authUser means authorize was wired up without authenticate — a
    // programming mistake, not an attack.
    //
    // We fail CLOSED anyway. The tempting alternative is to throw a loud
    // internal error to surface the bug, but that turns a misconfigured route
    // into a 500 rather than a refusal. Denying access is always the safe
    // direction; the misconfiguration shows up as "nobody can log in", which
    // gets noticed immediately and harms nobody.
    if (!caller) {
      throw new UnauthenticatedError()
    }

    if (!allowedRoles.includes(caller.role)) {
      throw new ForbiddenError()
    }
  }
}

/**
 * NOTE — this only checks ROLES, and roles are not the whole story.
 *
 * `authorize('CLIENT')` says "any client may call this". It does NOT say
 * "this client may read THIS invoice". That second question is ownership, it
 * depends on the specific row being touched, and it belongs in the service
 * layer where the row is actually loaded:
 *
 *   const invoice = await invoiceRepository.findById(id)
 *   if (caller.role === 'CLIENT' && invoice.clientId !== caller.clientId) {
 *     throw new NotFoundError('Fakturan')   // not Forbidden — see below
 *   }
 *
 * Using 404 rather than 403 there is deliberate: 403 confirms the invoice
 * exists and belongs to somebody else, which lets an attacker map your
 * customer base by probing ids. 404 reveals nothing.
 *
 * Insecure Direct Object Reference — the bug where a valid login lets you
 * read someone else's data by changing a number in the URL — is consistently
 * near the top of the OWASP list, and no role check anywhere will catch it.
 */
