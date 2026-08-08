// app.ts — bygger Fastify-appen och returnerar den.
// Startar INTE servern (ingen .listen här). Det gör server.ts.
// Poängen: vi kan bygga appen i tester och använda app.inject()
// för att skicka fejk-requests utan att öppna en riktig port.

import Fastify, { type FastifyInstance } from 'fastify'
import { isProduction } from './lib/env.ts'
import errorHandlerPlugin from './plugins/errorHandler.ts'
import prismaPlugin from './plugins/prisma.ts'
import redisPlugin from './plugins/redis.ts'

// buildApp skapar en färsk app varje gång den anropas.
// I tester vill vi ha en ny, ren app per test — därför en funktion.
export function buildApp(): FastifyInstance {
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
  app.register(errorHandlerPlugin)

  // Sedan infrastruktur — rutter behöver databas och Redis.
  app.register(prismaPlugin)
  app.register(redisPlugin)

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
