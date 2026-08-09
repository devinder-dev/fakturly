// auth.validator.ts — Zod schemas for everything touching login and passwords.
//
// Validation answers ONE question: "does the data have the right shape?"
// It never queries the database and never makes a network call.
// Business rules (does the email exist? is the password breached?) belong in
// the service layer.
//
// Error messages are Swedish because they are shown to Swedish users.

import { z } from 'zod'

// ─────────────────────────────────────────────────────────────
// Email
// ─────────────────────────────────────────────────────────────

// Order in the chain matters. We trim and lowercase FIRST, then validate.
// The other way round, "  Anna@Example.se  " would be rejected despite being
// a perfectly valid address.
//
// 254 characters is the maximum length RFC 5321 allows for an email address.
// Without a cap, someone can submit 10 MB of text and make us validate it.
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Ogiltig e-postadress' }).max(254))

// ─────────────────────────────────────────────────────────────
// Passwords — TWO different schemas, deliberately
// ─────────────────────────────────────────────────────────────

// 1) AT LOGIN: check the shape only, never the policy.
//
// Why not min(12) here as well? Two reasons:
//   a) It leaks the policy. Answering "at least 12 characters" tells an
//      attacker that anything shorter is wasted effort in a brute-force run.
//   b) Policies change over time. If we raise the minimum to 14 later, every
//      existing user with a 12-character password would be locked out at
//      LOGIN — not asked to update it, just locked out.
//
// The 1024 cap is DoS protection: Argon2id is deliberately slow, and we do
// not want to hash a megabyte of text per request.
export const loginPasswordSchema = z
  .string()
  .min(1, 'Lösenord krävs')
  .max(1024)

// 2) WHEN SETTING A PASSWORD: the policy applies (NIST SP 800-63B).
//
// NIST says the opposite of what most people expect:
//   - Length beats complexity
//   - NO composition rules ("must contain uppercase + digit + symbol").
//     They lower real entropy, because everyone answers with "Sommar2026!"
//   - NO forced rotation. It produces Sommar2026 -> Sommar2027.
//   - Check against breached passwords instead — it catches far more.
//
// normalize('NFKC') is not cosmetic. The same passphrase can be written as
// different byte sequences on different devices (e.g. "é" as one codepoint,
// or as "e" + combining accent). Without normalisation they hash DIFFERENTLY,
// and the user is locked out of their own account on their second device.
export const newPasswordSchema = z
  .string()
  .max(1024) // cap before we do any work at all
  .transform((value) => value.normalize('NFKC'))
  .pipe(
    z
      .string()
      .min(12, 'Lösenordet måste vara minst 12 tecken')
      // The maximum sits at 128 — NIST requires it NOT be lower than 64 so
      // passphrases work. Argon2id has no 72-byte truncation trap like
      // bcrypt, so we do not need to cut short.
      .max(128, 'Lösenordet får vara högst 128 tecken')
  )

// ─────────────────────────────────────────────────────────────
// Schemas per endpoint
// ─────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: emailSchema,
  password: loginPasswordSchema
})

// Used when an invited client sets their first password, and when someone
// changes their password via a reset link.
export const setPasswordSchema = z.object({
  token: z.string().min(1, 'Token krävs'),
  password: newPasswordSchema
})

// An admin creates a new client. Note what is NOT here: no `role` field.
// The role is always set server-side. Reading role from a request body would
// let anyone make themselves an ADMIN.
export const createClientSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1, 'Namn krävs').max(200),
  phone: z.string().trim().max(50).optional(),
  address: z.string().trim().max(500).optional()
})

// ─────────────────────────────────────────────────────────────
// Types — derived from the schemas, never written by hand.
// Change a schema and the type follows automatically.
// z.infer gives the type AFTER transforms (i.e. the normalised string).
// ─────────────────────────────────────────────────────────────

export type LoginInput = z.infer<typeof loginSchema>
export type SetPasswordInput = z.infer<typeof setPasswordSchema>
export type CreateClientInput = z.infer<typeof createClientSchema>
