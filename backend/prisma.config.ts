// prisma.config.ts — konfiguration för Prisma CLI (migrationer m.m.).
// Prisma 7: databas-URL:en bor här (inte i schema.prisma).
// env() läser från miljövariabler; Bun laddar backend/.env automatiskt.

import 'dotenv/config' // laddar backend/.env så env('DATABASE_URL') funkar i CLI
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations'
  },
  datasource: {
    url: env('DATABASE_URL')
  }
})
