// app.ts — bygger Fastify-appen och returnerar den.
// Startar INTE servern (ingen .listen här). Det gör server.ts.
// Poängen: vi kan bygga appen i tester och använda app.inject()
// för att skicka fejk-requests utan att öppna en riktig port.

import Fastify, { type FastifyInstance } from 'fastify'
import { isProduction } from './lib/env.ts'
import errorHandlerPlugin from './plugins/errorHandler.ts'
import prismaPlugin from './plugins/prisma.ts'
import rateLimitPlugin from './plugins/rateLimit.ts'
import redisPlugin from './plugins/redis.ts'

// buildApp skapar en färsk app varje gång den anropas.
// I tester vill vi ha en ny, ren app per test — därför en funktion.
//
// VARFÖR ASYNC? app.register() laddar inte plugin-et direkt — den lägger
// det i kö och kör det först vid app.ready(). Deklarerar vi en route på
// raden efter en oväntad register() hinner routen skapas INNAN plugin-et
// har hunnit lägga till sina onRoute-hookar.
//
// Det bet oss på riktigt: @fastify/rate-limit läser route-ens
// config.rateLimit i en onRoute-hook. Utan await registrerades /health och
// auth-rutterna före hooken fanns — och rate limiting blev en tyst
// no-op. Inget fel, ingen varning, bara inget skydd.
//
// Med await är plugin-et färdigladdat innan första routen deklareras.
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // I produktion vill vi ha JSON-loggar (maskinläsbara, för loggverktyg).
    // I utveckling vill vi ha läsbar text — men pino-pretty installerar vi
    // först när vi behöver det, så vi håller oss till standardloggern nu.
    logger: {
      level: isProduction ? 'info' : 'debug',
      // Logga ALDRIG lösenord eller tokens — även av misstag.
      // redact ersätter dessa fält med [Redacted] i alla loggrader.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password'
        ],
        censor: '[Redacted]'
      }
    },

    // Fastify litar på X-Forwarded-For-headern bara om vi säger till.
    // Vi behöver riktig klient-IP för rate limiting och audit-loggar
    // när appen står bakom en proxy (Railway, Render, nginx).
    trustProxy: isProduction
  })

  // Felhanteraren FÖRST. Registreras den efter rutterna hinner Fastify
  // använda sin egen standardhanterare för allt som kastas innan dess.
  await app.register(errorHandlerPlugin)

  // Sedan infrastruktur — rutter behöver databas och Redis.
  await app.register(prismaPlugin)
  await app.register(redisPlugin)

  // Rate limiting EFTER redis — den använder app.redis som sin räknare.
  // dependencies: ['redis'] i plugin-et gör att Fastify vägrar starta
  // om ordningen någonsin kastas om, istället för att krascha vid första
  // requesten i produktion.
  await app.register(rateLimitPlugin)

  // ── Först HÄR får rutter deklareras ────────────────────────────
  // Allt ovanför är färdigladdat, så varje route nedan ser samtliga
  // hookar (rate limit, felhantering) från första sekunden.

  // Hälsokontroll (health check) — verifierar att appen lever.
  app.get('/health', async () => {
    return { status: 'ok', service: 'fakturly-backend' }
  })

  // Djup hälsokontroll — verifierar att BEROENDENA faktiskt svarar.
  // Skillnaden spelar roll: /health säger "processen lever",
  // /health/ready säger "appen kan faktiskt utföra arbete".
  app.get('/health/ready', async (_request, reply) => {
    try {
      // SELECT 1 är den billigaste möjliga frågan — vi testar bara
      // att anslutningen fungerar, inte att någon tabell finns.
      await app.prisma.$queryRaw`SELECT 1`
      await app.redis.ping()
      return { status: 'ready', database: 'up', redis: 'up' }
    } catch (err) {
      app.log.error(err, 'Hälsokontroll misslyckades')
      // 503 Service Unavailable — rätt kod när appen lever men
      // inte kan betjäna requests. Load balancers förstår denna.
      return reply.code(503).send({ status: 'not_ready' })
    }
  })

  // Här registrerar vi senare auth-rutter, fakturor, klienter...

  return app
}
