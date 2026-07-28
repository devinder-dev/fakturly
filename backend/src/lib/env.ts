// env.ts — validerar miljövariabler EN gång vid uppstart (fail fast).
//
// Varför? Utan detta startar appen glatt med en saknad JWT_SECRET och
// kraschar först när någon försöker logga in — kanske i produktion, kl 02:00.
// Med detta vägrar processen att starta alls. En krasch vid uppstart är bra.
//
// Efter denna fil ska vi ALDRIG läsa process.env direkt någon annanstans.
// Vi importerar `env` istället — då är värdena både validerade och typade.

import 'dotenv/config' // laddar backend/.env in i process.env
import { z } from 'zod'

const envSchema = z.object({
  // Databas & cache — måste finnas, annars kan appen inte göra något alls
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  // Auth — minst 32 tecken. En kort secret går att gissa/brute-forca.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET måste vara minst 32 tecken'),
  // Hur länge en access-token är giltig. Kort = mindre skada om den läcker.
  JWT_EXPIRES_IN: z.string().default('1h'),

  // App. coerce = "0"/"3000" kommer in som sträng, vi vill ha number.
  PORT: z.coerce.number().int().positive().default(3000),
  FRONTEND_URL: z.url().default('http://localhost:5173'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Vecka 3 — får vara tomma nu. .optional() = nyckeln behöver inte finnas,
  // och tom sträng ("") är tillåtet eftersom vi inte kräver .min(1).
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional()
})

// safeParse kastar inte fel — det ger oss ett resultat vi kan agera på,
// så att vi kan skriva ut ett begripligt felmeddelande istället för en stacktrace.
const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Ogiltiga miljövariabler i backend/.env:\n')
  console.error(z.prettifyError(parsed.error))
  console.error('\nJämför med backend/.env.example och fyll i det som saknas.')
  process.exit(1) // exit-kod != 0 betyder "misslyckades" för Docker/CI
}

// parsed.data är nu fullt typad: env.PORT är number, env.NODE_ENV är en union.
export const env = parsed.data

// Praktisk hjälpare — används senare för t.ex. Secure-cookies och loggnivå.
export const isProduction = env.NODE_ENV === 'production'
