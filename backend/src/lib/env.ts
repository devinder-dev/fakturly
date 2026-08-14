// env.ts — validates environment variables ONCE at startup (fail fast).
//
// Why? Without this the app boots happily with a missing JWT_SECRET and
// crashes only when someone tries to log in — possibly in production, at
// 2am. With it, the process refuses to start at all. A crash at startup is
// a good crash: it happens in front of whoever just deployed.
//
// After this file we NEVER read process.env directly anywhere else. We
// import `env` instead — then the values are both validated and typed.

import 'dotenv/config' // loads backend/.env into process.env
import { z } from 'zod'

const envSchema = z.object({
  // Database and cache — required, the app cannot do anything without them
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  // Auth — at least 32 characters. A short secret can be guessed or brute-forced.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET måste vara minst 32 tecken'),

  // Access token lifetime. Short on purpose: a stolen access token cannot be
  // revoked instantly (we check a denylist, but only on our own routes), so
  // its own expiry is the real backstop.
  ACCESS_TOKEN_MINUTES: z.coerce.number().int().positive().default(15),

  // Refresh token lifetime — how long a user stays logged in without
  // re-entering a password. Safe to be long because every use rotates it and
  // reuse of a spent token revokes the whole family.
  REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(30),

  // App. coerce: "3000" arrives as a string, we want a number.
  PORT: z.coerce.number().int().positive().default(3000),
  FRONTEND_URL: z.url().default('http://localhost:5173'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Week 3 — allowed to be empty for now. .optional() means the key need not
  // exist, and an empty string ("") is accepted because we do not require .min(1).
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional()
})

// safeParse does not throw — it returns a result we can act on, so we can
// print a readable message instead of a stack trace.
const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Ogiltiga miljövariabler i backend/.env:\n')
  console.error(z.prettifyError(parsed.error))
  console.error('\nJämför med backend/.env.example och fyll i det som saknas.')
  process.exit(1) // a non-zero exit code means "failed" to Docker and CI
}

// parsed.data is now fully typed: env.PORT is a number, env.NODE_ENV a union.
export const env = parsed.data

// Convenience helpers — used for Secure cookies and log levels.
export const isProduction = env.NODE_ENV === 'production'

/**
 * True when running under the test runner.
 *
 * Used only to silence logging. Tests run against a real database, and every
 * Prisma query plus every Fastify request line would bury the actual test
 * output — which makes a genuine failure hard to find, and a noisy suite is
 * a suite people stop reading.
 *
 * Nothing about behaviour changes in test mode. A test that only passes
 * because it is a test is worthless.
 */
export const isTest = env.NODE_ENV === 'test' || process.env.BUN_TEST === '1'
