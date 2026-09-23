// prisma.config.ts — konfiguration för Prisma CLI (migrationer m.m.).
// Prisma 7: databas-URL:en bor här (inte i schema.prisma).
// env() läser från miljövariabler; Bun laddar backend/.env automatiskt.

import 'dotenv/config' // laddar backend/.env så env('DATABASE_URL') funkar i CLI
import { defineConfig, env } from 'prisma/config'
import { migrationUrl } from './src/lib/databaseTls.ts'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations'
  },
  datasource: {
    // The CLI does not use the app's pg pool, so TLS verification for
    // `migrate deploy` has to travel in the URL — see src/lib/databaseTls.ts
    // for which parameters actually verify and which only look like they do.
    // process.env, not env.ts: env.ts demands production secrets that the
    // Docker build stage (prisma generate) does not have.
    url: migrationUrl(env('DATABASE_URL'), process.env.DATABASE_CA_CERT || undefined)
  }
})
