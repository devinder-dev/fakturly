// app.ts — builds the Fastify app and returns it.
// Does NOT start the server (no .listen here). server.ts does that.
// The point: tests can build the app and use app.inject() to send
// fake requests without ever opening a real port.

import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { isProduction, isTest } from './lib/env.ts'
import errorHandlerPlugin from './plugins/errorHandler.ts'
import prismaPlugin from './plugins/prisma.ts'
import rateLimitPlugin from './plugins/rateLimit.ts'
import redisPlugin from './plugins/redis.ts'
import authRoutes from './routes/auth.routes.ts'
import clientRoutes from './routes/clients.routes.ts'

// buildApp creates a fresh app every time it is called.
// Tests want a clean app each run — hence a function, not a module-level app.
//
// WHY ASYNC? app.register() does not load the plugin immediately — it queues
// it and runs it at app.ready(). Declaring a route on the line after an
// un-awaited register() creates that route BEFORE the plugin has added its
// onRoute hooks.
//
// This bit us for real: @fastify/rate-limit reads a route's config.rateLimit
// inside an onRoute hook. Without the await, /health and the auth routes were
// registered before that hook existed — and rate limiting became a silent
// no-op. No error, no warning, just no protection.
//
// With await, every plugin is fully loaded before the first route is declared.
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Production wants JSON logs (machine-readable, for log aggregators).
    // Development wants readable text — but pino-pretty is a dependency we
    // will add only when we actually need it, so the default logger stays.
    logger: {
      // 'silent' in tests: a request line per inject() would drown the
      // assertions. Behaviour is unchanged either way.
      level: isTest ? 'silent' : isProduction ? 'info' : 'debug',
      // NEVER log passwords or tokens, not even by accident.
      // redact replaces these fields with [Redacted] in every log line.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password'
        ],
        censor: '[Redacted]'
      }
    },

    // Fastify only trusts the X-Forwarded-For header if we opt in.
    // We need the real client IP for rate limiting and audit logs once the
    // app sits behind a proxy (Railway, Render, nginx).
    trustProxy: isProduction
  })

  // Error handler FIRST. Registered after the routes, Fastify would use its
  // own default handler for anything thrown before this point.
  await app.register(errorHandlerPlugin)

  // Then infrastructure — routes need the database and Redis.
  await app.register(prismaPlugin)
  await app.register(redisPlugin)

  // Rate limiting AFTER redis — it uses app.redis as its counter store.
  // dependencies: ['redis'] inside the plugin makes Fastify refuse to boot
  // if that order is ever reversed, instead of crashing on the first
  // request in production.
  await app.register(rateLimitPlugin)

  // Cookie parsing — the refresh token travels as an httpOnly cookie, so
  // this must be loaded before any route that reads request.cookies.
  await app.register(cookie)

  // ── Only from HERE may routes be declared ──────────────────────
  // Everything above is fully loaded, so every route below sees all hooks
  // (rate limiting, error handling) from its very first request.

  // Liveness check — is the process alive?
  app.get('/health', async () => {
    return { status: 'ok', service: 'fakturly-backend' }
  })

  // Readiness check — do the DEPENDENCIES actually respond?
  // The difference matters: /health says "the process is running",
  // /health/ready says "the app can actually do work".
  app.get('/health/ready', async (_request, reply) => {
    try {
      // SELECT 1 is the cheapest possible query — we are testing that the
      // connection works, not that any particular table exists.
      await app.prisma.$queryRaw`SELECT 1`
      await app.redis.ping()
      return { status: 'ready', database: 'up', redis: 'up' }
    } catch (err) {
      app.log.error(err, 'Readiness check failed')
      // 503 Service Unavailable — the right code when the app is alive but
      // cannot serve requests. Load balancers understand this one.
      return reply.code(503).send({ status: 'not_ready' })
    }
  })

  // Auth: login, refresh, logout, me.
  await app.register(authRoutes)

  // Client provisioning (admin only).
  await app.register(clientRoutes)

  // Invoices get registered here later.

  return app
}
