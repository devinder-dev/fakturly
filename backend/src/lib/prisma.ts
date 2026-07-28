// prisma.ts — skapar EN PrismaClient för hela processen (singleton).
//
// Varför bara en? En PrismaClient äger en connection pool — en samling
// färdiga TCP-anslutningar till Postgres. Att skapa en ny klient per request
// skulle öppna tusentals anslutningar och slå ut databasen.
// En klient, delad av alla requests, som återanvänder poolen.
//
// Prisma 7-detalj: den gamla Rust-motorn är borta. Numera levererar VI
// databasdrivrutinen (paketet `pg`) och Prisma lindar den i en "driver adapter".
// Det är därför `pg` och `@prisma/adapter-pg` finns i package.json.

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.ts'
import { env, isProduction } from './env.ts'

// Adaptern äger själva Postgres-anslutningen.
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })

export const prisma = new PrismaClient({
  adapter,
  // I utveckling vill vi se varje SQL-fråga som körs — ovärderligt för att
  // förstå vad Prisma faktiskt gör och för att upptäcka N+1-problem.
  // I produktion loggar vi bara riktiga fel (queries skulle spamma loggen
  // och kan dessutom läcka känsliga värden).
  log: isProduction ? ['error'] : ['query', 'warn', 'error']
})
