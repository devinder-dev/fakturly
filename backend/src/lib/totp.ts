// totp.ts — time-based one-time passwords (RFC 6238) for two-factor login.
//
// HOW IT WORKS. At enrolment the server and the user's authenticator app
// share a random secret (shown once, as a QR code). From then on both sides
// compute, independently:
//
//   step = floor(unix seconds / 30)
//   code = truncate(HMAC-SHA1(secret, step)) mod 10^6
//
// Nothing travels between them except the six digits the user types, and a
// code is only accepted for about a minute and only once.
//
// WHY HAND-ROLLED, NOT otplib. It is ~100 lines on node:crypto, and the RFCs
// publish exact test vectors (tests/unit/totp.test.ts runs every SHA1 one).
// A library brings its own defaults (window size, digit count), version
// churn, and one more package in the supply chain of a login path — and
// otplib is stateless, so replay protection would still be ours to write. The cost of our choice:
// the bugs are ours, which is why the vectors are not optional.
//
// SHA1 ONLY. HMAC-SHA1 is not weakened by SHA-1 collisions (HMAC needs a
// pseudorandom function, not collision resistance), every authenticator app
// supports it, and Google Authenticator ignores some URI parameters. RFC 6238
// Appendix B's SHA256/SHA512 rows were generated with LONGER seeds than the
// text says (erratum 2866, verified) — so they would not even test what a
// naive reading suggests.
//
// RULES FOR CALLERS (wave 2):
//   - Rate-limit verification. Three valid codes out of 10^6 (window ±1)
//     means an unthrottled attacker wins in ~330 000 guesses — RFC 4226
//     §7.3 asks for throttling for exactly this reason.
//   - Store the returned `step` as the user's lastUsedStep, or REPLAY
//     detection does nothing — and store it with a CONDITIONAL update
//     (WHERE lastUsedStep IS NULL OR lastUsedStep < step), treating zero
//     updated rows as REPLAY. A plain read → verify → write lets two
//     simultaneous submissions of one code both see the old value and
//     both succeed.
//   - Store the secret sealed (lib/secretBox.ts) — it must be readable, so
//     it cannot be hashed like a password.
//   - Never log the secret, the otpauth:// URI (it contains the secret) or a
//     code. Show the same message for MISMATCH and REPLAY; log REPLAY
//     separately — it means a double submit or a stolen code.
//
// SOURCES (checked 2026-10-04):
//   RFC 4226 (HOTP) — §5.3 truncation, R4 digits, R6 secret length, App. D:
//     https://www.rfc-editor.org/rfc/rfc4226
//   RFC 6238 (TOTP) — §4 step, §5.2 window and replay, App. B:
//     https://www.rfc-editor.org/rfc/rfc6238
//   Erratum 2866 (SHA256/512 seeds): https://errata.rfc-editor.org/eid2866
//   RFC 4648 §6 base32, §10 vectors: https://www.rfc-editor.org/rfc/rfc4648
//   Key URI format: https://github.com/google/google-authenticator/wiki/Key-Uri-Format

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** RFC 4226 R6: at least 128 bits, 160 recommended. */
export const TOTP_SECRET_BYTES = 20
const MIN_SECRET_BYTES = 16

/** RFC 6238's default, and the only period Google Authenticator honours. */
export const TOTP_PERIOD_SECONDS = 30

export const TOTP_DIGITS = 6

/**
 * RFC 6238 §5.2 recommends "at most one time step" of tolerance. We allow
 * up to two for badly drifting phones, and refuse more: every extra step
 * adds two more valid codes for a guesser.
 */
const MAX_WINDOW = 2

export type TotpFailure = 'FORMAT' | 'MISMATCH' | 'REPLAY'

export type TotpVerification = { ok: true; step: number } | { ok: false; reason: TotpFailure }

/** A fresh 160-bit secret from the OS CSPRNG. */
export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES)
}

// ─── Base32 (RFC 4648 §6) ─────────────────────────────────────────────────
//
// Authenticator apps take the secret as base32: A–Z and 2–7, case-insensitive,
// no 0/1/8/9 to confuse with O/I/B/g when typed by hand.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Bytes → base32. Padded by default (RFC 4648); totpUri passes
 * `padding: false` because the Key URI format says padding "should be omitted".
 */
export function base32Encode(bytes: Uint8Array, options: { padding?: boolean } = {}): string {
  let out = ''
  let buffer = 0 // bits read but not yet written
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
    buffer &= (1 << bits) - 1 // drop what was written, so buffer stays tiny
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  if (options.padding ?? true) {
    while (out.length % 8 !== 0) out += '='
  }
  return out
}

