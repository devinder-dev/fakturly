// loginAttempts.service.ts — layer 2: limiting per ACCOUNT.
//
// Catches what per-IP misses: distributed brute force. A botnet targeting one
// high-value account sends two attempts per IP across hundreds of addresses.
// No IP counter ever fires — but all those attempts hit ONE account, and an
// account counter stops them at five.
//
// ── The subtle trap ──────────────────────────────────────────────
// We count attempts for EVERY submitted email address — including ones that
// do not exist. If we only counted real accounts, an existing address would
// get slower and slower while an unknown one answered instantly. That
// difference is exactly the enumeration oracle we removed in step 1.
//
// Does this service take `request`? No. It takes plain arguments, so the same
// logic can be called from a BullMQ worker or a test.

import { createHash } from 'node:crypto'
import { redis } from '../lib/redis.ts'
import { RateLimitError } from '../lib/errors.ts'

/** The window within which failed attempts are counted. */
const WINDOW_SECONDS = 15 * 60 // 15 minutes

/** Failures allowed before the account is blocked for the rest of the window. */
export const MAX_ATTEMPTS = 5

/** The first two attempts are free — people do mistype their own password. */
const FREE_ATTEMPTS = 2

/** Base delay. Grows by a factor of 4 per subsequent attempt. */
const DELAY_BASE_MS = 100

/** Cap on the delay, otherwise we tie up our own connections. */
const DELAY_MAX_MS = 5000

/**
 * The key holds a HASH of the email address, not the address itself.
 *
 * Two reasons: we do not want customer email addresses scattered across Redis
 * (which can be dumped, logged or inspected), and a hash has a fixed length —
 * otherwise someone submits a 900-character "address" as a key.
 */
function attemptsKey(email: string): string {
  const digest = createHash('sha256').update(email.toLowerCase()).digest('hex')
  return `fakturly:login:fail:${digest.slice(0, 32)}`
}

/**
 * Progressive delay — what banks actually do.
 *
 * attempt 1-2: 0 ms       (typos should not be punished)
 * attempt 3:   100 ms
 * attempt 4:   400 ms
 * attempt 5:   1600 ms
 * ... up to the cap
 *
 * Why not just lock the account immediately? Because pure lockout is a
 * self-inflicted DoS: anyone can lock YOU out of your own account by
 * deliberately failing five times. The delay makes brute force impractical
 * long before lockout is needed — 1000 guesses take days instead of seconds —
 * without handing an attacker a weapon.
 */
export function progressiveDelayMs(failedAttempts: number): number {
  if (failedAttempts <= FREE_ATTEMPTS) return 0
  const step = failedAttempts - FREE_ATTEMPTS - 1
  return Math.min(DELAY_BASE_MS * 4 ** step, DELAY_MAX_MS)
}

export async function getFailedAttempts(email: string): Promise<number> {
  const value = await redis.get(attemptsKey(email))
  return value === null ? 0 : Number.parseInt(value, 10) || 0
}

/**
 * Increments the failure count and returns the new total.
 *
 * INCR + EXPIRE in one pipeline = a single round trip to Redis instead of
 * two. We set EXPIRE every time, so the window slides forward: as long as
 * someone keeps guessing, the account stays protected.
 */
export async function recordFailedAttempt(email: string): Promise<number> {
  const key = attemptsKey(email)
  const results = await redis.multi().incr(key).expire(key, WINDOW_SECONDS).exec()

  // exec() returns [[err, value], ...]. The first entry is the INCR result.
  const incrResult = results?.[0]
  if (!incrResult || incrResult[0]) return 0
  return Number(incrResult[1]) || 0
}

/** Cleared on successful login — otherwise old failures lock out a valid user. */
export async function clearFailedAttempts(email: string): Promise<void> {
  await redis.del(attemptsKey(email))
}

/**
 * Throws RateLimitError if the account has too many failed attempts.
 * Called FIRST in the login flow, before we even touch the database.
 *
 * Returning 429 here leaks nothing: we count unknown addresses too, so an
 * attacker cannot tell "blocked account" apart from "blocked guessing against
 * an address that never existed".
 */
export async function assertAccountNotLocked(email: string): Promise<void> {
  const attempts = await getFailedAttempts(email)
  if (attempts < MAX_ATTEMPTS) return

  const ttl = await redis.ttl(attemptsKey(email))
  throw new RateLimitError(ttl > 0 ? ttl : WINDOW_SECONDS)
}

/**
 * Waits out the progressive delay.
 *
 * Called on a failed login BEFORE the response is sent, so an attacker's
 * tooling is actually forced to wait.
 */
export async function applyProgressiveDelay(failedAttempts: number): Promise<void> {
  const delay = progressiveDelayMs(failedAttempts)
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
}
