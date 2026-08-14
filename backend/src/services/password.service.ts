// password.service.ts — hashing, verification and password safety checks.
//
// This is the only file in the codebase that knows how a password is stored.
// Everything else calls hashPassword / verifyPassword and stays out of it.
//
// Takes plain arguments, never `request` — so the admin seed script and a
// BullMQ worker can call it exactly like an HTTP route can.

import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2'
import type { Algorithm } from '@node-rs/argon2'
import { randomBytes } from 'node:crypto'
import { isPasswordBreached } from '../lib/hibp.ts'
import { ValidationError } from '../lib/errors.ts'

// ─────────────────────────────────────────────────────────────
// Parameters — OWASP 2024 recommendation for Argon2id
// ─────────────────────────────────────────────────────────────
//
// memoryCost is the important one. A GPU has thousands of cores but very
// little fast memory per core. Forcing every guess to allocate 19 MiB means
// an attacker's card runs out of memory long before it runs out of compute —
// that is what "memory-hard" means, and it is why Argon2id beats bcrypt,
// which is CPU-hard but memory-cheap.
//
// Why not 1 GiB? Because we pay this cost on every single login too. These
// numbers are the point where attacking hurts and serving does not.
// Argon2id = 2 in @node-rs/argon2's Algorithm enum.
//
// Why the literal instead of Algorithm.Argon2id? That enum is an ambient
// `const enum`, and our tsconfig sets verbatimModuleSyntax — which forbids
// reading a const enum's VALUE at runtime, because the import would be erased
// and the value would vanish. We import the type and pin the number.
//
// Argon2id is also the library default, but a security parameter should be
// explicit: a reader must not have to trust a default they cannot see.
const ALGORITHM_ARGON2ID = 2 as Algorithm

const ARGON2_OPTIONS = {
  algorithm: ALGORITHM_ARGON2ID,
  memoryCost: 19456, // 19 MiB, expressed in kibibytes
  timeCost: 2, // passes over the memory
  parallelism: 1 // threads
} as const

// ─────────────────────────────────────────────────────────────
// The dummy hash — our defence against timing-based enumeration
// ─────────────────────────────────────────────────────────────
//
// A naive login returns in ~1 ms when the email does not exist (nothing to
// compare) and ~50 ms when it does (Argon2id runs). That 50x gap lets anyone
// submit 100 000 addresses, time the responses, and read off which ones are
// real customers. Identical error messages do not help — the clock leaks it.
//
// So when there is no user, we verify against a throwaway hash anyway. Same
// work, same delay, no signal.
//
// We start computing it at import time but do NOT await it here: hashing takes
// ~50 ms and blocking module load would slow every boot. By the time the first
// login arrives it has long since resolved.
const dummyHashPromise: Promise<string> = argon2Hash(
  randomBytes(32).toString('hex'),
  ARGON2_OPTIONS
)

// Without this, a rejection before anything awaits the promise would surface
// as an unhandled rejection at startup. Awaiting it later still rejects.
dummyHashPromise.catch(() => {})

// ─────────────────────────────────────────────────────────────
// Normalisation
// ─────────────────────────────────────────────────────────────

/**
 * Unicode-normalises before hashing or verifying.
 *
 * The same passphrase can be typed as different byte sequences on different
 * devices — "é" may be one codepoint (U+00E9) or "e" plus a combining accent
 * (U+0065 U+0301). They look identical and hash completely differently.
 *
 * This MUST happen on both sides. Normalising only when setting a password
 * would lock the user out from any device producing the other form, and the
 * bug would present as "sometimes my password just stops working".
 *
 * Doing it here rather than in the validator gives exactly one choke point,
 * so no route can forget.
 */
function normalize(password: string): string {
  return password.normalize('NFKC')
}

// ─────────────────────────────────────────────────────────────
// Hashing and verification
// ─────────────────────────────────────────────────────────────

/**
 * Hashes a password for storage.
 *
 * There is no salt parameter and no salt column in the schema — that is not
 * an oversight. Argon2 generates a random salt per password and embeds it,
 * together with the parameters, in the returned string:
 *
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
 *
 * So verify() can read back exactly how this hash was produced.
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  return argon2Hash(normalize(plainPassword), ARGON2_OPTIONS)
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row must
 * read as "wrong password", never as a 500 that tells an attacker something
 * unusual just happened.
 */