/**
 * Base32 → bytes. Accepts lower case and missing padding; rejects anything
 * else rather than guessing, including non-canonical input (RFC 4648 §3.5:
 * leftover bits must be zero), because two different strings must never
 * decode to the same secret.
 *
 * Throws a plain Error: the input is our own stored data, so a bad value is
 * a bug or corruption, not something a user typed.
 */
export function base32Decode(input: string): Buffer {
  // TRAP: check the RAW input, then upper-case. Upper-casing first lets
  // Unicode case mapping smuggle in look-alikes: 'ı'.toUpperCase() is 'I'
  // and 'ß'.toUpperCase() is 'SS', which would then pass an ASCII regex.
  const match = /^([A-Za-z2-7]*)(=*)$/.exec(input)
  if (!match) throw new Error('Invalid base32: unexpected character')
  const data = (match[1] ?? '').toUpperCase()
  const padding = match[2] ?? ''

  // 1, 3 or 6 characters in the last group cannot come from whole bytes.
  if ([1, 3, 6].includes(data.length % 8)) throw new Error('Invalid base32: impossible length')
  if (padding.length !== 0 && padding.length !== (8 - (data.length % 8)) % 8) {
    throw new Error('Invalid base32: wrong padding')
  }

  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of data) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff)
      bits -= 8
    }
    buffer &= (1 << bits) - 1
  }
  if (buffer !== 0) throw new Error('Invalid base32: non-zero trailing bits')
  return Buffer.from(bytes)
}

// ─── HOTP / TOTP ──────────────────────────────────────────────────────────

/**
 * RFC 4226 HOTP: the code for one counter value.
 *
 * `digits` is 6 for logins; 7 and 8 exist because RFC 4226 allows them and
 * RFC 6238's test vectors are 8 digits long.
 */
export function hotp(secret: Uint8Array, counter: number | bigint, digits = TOTP_DIGITS): string {
  assertSecret(secret)
  assertDigits(digits)
  if (typeof counter === 'number' && !(Number.isSafeInteger(counter) && counter >= 0)) {
    throw new Error('HOTP counter must be a non-negative safe integer')
  }
  const value = BigInt(counter)
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error('HOTP counter must fit in 64 bits')

  // TRAP: the counter is an 8-byte big-endian integer. JavaScript's bit
  // operators work on 32 bits, so `counter >>> 0` or DataView.setUint32
  // would silently wrap at 2^32 (counter 2^32 would give counter 0's code).
  // writeBigUInt64BE writes all 64 bits. RFC 6238 §4: implementations
  // "MUST support a time value T larger than a 32-bit integer".
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(value)
  const mac = createHmac('sha1', secret).update(message).digest()

  // Dynamic truncation (RFC 4226 §5.3): the low 4 bits of the last byte
  // pick where to read 4 bytes from.
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f
  // TRAP: `& 0x7f` clears the top bit, leaving 31 bits. Without it, `<< 24`
  // can set JavaScript's sign bit and the number goes negative — the RFC
  // masks it "to avoid confusion about signed vs. unsigned modulo".
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0)

  return String(binary % 10 ** digits).padStart(digits, '0')
}

/**
 * RFC 6238 time step: whole 30-second periods since the Unix epoch (T0 = 0).
 * One division, so the result stays exact for any realistic time.
 */
export function totpStep(nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error('nowMs must be a non-negative finite number')
  return Math.floor(nowMs / (TOTP_PERIOD_SECONDS * 1000))
}

/**
 * The code an authenticator app shows at `nowMs`. The clock is an argument
 * (ADR 31) — tests and the RFC vectors need to choose "now".
 */
export function generateTotp(params: { secret: Uint8Array; nowMs: number; digits?: number }): string {
  return hotp(params.secret, totpStep(params.nowMs), params.digits ?? TOTP_DIGITS)
}

/**
 * Checks a code a user typed.
 *
 * Accepts the current step ± `window` (default 1 = ±30 s for clock drift and
 * typing time). On success returns the step that matched; the caller stores
 * it as lastUsedStep, and any later code from that step or earlier is REPLAY
 * (RFC 6238 §5.2: the verifier "MUST NOT accept the second attempt of the
 * OTP after the successful validation").
 *
 * If lastUsedStep is AHEAD of the clock (the server clock jumped back), every
 * code is REPLAY until time catches up. That is the safe way to fail.
 */
