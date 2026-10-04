// personnummer.ts — Swedish identity numbers: personnummer, samordningsnummer
// and organisationsnummer. Parse, validate, normalise, format, mask, and turn
// a personnummer into a lookup key that is safe to store.
//
// Pure functions. No database, no env (config arrives as arguments), and the
// clock is injectable (ADR 31) — the century of a 10-digit number depends on
// today's date, so tests must be able to choose "today".
//
// ─── ANATOMY ──────────────────────────────────────────────────────────────
//
//   64 08 23 - 323 4        SKV 704's own example (it is also one of
//   │  │  │  │  │   │       Skatteverket's reserved test numbers)
//   │  │  │  │  │   └ check digit: Luhn over the 9 digits before it
//   │  │  │  │  └ födelsenummer, 001–999
//   │  │  │  └ separator: '-' until the YEAR the person turns 100, then '+'
//   └──┴──┴ födelsetid YYMMDD — for a samordningsnummer, DD + 60
//
// The check digit covers the ten written digits ONLY. The century is not
// protected by anything, which is why a 10-digit number has to be read
// together with its separator and today's date, and why we store all
// twelve digits (folkbokföringslagen 18 § says registers should, too).
//
// ─── SOURCES (checked 2026-10-04) ─────────────────────────────────────────
//
// Folkbokföringslag (1991:481) 18 § — structure, and "bindestreck som byts mot
//   ett plustecken det år en person fyller 100 år":
//   https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/folkbokforingslag-1991481_sfs-1991-481/
// SKV 704 utg. 8 "Personnummer" — the 640823-3234 example, day + 60:
//   https://docs.swedenconnect.se/technical-framework/mirror/skv/skv704-8.pdf
// Lag (2022:1697) om samordningsnummer 2 kap. 8 § — "Siffrorna för dag ska
//   adderas med 60":
//   https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-20221697-om-samordningsnummer_sfs-2022-1697/
// SKV 709 utg. 8 "Organisationsnummer" — ten digits, "Den tredje siffran är
//   alltid lägst en tvåa för att undvika förväxling med personnummer":
//   https://docs.swedenconnect.se/technical-framework/mirror/skv/skv709-8.pdf
// Skatteverket's open test data (every number in both sets parses here; see
//   the network test in tests/unit/personnummer.test.ts):
//   https://skatteverket.entryscape.net/rowstore/dataset/b4de7df7-63c0-4e7e-bb59-1f156a591763  (testpersonnummer)
//   https://skatteverket.entryscape.net/rowstore/dataset/9f29fe09-4dbc-4d2f-848f-7cffdd075383  (testsamordningsnummer)
// Dataskyddslag (2018:218) 3 kap. 10 §:
//   https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-2018218-med-kompletterande-bestammelser-till_sfs-2018-218/
// Ändra juridiskt kön — "I praktiken innebär det att du får ett nytt
//   personnummer eller samordningsnummer":
//   https://www.skatteverket.se/privat/folkbokforing/andrajuridisktkon.4.7dd11e17188c71ebf17238c.html
//
// ─── SAMORDNINGSNUMMER: THE BIRTH DATE MAY BE INCOMPLETE ─────────────────
//
// Verified against Skatteverket's 4 088 test samordningsnummer: the Luhn
// digit is computed over the digits AS WRITTEN (day + 60) — all 4 088 pass.
// But 192 of them do not contain a real calendar date: month 00 (unknown
// month), day 60 (= day 00, unknown day), or a day the month does not have
// (19300290…, "30 February"). Those are numbers Skatteverket has issued, so
// rejecting them would lock real people out. For a samordningsnummer we
// therefore accept month 00–12 and day 00–31, and report birthDate = null
// whenever the digits do not name a real date. A personnummer is held to a
// real calendar date — all 43 895 test personnummer have one.
//
// ─── RULES FOR EVERYONE WHO TOUCHES THESE NUMBERS ────────────────────────
//
// LEGAL BASIS. Dataskyddslagen 3 kap. 10 §: personnummer may be processed
// without consent only when "klart motiverat med hänsyn till ändamålet med
// behandlingen, vikten av en säker identifiering eller något annat
// beaktansvärt skäl". Secure identification (BankID login, wave 2) is our
// reason. Collect it for that, not "in case it is useful".
//
// NEVER LOG IT. Not in error messages, audit rows, Sentry breadcrumbs or
// request logs. Errors thrown here carry a reason code, never the input.
// Use maskPersonnummer() when a human must see which number it was.
//
// NEVER DERIVE GENDER FROM DIGIT 9. The odd/even birth number reflects the
// legal sex at the time the number was ISSUED. A legal change of sex gives
// the person a NEW personnummer (Skatteverket: "I praktiken innebär det att
// du får ett nytt personnummer"; the process was reformed by the law that
// took effect 1 July 2025). So: (1) digit 9 says nothing we may use, and
// (2) a stored number can stop being the person's current one — wave 2 needs
// a way for an admin to re-link a user to a new number.

