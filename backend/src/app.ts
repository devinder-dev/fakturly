// app.ts — bygger Fastify-appen och returnerar den.
// Startar INTE servern (ingen .listen här). Det gör server.ts.
// Poängen: vi kan bygga appen i tester och använda app.inject()
// för att skicka fejk-requests utan att öppna en riktig port.

import Fastify, { type FastifyInstance } from 'fastify'

// buildApp skapar en färsk app varje gång den anropas.
// I tester vill vi ha en ny, ren app per test — därför en funktion.
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true
  })

  // Hälsokontroll (health check) — verifierar att appen lever.
  app.get('/health', async () => {
    return { status: 'ok', service: 'fakturly-backend' }
  })

  // Här registrerar vi senare rutter och plugins (prisma, redis, auth...).

  return app
}
