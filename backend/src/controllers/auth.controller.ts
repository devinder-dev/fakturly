// auth.controller.ts — translates HTTP into service calls and back.
//
// The controller's whole job: read the request, call the service, shape the
// response. No business rules, no database access. If you ever find an `if`
// here that decides whether a login should succeed, it belongs in the service.

import type { FastifyReply, FastifyRequest } from 'fastify'
import { loginSchema } from '../validators/auth.validator.ts'
import * as authService from '../services/auth.service.ts'
import { findAuthUserById } from '../repositories/user.repository.ts'
import { verifyAccessToken, type AccessTokenClaims } from '../services/token.service.ts'
import { isProduction, env } from '../lib/env.ts'
import { UnauthenticatedError } from '../lib/errors.ts'

/** Cookie name for the refresh token. */
const REFRESH_COOKIE = 'fakturly_refresh'

/**
 * Why the refresh token lives in an httpOnly cookie and the access token
 * does not:
 *
 *   httpOnly  — JavaScript cannot read it, so an XSS bug cannot steal the
 *               long-lived credential. This is the main reason.
 *   secure    — HTTPS only in production. In development we serve plain
 *               http://localhost, where a secure cookie would never be sent.
 *   sameSite  — 'strict' means the browser never attaches it to a request
 *               originating from another site, which removes CSRF against
 *               these endpoints entirely.
 *   path      — only sent to /auth/*. The cookie is not attached to invoice
 *               or client requests that have no use for it.
 *
 * The access token is returned in the response body instead, for the client
 * to hold in memory. It is short-lived, and keeping it out of cookies means
 * it is never sent automatically — so it cannot be used in a CSRF attack.
 *
 * NOTE for week 4: if the frontend ends up on a different domain from the
 * API, sameSite 'strict' will block the cookie and this must become
 * 'none' + secure, with CORS credentials configured.
 */
function refreshCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict' as const,
    path: '/auth',
    expires: expiresAt,
    maxAge: env.REFRESH_TOKEN_DAYS * 24 * 60 * 60
  }
}

/**
 * Reads and verifies the access token from the Authorization header.
 *
 * Returns undefined instead of throwing, because the only caller is logout,
 * which must succeed even when the token is already expired or malformed.
 * (Step 5 replaces this with proper authenticate middleware for routes that
 * genuinely require a valid token.)
 */
function readAccessTokenClaims(request: FastifyRequest): AccessTokenClaims | undefined {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) return undefined

  try {
    return verifyAccessToken(header.slice('Bearer '.length))
  } catch {
    return undefined
  }
}

function requestContext(request: FastifyRequest) {
  return {
    ip: request.ip,
    // Cap the length: a User-Agent is attacker-controlled and goes into the
    // database. No reason to store 8 KB of it.
    userAgent: request.headers['user-agent']?.slice(0, 500)
  }
}

// ─────────────────────────────────────────────────────────────

export async function login(request: FastifyRequest, reply: FastifyReply) {
  // Validate before anything else. A ZodError here becomes a 400 with field
  // details, handled centrally in plugins/errorHandler.ts.
  const { email, password } = loginSchema.parse(request.body)

  const result = await authService.login(email, password, requestContext(request))

  reply.setCookie(
    REFRESH_COOKIE,
    result.refreshToken,
    refreshCookieOptions(result.refreshTokenExpiresAt)
  )

  // The refresh token is deliberately NOT in the body — it only travels as an
  // httpOnly cookie, where page JavaScript can never reach it.
  return reply.code(200).send({
    accessToken: result.accessToken,
    user: result.user
  })
}

export async function refresh(request: FastifyRequest, reply: FastifyReply) {
  const rawToken = request.cookies[REFRESH_COOKIE]
  if (!rawToken) {
    throw new UnauthenticatedError()
  }

  const result = await authService.refresh(rawToken, requestContext(request))

  // Rotation means the old cookie value is now spent — overwrite it, or the
  // browser would keep sending a token that triggers theft detection.
  reply.setCookie(
    REFRESH_COOKIE,
    result.refreshToken,
    refreshCookieOptions(result.refreshTokenExpiresAt)
  )

  return reply.code(200).send({
    accessToken: result.accessToken,
    user: result.user
  })
}

/**
 * Returns the currently authenticated user.
 *
 * Note that this reads from the DATABASE rather than just echoing the token's
 * claims back. The token carries only an id and a role — no email, because a
 * JWT is base64 and readable by anyone holding it.
 *
 * Reading fresh also means a role changed five minutes ago is reflected now,
 * instead of being stale until the token expires.
 */
export async function me(request: FastifyRequest, reply: FastifyReply) {
  // authenticate has already run, so authUser is present. TypeScript cannot
  // know that from the route wiring, so we check — and if it is ever missing
  // that means the middleware was not attached, which must fail closed.
  const caller = request.authUser
  if (!caller) throw new UnauthenticatedError()

  const user = await findAuthUserById(caller.id)

  // The token is valid but the user is gone — deleted since it was issued.
  if (!user) throw new UnauthenticatedError()

  return reply.code(200).send({
    user: { id: user.id, email: user.email, role: user.role }
  })
}

export async function logout(request: FastifyRequest, reply: FastifyReply) {
  await authService.logout(
    request.cookies[REFRESH_COOKIE],
    readAccessTokenClaims(request),
    requestContext(request)
  )

  // clearCookie must use the same path, or the browser keeps the old cookie
  // and the user stays "logged in" from its point of view.
  reply.clearCookie(REFRESH_COOKIE, { path: '/auth' })

  // 204: it worked, there is nothing to say about it.
  return reply.code(204).send()
}
