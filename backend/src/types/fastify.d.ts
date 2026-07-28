// types/fastify.d.ts — berättar för TypeScript vad vi dekorerat Fastify med.
//
// app.decorate('prisma', ...) sker vid körning (runtime). TypeScript vet
// inget om det — utan den här filen får vi felet
// "Property 'prisma' does not exist on type 'FastifyInstance'".
//
// "declare module" = deklarationssammanslagning (declaration merging):
// vi lägger till fält i Fastifys egna interface istället för att ersätta dem.

import type { PrismaClient } from '../generated/prisma/client.ts'
import type { Redis } from 'ioredis'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
    redis: Redis
  }
}
