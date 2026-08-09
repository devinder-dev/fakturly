// plugins/rateLimit.ts — layer 1: limiting per IP address.
//
// Why Redis and not memory?
//   - Memory resets on every deploy. An attacker capped at 5 attempts per
//     minute suddenly gets 5 fresh ones right after a restart.
//   - With three instances behind a load balancer, each instance keeps its
//     own counter — so 15 attempts per minute instead of 5.
// Redis gives ONE shared counter that survives restarts and scaling out.
//
// NOTE: this is only half the protection. Per-IP catches classic brute force
// (one account, many passwords) and password spraying from a single source,
// but misses distributed brute force where a botnet spreads attempts against
// one account across hundreds of IPs.
// Layer 2 (services/loginAttempts.service.ts) covers that.

import fp from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance } from 'fastify'
import { RateLimitError } from '../lib/errors.ts'

async function rateLimitPlugin(app: FastifyInstance) {
  await app.register(rateLimit, {
    // Redis-backed counter, reusing the app's existing connection.
    redis: app.redis,

    // Prefix so rate-limit keys cannot collide with the jti denylist or
    // BullMQ's keys in the same Redis instance.
    nameSpace: 'fakturly:rl:',

    // Generous global ceiling. Individual auth routes set far stricter
    // limits themselves through their route config.
    global: true,
    max: 100,
    timeWindow: '1 minute',

    // The key is the client IP. request.ip only respects X-Forwarded-For
    // when trustProxy is on — which we enable in production. Without it,
    // everyone behind a proxy would share ONE counter and lock each other out.
    keyGenerator: (request) => request.ip,

    // NOTE: the plugin THROWS whatever errorResponseBuilder returns. Return a
    // plain object and it has no statusCode, so our central error handler
    // treats it as an unknown bug -> 500 instead of 429.
    //
    // Returning a real RateLimitError sends it down exactly the same path as
    // every other domain error: right status, our error shape, requestId and
    // the Retry-After header — all defined in one place.
    errorResponseBuilder: (_request, context) => {
      throw new RateLimitError(Math.ceil(context.ttl / 1000))
    },

    // Report how many attempts remain even BEFORE the limit is hit, so a
    // well-behaved client can slow itself down.
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true
    }
  })
}

export default fp(rateLimitPlugin, { name: 'rateLimit', dependencies: ['redis'] })

// ─────────────────────────────────────────────────────────────
// Ready-made configs to attach to individual routes.
//
// Used like this:
//   app.post('/auth/login', { config: { rateLimit: LOGIN_RATE_LIMIT } }, handler)
//
// Caveat worth knowing: this is a FIXED window, not a sliding one. The
// counter is a single number with a TTL, so a client can spend its full
// quota just before the reset and again just after — up to 2x the limit
// across that boundary. Acceptable here because the per-account limiter and
// the progressive delay still apply to every individual attempt.
// ─────────────────────────────────────────────────────────────

/** Login: 5 attempts per minute per IP. */
export const LOGIN_RATE_LIMIT = {
  max: 5,
  timeWindow: '1 minute'
} as const

/**
 * Token refresh: more generous. A legitimate client with several tabs open
 * refreshes more often than you would expect, and a refresh token is already
 * protected by rotation and theft detection.
 */
export const REFRESH_RATE_LIMIT = {
  max: 20,
  timeWindow: '1 minute'
} as const

/**
 * Setting a password: expensive for us (Argon2id + an HIBP call), so the
 * ceiling is low.
 */
export const SET_PASSWORD_RATE_LIMIT = {
  max: 5,
  timeWindow: '15 minutes'
} as const
