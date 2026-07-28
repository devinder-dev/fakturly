// plugins/prisma.ts — kopplar in Prisma i Fastify.
//
// Efter detta kan vi nå databasen var som helst i appen via `app.prisma`
// eller `request.server.prisma` — utan att importera prisma-klienten i
// varje fil. Det gör det enkelt att byta ut klienten i tester.
//
// VIKTIGT — fastify-plugin (fp):
// Fastify kapslar in (encapsulation) allt en plugin gör. Utan fp skulle
// `app.decorate('prisma', ...)` bara synas INUTI den här pluginen, och
// våra rutter skulle krascha med "prisma is not defined".
// fp() säger: "den här dekorationen ska gälla hela appen".

import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.ts'

async function prismaPlugin(app: FastifyInstance) {
  // Anslut direkt vid uppstart istället för att låta första requesten
  // betala kostnaden. Failar databasen är det bättre att veta nu.
  await prisma.$connect()

  // decorate lägger till en egenskap på app-objektet.
  app.decorate('prisma', prisma)

  // Graceful shutdown: när Fastify stängs (Ctrl+C, docker stop) stänger vi
  // anslutningarna snyggt istället för att lämna dem hängande i Postgres.
  app.addHook('onClose', async () => {
    await prisma.$disconnect()
  })
}

export default fp(prismaPlugin, { name: 'prisma' })
