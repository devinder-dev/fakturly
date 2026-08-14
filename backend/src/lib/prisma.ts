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

// The adapter owns the actual Postgres connection.
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })

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
