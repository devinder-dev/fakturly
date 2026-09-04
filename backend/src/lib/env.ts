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

  // Email. When RESEND_API_KEY is absent the mailer logs to the console
  // instead of sending — see lib/resend.ts. That keeps local development and
  // CI working without an account, and without silently pretending to send.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Fakturly <onboarding@resend.dev>'),

  /**
   * How long an invite link stays valid.
   *
   * Long, because the recipient was not expecting it: an admin adds a client
   * on Friday and they read email on Monday. Compare RESET below.
   */
  INVITE_TOKEN_DAYS: z.coerce.number().int().positive().default(7),

  /**
   * How long a password-reset link stays valid.
   *
   * Short, because the user requested it and is waiting for it. A reset link
   * sitting valid in an inbox for a week is a standing key to the account.
   */
  RESET_TOKEN_HOURS: z.coerce.number().int().positive().default(2),

  // ── Seller details, printed on every invoice PDF ─────────────
  //
  // Swedish law (mervärdesskattelagen 17 kap.) lists what an invoice must
  // state, and most of it is about the SELLER: name, address, organisation
  // number, VAT registration number. Configuration rather than constants,
  // because the same code serves the demo company and a real one.
  //
  // The defaults are a fictional company so the demo and local development
  // produce a complete, legal-looking document without any setup.
  COMPANY_NAME: z.string().min(1).default('Fakturly Demo AB'),
  COMPANY_ADDRESS: z.string().min(1).default('Sveavägen 1, 111 57 Stockholm'),
  COMPANY_ORG_NUMBER: z.string().min(1).default('559123-4567'),
  // Swedish VAT numbers are SE + the ten organisation-number digits + 01.
  COMPANY_VAT_NUMBER: z.string().min(1).default('SE559123456701'),
  COMPANY_EMAIL: z.string().min(1).default('faktura@fakturly.se'),
  COMPANY_BANKGIRO: z.string().min(1).default('123-4567'),

  /**
   * Demo mode — the public showcase deployment.
   *
   * When on, the API exposes the demo login credentials at GET /demo, and a
   * nightly job wipes the database and re-seeds it. Both are things a real
   * deployment must never do, which is why they hang off one explicit flag
   * rather than being inferred from anything else.
   *
   * Reads "true" / "1" as on. Everything else — including the absent case —
   * is off, so forgetting the variable fails safe.
   */
  DEMO_MODE: z
    .string()
    .optional()
    .transform((value) => value === 'true' || value === '1')
})

/**
 * Some variables are optional in development and REQUIRED in production.
 *
 * Stripe and Resend can be absent locally — the clients fall back to a stub
 * that logs instead of calling out, so the whole flow can be built and tested
 * without an account. That is genuinely useful, and it is also exactly how a
 * system ends up deployed with payments silently disabled.
 *
 * superRefine closes that off: in production the keys must be present, and
 * the process refuses to start otherwise. Fail at boot, in front of whoever
 * deployed, rather than at the first customer payment.
 */
const envSchemaWithProductionRules = envSchema.superRefine((value, ctx) => {
  if (value.NODE_ENV !== 'production') return

  const required: Array<[keyof typeof value, string]> = [
    ['STRIPE_SECRET_KEY', 'betalningar skulle tyst sluta fungera'],
    ['STRIPE_WEBHOOK_SECRET', 'webhooks kunde inte verifieras'],
    ['RESEND_API_KEY', 'inga mejl skulle skickas']
  ]

  for (const [key, consequence] of required) {
    if (!value[key]) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${String(key)} krävs i produktion — annars ${consequence}`
      })
    }
  }
})

// safeParse does not throw — it returns a result we can act on, so we can
// print a readable message instead of a stack trace.
const parsed = envSchemaWithProductionRules.safeParse(process.env)

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