import { createHmac } from 'node:crypto'
import { ValidationError } from './errors.ts'
import { stockholmYear } from './money.ts'
import { isValidLuhn } from './ocr.ts'

export type IdentityNumberKind = 'personnummer' | 'samordningsnummer'

/**
 * A successfully parsed number. Discriminated on `kind` so TypeScript forces
 * callers to handle a samordningsnummer without a known birth date.
 */
export type ParsedPersonnummer =
  | {
      kind: 'personnummer'
      /** 'YYYYMMDDNNNC' — the one form we store and compare. */
      normalized: string
      /** 'YYYY-MM-DD'. A calendar date has no time zone, so it is not a Date. */
      birthDate: string
    }
  | {
      kind: 'samordningsnummer'
      /** 'YYYYMMDDNNNC' with DD + 60, exactly as issued. */
      normalized: string
      /** null when Skatteverket issued it with an unknown or impossible date. */
      birthDate: string | null
    }

/**
 * Why a number was rejected, most fundamental first:
 *   FORMAT   — not one of the accepted shapes
 *   CENTURY  — a 12-digit number outside the 1800s, 1900s or 2000s
 *   CHECKSUM — the Luhn digit is wrong (the typical typo)
 *   DATE     — the digits do not form a date this kind of number may carry
 *   FUTURE   — born after today (in Stockholm)
 */
export type PersonnummerFailure = 'FORMAT' | 'CENTURY' | 'CHECKSUM' | 'DATE' | 'FUTURE'

export type PersonnummerResult =
  | { ok: true; value: ParsedPersonnummer }
  | { ok: false; reason: PersonnummerFailure }

export type PersonnummerOptions = {
  /** "Now", for century inference and the future check. Defaults to the real clock. */
  referenceDate?: Date
}

// 12 digits, optional '-': 19640823-3234, 196408233234.
// A '+' is NOT accepted here: with the century written out it adds nothing,
// and "19640823+3234" contradicts itself for anyone under 100.
const TWELVE_DIGITS = /^(\d{8})-?(\d{4})$/

// 10 digits: 640823-3234, 640823+3234, 6408233234 (no separator reads as '-').
const TEN_DIGITS = /^(\d{6})([-+]?)(\d{4})$/

const ALLOWED_CENTURIES = new Set([18, 19, 20])

/**
 * Parses any accepted written form of a personnummer or samordningsnummer.
 *
 * Never throws on bad input — returns a reason instead, because "the user
 * typed it wrong" is an expected outcome, not an exception.
 */
