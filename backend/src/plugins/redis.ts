// plugins/redis.ts — kopplar in Redis i Fastify.
// Samma mönster som prisma-pluginen: fp() gör `app.redis` synlig överallt.

import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { redis } from '../lib/redis.ts'

async function redisPlugin(app: FastifyInstance) {
  // ioredis ansluter lazy (vid första kommandot). Vi kör en PING vid
  // uppstart för att misslyckas direkt om Redis inte är igång —
  // hellre ett tydligt fel nu än ett mystiskt 500-fel vid inloggning.
  await redis.ping()

  app.decorate('redis', redis)

  app.addHook('onClose', async () => {
    // quit() väntar in pågående kommandon innan den stänger.
    // (disconnect() river anslutningen direkt — det vill vi inte.)
    await redis.quit()
  })
}

export default fp(redisPlugin, { name: 'redis' })
