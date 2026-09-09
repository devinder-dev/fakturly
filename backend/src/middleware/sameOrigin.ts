// sameOrigin.ts — refuses cookie-carrying requests that come from another site.
//
// Only needed on the two endpoints the refresh cookie reaches: /auth/refresh
// and /auth/logout. With the cookie in SameSite=Strict mode the browser never
// sends it cross-site and this hook is redundant. In cross-site mode
// (frontend and API on different domains, CROSS_SITE_COOKIES=true) the cookie
// IS sent from anywhere, and while CORS stops another site from READING the
// response, it does not stop it from SENDING the request — so a hostile page
// could log a visitor out, or spin the rotation. Nuisance-level, but cheap
// to close: a browser always attaches Origin to a cross-site POST, and we
// only accept our own.
//
// Requests with NO Origin header pass. Those are not browsers on other
// sites — they are curl, tests, and same-origin form posts, none of which
// are what this guards against.

import type { FastifyRequest } from 'fastify'
import { env } from '../lib/env.ts'
import { ForbiddenError } from '../lib/errors.ts'

export async function sameOrigin(request: FastifyRequest): Promise<void> {
  const origin = request.headers.origin
  if (origin === undefined) return
  if (origin !== env.FRONTEND_URL) {
    throw new ForbiddenError('Otillåten avsändare')
  }
}