export function parsePersonnummer(input: string, options: PersonnummerOptions = {}): PersonnummerResult {
  const referenceDate = options.referenceDate ?? new Date()
  const trimmed = input.trim()

  let twelve: string
  const full = TWELVE_DIGITS.exec(trimmed)
  const short = full ? null : TEN_DIGITS.exec(trimmed)

  if (full) {
    twelve = `${full[1]}${full[2]}`
  } else if (short) {
    const yy = Number(short[1].slice(0, 2))
    const separator = short[2] === '+' ? '+' : '-'
    const year = inferBirthYear(yy, separator, stockholmYear(referenceDate))
    twelve = `${year}${short[1].slice(2)}${short[3]}`
  } else {
    return { ok: false, reason: 'FORMAT' }
  }

  // Checked after inference too: in the year 2100 a '-' number would infer
  // the 2100s, which we have no reason to believe Skatteverket will issue.
  if (!ALLOWED_CENTURIES.has(Number(twelve.slice(0, 2)))) {
    return { ok: false, reason: 'CENTURY' }
  }

  // Luhn over the 10 written digits — the century is not part of it.
  if (!isValidLuhn(twelve.slice(2))) {
    return { ok: false, reason: 'CHECKSUM' }
  }

  const year = twelve.slice(0, 4)
  const month = twelve.slice(4, 6)
  const rawDay = Number(twelve.slice(6, 8))

  // Day 60–91 is a samordningsnummer (day + 60, where day 00 = unknown).
  // Day 32–59 and 92–99 are neither kind.
  if (rawDay >= 60 && rawDay <= 91) {
    const day = String(rawDay - 60).padStart(2, '0')
    if (Number(month) > 12) return { ok: false, reason: 'DATE' }

    const birthDate = isRealDate(year, month, day) ? `${year}-${month}-${day}` : null
    // An unknown month or day counts as the earliest it could be, so a
    // number is only "future" when even that is after today.
    const earliest = `${year}-${month === '00' ? '01' : month}-${day === '00' ? '01' : day}`
    if (earliest > stockholmDate(referenceDate)) return { ok: false, reason: 'FUTURE' }

    return { ok: true, value: { kind: 'samordningsnummer', normalized: twelve, birthDate } }
  }

  const day = twelve.slice(6, 8)
  if (!isRealDate(year, month, day)) return { ok: false, reason: 'DATE' }

  const birthDate = `${year}-${month}-${day}`
  // ISO dates compare correctly as strings: '2026-02-01' < '2026-10-04'.
  if (birthDate > stockholmDate(referenceDate)) return { ok: false, reason: 'FUTURE' }

  return { ok: true, value: { kind: 'personnummer', normalized: twelve, birthDate } }
}

export function isValidPersonnummer(input: string, options: PersonnummerOptions = {}): boolean {
  return parsePersonnummer(input, options).ok
}

/**
 * 'YYYYMMDDNNNC', or throws ValidationError (400) with the reason code.
 *
 * The thrown error deliberately does not contain the input: errors end up in
 * logs and Sentry, and a personnummer must not.
 */
export function normalizePersonnummer(input: string, options: PersonnummerOptions = {}): string {
  const result = parsePersonnummer(input, options)
  if (!result.ok) {
    throw new ValidationError('Ogiltigt personnummer', { reason: result.reason })
  }
  return result.value.normalized
}

/**
 * 'YYYYMMDD-NNNC' — the 12-digit display form.
 *
 * Always '-': the '+' only exists to disambiguate the century in the 10-digit
 * form, and here the century is written out.
 */
export function formatPersonnummer(input: string, options: PersonnummerOptions = {}): string {
  const normalized = normalizePersonnummer(input, options)
  return `${normalized.slice(0, 8)}-${normalized.slice(8)}`
}

/**
 * 'YYYYMMDD-****' — enough for a person to recognise which number it is
 * (an admin screen, a support conversation), without the four digits that
 * make it an identifier.
 */
export function maskPersonnummer(input: string, options: PersonnummerOptions = {}): string {
  const normalized = normalizePersonnummer(input, options)
  return `${normalized.slice(0, 8)}-****`
}

// ─── Lookup key ───────────────────────────────────────────────────────────

/**
 * Domain separation + version. "fakturly:personnummer" means a pepper reused
 * for something else can never produce a matching key by accident; "v1"
 * means a future format can live next to this one during a migration.
 *
 * Changing ANY character here changes every key and orphans every stored
 * link — tests/unit/personnummer.test.ts pins a known vector for that reason.
 */
const LOOKUP_KEY_PREFIX = 'fakturly:personnummer:v1:'

/**
 * 32 bytes = SHA-256's output length. RFC 2104 §3: a key shorter than the
 * hash output is "strongly discouraged" — it lowers the HMAC's strength.
 */
export const MIN_PEPPER_BYTES = 32

/**
 * A deterministic, non-reversible key for finding a user by personnummer:
 * HMAC-SHA256(pepper, 'fakturly:personnummer:v1:' + normalized), as hex.
 *
 * WHY NOT PLAIN SHA-256. There are only about 10⁸ personnummer: ~200 years of
 * birth dates × 1 000 birth numbers, and the check digit is computed, not
 * guessed. A single GPU computes billions of SHA-256 per second, so a leaked
 * table of SHA-256(personnummer) is reversed completely in well under a
 * second. Hashing does not hide a value from a small space.
 *
 * WHY HMAC. The pepper is a secret that lives OUTSIDE the database (env /
 * secret manager, wired up in wave 2). A database dump alone gives an
 * attacker keys they cannot recompute, so they cannot enumerate. If the
 * pepper leaks TOGETHER with the database, this is no better than SHA-256 —
 * the security is exactly the secrecy of the pepper.
 *
 * WHY NOT ARGON2. A lookup key must be deterministic (no per-row salt) or it
 * cannot be indexed, and a slow hash over 10⁸ inputs is slowed, not stopped —
 * while every BankID login would pay the cost.
 *
 * THE TRADE-OFF: the pepper cannot be rotated from the keys alone. Rotating
 * it means recomputing every key from the plaintext number — which requires
 * having it stored encrypted (secretBox, phase 2) or re-linking users.
 */