export async function verifyPassword(
  storedHash: string,
  plainPassword: string
): Promise<boolean> {
  try {
    return await argon2Verify(storedHash, normalize(plainPassword))
  } catch {
    return false
  }
}

/**
 * Constant-time verification that tolerates a missing user.
 *
 * Call this from the login flow with `user?.password ?? null`. When the user
 * does not exist we still run a full Argon2id verification against the dummy
 * hash, so the response takes the same ~50 ms either way.
 *
 * The result is always false in that case — we are burning CPU on purpose.
 * That waste IS the security control.
 */
export async function verifyPasswordOrDummy(
  storedHash: string | null | undefined,
  plainPassword: string
): Promise<boolean> {
  if (storedHash) {
    return verifyPassword(storedHash, plainPassword)
  }

  await verifyPassword(await dummyHashPromise, plainPassword)
  return false
}

// ─────────────────────────────────────────────────────────────
// Upgrading old hashes
// ─────────────────────────────────────────────────────────────

/**
 * True if a stored hash was made with weaker parameters than we now use.
 *
 * Hardware gets faster, so OWASP's recommended parameters rise over time.
 * When we raise them, existing hashes stay at the old cost forever — unless
 * we notice and upgrade them.
 *
 * The catch: we can only re-hash during a SUCCESSFUL login, because that is
 * the only moment we hold the plaintext. Call this there, and if it returns
 * true, hash again with current parameters and store the result.
 *
 * We parse the PHC string ourselves because @node-rs/argon2 exposes no
 * needsRehash. Format:
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
 */
export function needsRehash(storedHash: string): boolean {
  const parameterSection = storedHash.split('$')[3]
  if (!parameterSection) return true // unparseable = upgrade it

  const parameters = new Map<string, number>()
  for (const pair of parameterSection.split(',')) {
    const [key, value] = pair.split('=')
    if (key && value) parameters.set(key, Number.parseInt(value, 10))
  }

  const memory = parameters.get('m')
  const time = parameters.get('t')
  const threads = parameters.get('p')

  if (memory === undefined || time === undefined || threads === undefined) {
    return true
  }

  // Only upgrade, never downgrade. A hash STRONGER than our current settings
  // is left alone — re-hashing it would weaken it.
  return (
    memory < ARGON2_OPTIONS.memoryCost ||
    time < ARGON2_OPTIONS.timeCost ||
    threads < ARGON2_OPTIONS.parallelism
  )
}

// ─────────────────────────────────────────────────────────────
// Password safety (NIST SP 800-63B)
// ─────────────────────────────────────────────────────────────

/**
 * Rejects passwords found in known breaches.
 *
 * Called when a password is SET, never at login — an existing user whose
 * password later turns up in a breach must still be able to log in, and then
 * be prompted to change it. Blocking them at the door would lock people out
 * of their own accounts because of someone else's leak.
 *
 * Shape checks (length, normalisation) already happened in the Zod validator.
 * This is the business rule that needs the network.
 */
export async function assertPasswordNotBreached(plainPassword: string): Promise<void> {
  const result = await isPasswordBreached(normalize(plainPassword))

  if (result.checkFailed) {
    // Fail open: HIBP being down must not stop people setting passwords.
    // The caller logs this — repeated failures mean the control is off.
    return
  }

  if (result.breached) {
    throw new ValidationError(
      'Lösenordet finns i kända dataläckor och kan inte användas. Välj ett annat.',
      { field: 'password', breachCount: result.count }
    )
  }
}

// ─────────────────────────────────────────────────────────────
// Temporary passwords
// ─────────────────────────────────────────────────────────────

/**
 * Generates a random temporary password for an admin-provisioned account.
 *
 * When an admin creates a client, the User row needs a value in its password
 * column, but nobody should ever know it. The client receives a set-password
 * link by email instead.
 *
 * 32 random bytes -> 43 base64url characters, roughly 256 bits of entropy.
 * randomBytes is a CSPRNG; Math.random() is not, and must never be used for
 * anything security-related.
 */
export function generateTemporaryPassword(): string {
  return randomBytes(32).toString('base64url')
}
