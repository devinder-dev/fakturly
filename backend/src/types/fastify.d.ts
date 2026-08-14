// types/fastify.d.ts — tells TypeScript what we decorated Fastify with.
//
// app.decorate('prisma', ...) happens at runtime. TypeScript knows nothing
// about it — without this file we get the error
// "Property 'prisma' does not exist on type 'FastifyInstance'".
//
// "declare module" = declaration merging: we ADD fields to Fastify's own
// interface instead of replacing it.

import type { PrismaClient } from '../generated/prisma/client.ts'
import type { Redis } from 'ioredis'
import type { AuthenticatedUser } from './auth.ts'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
    redis: Redis
  }

  interface FastifyRequest {
    /**
     * Set by the authenticate middleware. OPTIONAL on purpose.
     *
     * Most routes are public, so this is genuinely absent much of the time.
     * Typing it as always-present would let a handler read `request.authUser.id`
     * on an unauthenticated route and get a runtime crash that the compiler
     * had promised could not happen.
     *
     * The `?` forces every reader to handle the missing case — which is what
     * makes forgetting to attach authenticate a compile error instead of a
     * 500 in production.
     */
    authUser?: AuthenticatedUser
  }
}
