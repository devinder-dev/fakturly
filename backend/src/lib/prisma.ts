// prisma.ts — creates ONE PrismaClient for the whole process (a singleton).
//
// Why only one? A PrismaClient owns a connection pool — a set of ready TCP
// connections to Postgres. Creating a new client per request would open
// thousands of connections and take the database down.
// One client, shared by all requests, reusing the pool.
//
// Prisma 7 detail: the old Rust engine is gone. WE now supply the database
// driver (the `pg` package) and Prisma wraps it in a "driver adapter".
// That is why `pg` and `@prisma/adapter-pg` are in package.json.

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.ts'
import { env, isProduction, isTest } from './env.ts'

// The adapter owns the actual Postgres connection pool (pg.Pool).
//
// Timeouts, because pg's defaults are "wait forever". On 2026-09-23 Neon
// paused the database (free quota used up) and every request that touched
// it hung until the client gave up — no error, no log line, just silence.
// With these, the same outage becomes a fast, logged error:
//   connectionTimeoutMillis  give up opening a connection after 5 s
//   statement_timeout        Postgres itself cancels a query after 15 s
//                            (our slowest real query, a report, is well
//                            under a second; 15 s only stops runaways)
//   idleTimeoutMillis        close unused connections after 10 s. This is
//                            pg's default, spelled out because it matters:
//                            Neon only sleeps (and stops billing compute)
//                            once no connection is open.
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
  idleTimeoutMillis: 10_000
})

export const prisma = new PrismaClient({
  adapter,
  // In development we want to see every SQL query — invaluable for
  // understanding what Prisma actually does and for spotting N+1 problems.
  // In production we log only real errors (queries would flood the log and
  // can leak sensitive values).
  // Tests run against a real database; logging every query would bury
  // the test output and hide the failure you are looking for.
  log: isProduction || isTest ? ['error'] : ['query', 'warn', 'error']
})
