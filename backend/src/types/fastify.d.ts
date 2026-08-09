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

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
    redis: Redis
  }
}