export function verifyTotp(params: {
  secret: Uint8Array
  code: string
  nowMs: number
  lastUsedStep?: number | null
  window?: number
  digits?: number
}): TotpVerification {
  const window = params.window ?? 1
  if (!Number.isInteger(window) || window < 0 || window > MAX_WINDOW) {
    throw new Error(`TOTP window must be an integer from 0 to ${MAX_WINDOW}`)
  }
  const digits = params.digits ?? TOTP_DIGITS
  assertDigits(digits)
  // TRAP: `step <= NaN` is false, so a NaN lastUsedStep (say Number() of a
  // corrupt stored value) would silently switch replay detection OFF. This
  // is the one input that would otherwise fail open, so it is checked.
  if (params.lastUsedStep != null && !Number.isSafeInteger(params.lastUsedStep)) {
    throw new Error('lastUsedStep must be a safe integer or null')
  }

  // People type "123 456" because that is how the app displays it.
  // TRAP: timingSafeEqual THROWS when the lengths differ, so the exact
  // length and digits-only check must come before any comparison.
  // (\d without the u flag is ASCII 0–9 only — full-width digits fail here.)
  const code = params.code.replace(/\s/g, '')
  if (code.length !== digits || !/^\d+$/.test(code)) return { ok: false, reason: 'FORMAT' }

  const provided = Buffer.from(code)
  const current = totpStep(params.nowMs)
  let matchedStep = -1

  // TRAP: compare EVERY candidate — no early return on the first match.
  // An early exit makes the response time reveal which step matched. And
  // because the loop runs upward, the last match is the HIGHEST step: if one
  // code is valid in two adjacent steps (it happens — about one step pair
  // in a million), recording the lower one would let the same code be
  // accepted a second time against the higher one.
  for (let step = current - window; step <= current + window; step += 1) {
    if (step < 0) continue
    const expected = Buffer.from(hotp(params.secret, step, digits))
    if (timingSafeEqual(expected, provided)) matchedStep = step
  }

  if (matchedStep < 0) return { ok: false, reason: 'MISMATCH' }
  if (params.lastUsedStep != null && matchedStep <= params.lastUsedStep) {
    return { ok: false, reason: 'REPLAY' }
  }
  return { ok: true, step: matchedStep }
}

/**
 * The otpauth:// URI an authenticator app reads from the enrolment QR code.
 *
 *   otpauth://totp/Fakturly:anna%40exempel.se?secret=…&issuer=Fakturly&…
 *
 * TRAP: encodeURIComponent, not URLSearchParams — URLSearchParams writes a
 * space as '+', and authenticator apps then show "Fakturly+Demo".
 *
 * Issuer appears twice (label prefix AND parameter), as the Key URI format
 * recommends for old and new apps. Neither part may contain ':' — the label
 * is split on it ("Neither issuer nor account name may themselves contain a
 * colon").
 *
 * The result CONTAINS THE SECRET. Render it as a QR code once; never log it.
 */
export function totpUri(params: { secret: Uint8Array; issuer: string; accountName: string }): string {
  assertSecret(params.secret)
  for (const [field, value] of [
    ['issuer', params.issuer],
    ['accountName', params.accountName]
  ] as const) {
    // The message names the field, never the value — accountName is an email.
    if (value.length === 0 || value.includes(':')) {
      throw new Error(`totpUri: ${field} must be non-empty and must not contain ':'`)
    }
  }

  const issuer = encodeURIComponent(params.issuer)
  const label = `${issuer}:${encodeURIComponent(params.accountName)}`
  const query = [
    `secret=${base32Encode(params.secret, { padding: false })}`,
    `issuer=${issuer}`,
    'algorithm=SHA1',
    `digits=${TOTP_DIGITS}`,
    `period=${TOTP_PERIOD_SECONDS}`
  ].join('&')
  return `otpauth://totp/${label}?${query}`
}

// ─── Internals ────────────────────────────────────────────────────────────

function assertSecret(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.byteLength < MIN_SECRET_BYTES) {
    throw new Error(`TOTP secret must be a Uint8Array of at least ${MIN_SECRET_BYTES} bytes`)
  }
}

function assertDigits(digits: number): void {
  // RFC 4226 §5.3: "Implementations MUST extract a 6-digit code at a
  // minimum and possibly 7 and 8-digit code." Nothing else is defined.
  if (digits !== 6 && digits !== 7 && digits !== 8) throw new Error('TOTP digits must be 6, 7 or 8')
}
