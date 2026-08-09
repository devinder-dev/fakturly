// plugins/prisma.ts — wires Prisma into Fastify.
//
// After this we can reach the database anywhere in the app via `app.prisma`
// or `request.server.prisma` — without importing the client in every file.
// That also makes it easy to swap the client out in tests.
//
// IMPORTANT — fastify-plugin (fp):
// Fastify encapsulates everything a plugin does. Without fp,
// `app.decorate('prisma', ...)` would only be visible INSIDE this plugin and
// our routes would crash with "prisma is not defined".
// fp() says: "this decoration applies to the whole app".

import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.ts'

async function prismaPlugin(app: FastifyInstance) {
  // Connect at startup rather than making the first request pay the cost.
  // If the database is unreachable, better to find out now.
  await prisma.$connect()

  // decorate adds a property to the app object.
  app.decorate('prisma', prisma)

  // Graceful shutdown: when Fastify closes (Ctrl+C, docker stop) we close
  // connections cleanly instead of leaving them hanging in Postgres.
  app.addHook('onClose', async () => {
    await prisma.$disconnect()
  })
}

export default fp(prismaPlugin, { name: 'prisma' })
