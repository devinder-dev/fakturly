// authenticate.ts — proves WHO is calling. Runs before protected handlers.
//
// Three things happen here, in order:
//   1. Is there a Bearer token at all?
//   2. Is its signature valid, unexpired, and issued by us for us?
//   3. Has it been revoked since it was issued?
//
// Step 3 is the one people skip. A JWT is valid until it expires by design —
// that is the trade for not hitting the database on every request. Without a
// denylist check, logout is a lie: the token keeps working for up to 15 more
// minutes. On a shared computer, that is the whole problem.
//
// Registered as an onRequest hook rather than preHandler, so an
// unauthenticated request is rejected BEFORE Fastify parses its body. No
// reason to deserialise a megabyte of JSON for someone who is not logged in.

import type { FastifyRequest } from 'fastify'
import { verifyAccessToken, isAccessTokenRevoked } from '../services/token.service.ts'
import { UnauthenticatedError } from '../lib/errors.ts'

export async function authenticate(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization

  // Every failure below throws the SAME error. "Malformed token" vs "expired
  // token" vs "revoked token" would tell someone probing the API exactly how
  // far they got, which is free reconnaissance.
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthenticatedError()
  }

  const token = header.slice('Bearer '.length).trim()
  if (!token) {
    throw new UnauthenticatedError()
  }

  // Verifies signature, expiry, issuer and audience. Throws
  // UnauthenticatedError on any problem.
  const claims = verifyAccessToken(token)

  // The denylist lookup — one Redis round trip, roughly 0.2 ms. That is the
  // price of revocable JWTs, and it is the right trade: the alternative is a
  // logout button that does not log you out.
  if (await isAccessTokenRevoked(claims.jti)) {
    throw new UnauthenticatedError()
  }

  // Attach the caller for handlers and for authorize() to read.
  //
  // Note what is here: an id and a role, nothing else. If a handler needs the
  // user's email it must load it from the database. The token is base64 and
  // readable by anyone holding it, so it carries no PII — and re-reading from
  // the database also means a role changed five minutes ago is not stale for
  // the remaining life of the token.
  request.authUser = {
    id: claims.sub,
    role: claims.role,
    jti: claims.jti,
    expiresAtEpoch: claims.exp
  }
}