export function personnummerLookupKey(pnr: string, pepper: Uint8Array): string {
  // A short pepper is a configuration bug, not bad user input — plain Error, 500.
  if (pepper.byteLength < MIN_PEPPER_BYTES) {
    throw new Error(`Personnummer pepper must be at least ${MIN_PEPPER_BYTES} bytes`)
  }
  // Normalise first, so 640823-3234 and 196408233234 give the same key.
  const normalized = normalizePersonnummer(pnr)
  return createHmac('sha256', pepper).update(`${LOOKUP_KEY_PREFIX}${normalized}`).digest('hex')
}

// ─── Organisationsnummer ─────────────────────────────────────────────────

const ORGANISATIONSNUMMER = /^(\d{6})-?(\d{4})$/

function organisationsnummerDigits(input: string): string | null {
  const match = ORGANISATIONSNUMMER.exec(input.trim())
  if (!match) return null
  const digits = `${match[1]}${match[2]}`
  // Third digit ≥ 2: it sits where a personnummer has the first month digit
  // (0 or 1), so the two kinds of number can never be confused (SKV 709).
  if (Number(digits[2]) < 2) return null
  return isValidLuhn(digits) ? digits : null
}

/**
 * A legal person's organisationsnummer: ten digits, third digit ≥ 2, Luhn.
 *
 * NOTE: a sole trader (enskild näringsidkare) has no organisationsnummer of
 * this kind — the business uses the owner's personnummer. A field that must
 * accept every Swedish business has to accept either.
 */
export function isValidOrganisationsnummer(input: string): boolean {
  return organisationsnummerDigits(input) !== null
}

/** 'NNNNNNNNNN', or throws ValidationError (400). */
export function normalizeOrganisationsnummer(input: string): string {
  const digits = organisationsnummerDigits(input)
  if (digits === null) throw new ValidationError('Ogiltigt organisationsnummer')
  return digits
}

/** 'NNNNNN-NNNN' — the form printed on invoices and in Bolagsverket's register. */
export function formatOrganisationsnummer(input: string): string {
  const digits = normalizeOrganisationsnummer(input)
  return `${digits.slice(0, 6)}-${digits.slice(6)}`
}

// ─── Internals ────────────────────────────────────────────────────────────

/**
 * The birth year a 10-digit number means, given the current Stockholm year.
 *
 * '-' = the person turns at most 99 this calendar year → the latest year
 *       ending in `yy` that is not after this year.
 * '+' = the person turns 100 or more this year → a century earlier.
 *
 * Calendar YEAR, not birthday: the law switches the sign "det år en person
 * fyller 100 år", so someone born 31 December 1926 is written with '+' from
 * 1 January 2026.
 */
function inferBirthYear(yy: number, separator: '-' | '+', currentYear: number): number {
  // Years since the latest year ending in yy: 0..99. The double modulo keeps
  // it non-negative — JS's % has the sign of the dividend.
  const yearsBack = (((currentYear - yy) % 100) + 100) % 100
  const year = currentYear - yearsBack
  return separator === '+' ? year - 100 : year
}

/** True for a date that exists in the Gregorian calendar (no 30 Feb, 29 Feb only in leap years). */
function isRealDate(year: string, month: string, day: string): boolean {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  if (m < 1 || m > 12 || d < 1) return false
  // Date.UTC rolls an impossible date over (31 April → 1 May); a real one
  // comes back unchanged. UTC so no local time zone can shift the day.
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/**
 * Today's date in Stockholm as 'YYYY-MM-DD'.
 *
 * formatToParts rather than relying on the sv-SE locale's output pattern:
 * the parts are a stable API, a locale's punctuation is not.
 */
function stockholmDate(at: Date): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(at)
  const part = (type: 'year' | 'month' | 'day'): string => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}
