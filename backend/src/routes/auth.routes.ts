// auth.routes.ts — declares the auth URLs and what runs before each handler.
//
// A route file states WHAT is exposed and WHICH protections apply. It never
// contains business logic — that is the controller's and service's job.

import type { FastifyInstance } from 'fastify'
import * as authController from '../controllers/auth.controller.ts'
import { authenticate } from '../middleware/authenticate.ts'
import { LOGIN_RATE_LIMIT, REFRESH_RATE_LIMIT } from '../plugins/rateLimit.ts'

export default async function authRoutes(app: FastifyInstance) {
  /**
   * POST /auth/login
   *
   * Rate limited to 5 per minute per IP. That is layer one; the per-account
   * limiter inside the service is layer two, and catches attacks spread
   * across many IP addresses that this one would never see.
   */
  app.post(
    '/auth/login',
    { config: { rateLimit: LOGIN_RATE_LIMIT } },
    authController.login
  )

  /**
   * POST /auth/refresh
   *
   * Takes no body — the refresh token arrives as an httpOnly cookie the
   * browser attaches automatically. Nothing for page JavaScript to read,
   * and nothing for a caller to get wrong.
   *
   * More generous limit than login: a legitimate client with several tabs
   * open refreshes more often than you would expect, and the token is
   * already protected by rotation and theft detection.
   */
  app.post(
    '/auth/refresh',
    { config: { rateLimit: REFRESH_RATE_LIMIT } },
    authController.refresh
  )

  /**
   * POST /auth/logout
   *
   * Deliberately not rate limited beyond the global ceiling. Making logout
   * hard to reach would be a strange thing to do: someone repeatedly trying
   * to end their session is not an attack, and failing to log them out is
   * worse than any load it could cause.
   */
  app.post('/auth/logout', authController.logout)

  /**
   * GET /auth/me — the first genuinely protected route.
   *
   * onRequest runs before Fastify parses a body, so an unauthenticated
   * request is refused at the earliest possible point.
   *
   * No authorize() here on purpose: every logged-in user may read their own
   * profile, regardless of role. Role gates go on routes where the role is
   * what decides, such as the admin-only client provisioning in step 7.
   */
  app.get('/auth/me', { onRequest: [authenticate] }, authController.me)
}
