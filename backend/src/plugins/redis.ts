// plugins/redis.ts — wires Redis into Fastify.
// Same pattern as the prisma plugin: fp() makes `app.redis` visible app-wide.

import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { redis } from '../lib/redis.ts'

async function redisPlugin(app: FastifyInstance) {
  // ioredis connects lazily (on the first command). We send a PING at startup
  // so we fail immediately if Redis is not running — better a clear error now
  // than a mysterious 500 during a login.
  await redis.ping()

  app.decorate('redis', redis)

  app.addHook('onClose', async () => {
    // quit() waits for in-flight commands before closing.
    // (disconnect() tears the connection down immediately — not what we want.)
    await redis.quit()
  })
}

export default fp(redisPlugin, { name: 'redis' })
