// personnummer.test.ts — parsing, century inference, samordningsnummer,
// organisationsnummer and the stored lookup key.
//
// Which numbers appear here — a personnummer belongs to a real person
// unless Skatteverket has reserved it for testing:
//
//   - Every number a test expects to PARSE is SKV 704's example
//     (640823-3234, itself a reserved test number) or one of Skatteverket's
//     published test personnummer / samordningsnummer, which can never be
//     issued to anyone.
//   - Numbers a test expects to be REJECTED are those same numbers with a
//     deliberate typo or an altered century, or computed impossibilities
//     (month 13, day 45, 29 February 1900) — marked where they appear.
//   - The '-' / '+' contrast tests use samordningsnummer: Skatteverket's
//     data has 23 ten-digit sequences published under BOTH centuries, and
//     all 23 are samordningsnummer. Century inference is the same code for
//     both kinds.
//   - Organisationsnummer are public register data, not personal data.

import { describe, test, expect } from 'bun:test'
import {
  parsePersonnummer,
  isValidPersonnummer,
  normalizePersonnummer,
  formatPersonnummer,
  maskPersonnummer,
  personnummerLookupKey,
  isValidOrganisationsnummer,
  normalizeOrganisationsnummer,
  formatOrganisationsnummer,
  type PersonnummerFailure
} from '../../src/lib/personnummer.ts'
import { ValidationError } from '../../src/lib/errors.ts'

// A fixed "now" — 15 June 2026, midday in Stockholm. Century inference and
// the future check depend on the clock, so tests never use the real one.
const MIDSUMMER_2026 = new Date('2026-06-15T10:00:00Z')
const AT_MIDSUMMER = { referenceDate: MIDSUMMER_2026 }

function parse(input: string, referenceDate = MIDSUMMER_2026) {
  return parsePersonnummer(input, { referenceDate })
}

function reasonFor(input: string, referenceDate = MIDSUMMER_2026): PersonnummerFailure | 'OK' {
  const result = parse(input, referenceDate)
  return result.ok ? 'OK' : result.reason
}

describe('parsePersonnummer — SKV 704 example 640823-3234', () => {
  test.each(['640823-3234', '6408233234', '19640823-3234', '196408233234', '  640823-3234  '])(
    '%p normalises to the same twelve digits',
    (input) => {
      expect(parse(input)).toEqual({
        ok: true,
        value: { kind: 'personnummer', normalized: '196408233234', birthDate: '1964-08-23' }
      })
    }
  )
})

describe('parsePersonnummer — Skatteverket open-data test numbers', () => {
  test('198501012382 in its 12- and 10-digit forms', () => {
    for (const input of ['198501012382', '19850101-2382', '850101-2382', '8501012382']) {
      const result = parse(input)
      expect(result.ok && result.value.normalized).toBe('198501012382')
    }
  })

  test("189001019802 is written 900101+9802 — the '+' says 'over 100'", () => {
    const result = parse('900101+9802')
    expect(result.ok && result.value).toEqual({
      kind: 'personnummer',
      normalized: '189001019802',
      birthDate: '1890-01-01'
    })
  })

  test('200002292399 — 29 February 2000 exists (divisible by 400)', () => {
    const result = parse('200002292399')
    expect(result.ok && result.value.birthDate).toBe('2000-02-29')
  })
})

describe('century inference — by Stockholm calendar year', () => {
  // The pairs below are samordningsnummer because those are the only
  // ten-digit sequences Skatteverket has published under both centuries.
  const EARLY_2026 = new Date('2026-03-01T12:00:00Z')

  test('🔑 same ten digits, two people — only the separator tells them apart', () => {
    // Test samordningsnummer 202501722397 and 192501722397 (12 January).
    // The check digit covers only the ten written digits, so it is equally
    // valid for both centuries.
    expect(parse('250172-2397')).toEqual({
      ok: true,
      value: { kind: 'samordningsnummer', normalized: '202501722397', birthDate: '2025-01-12' }
    })
    expect(parse('250172+2397')).toEqual({
      ok: true,
      value: { kind: 'samordningsnummer', normalized: '192501722397', birthDate: '1925-01-12' }
    })
  })

  test("'-' never reaches into the future: 261269-2380 in March 2026 is FUTURE", () => {
    // Test samordningsnummer 202612692380 = 9 December 2026. '-' means
    // "turns at most 99 this year", so this must be 2026 — and 9 December
    // has not happened yet. It does NOT fall back to 1926.
    expect(reasonFor('261269-2380', EARLY_2026)).toBe('FUTURE')
  })

  test("'+' applies from 1 January of the year the person turns 100", () => {
    // Test samordningsnummer 192612692380: born 9 Dec 1926, still 99 in
    // March 2026 — but the law switches the sign "det år en person fyller
    // 100 år": the calendar year, not the birthday.
    const result = parse('261269+2380', EARLY_2026)
    expect(result.ok && result.value.normalized).toBe('192612692380')
  })

  test('a baby born last year is inferred as last year, not a century ago', () => {
    // Test number 202512312386.
    const result = parse('251231-2386', EARLY_2026)
    expect(result.ok && result.value.normalized).toBe('202512312386')
  })

  test('🔑 Stockholm New Year: the year flips at Stockholm midnight, not UTC midnight', () => {
    // 22:30 UTC on 31 Dec = 23:30 in Stockholm: still 2025, so a 2026 birth
    // is impossible and '-' (at most 99 this year) means 1926.
    // Test samordningsnummer 192601762392 (16 January 1926).
    const lateEvening = new Date('2025-12-31T22:30:00Z')
    expect(parse('260176-2392', lateEvening)).toMatchObject({ ok: true, value: { normalized: '192601762392' } })

    // 23:30 UTC = 00:30 on 1 Jan in Stockholm: it is 2026, so the same string
    // now means 16 January 2026 — two weeks ahead. A server reading the UTC
    // year (still 2025) would wrongly accept it as the 1926 person.
    const justAfterMidnight = new Date('2025-12-31T23:30:00Z')
    expect(reasonFor('260176-2392', justAfterMidnight)).toBe('FUTURE')

    // A baby born that night already parses. Test number 202601012384.
    expect(parse('260101-2384', justAfterMidnight)).toMatchObject({ ok: true, value: { normalized: '202601012384' } })

    // Once 16 January 2026 has passed, the string means the 2026 person.
    // Test samordningsnummer 202601762392.
    expect(parse('260176-2392', new Date('2026-01-20T12:00:00Z'))).toMatchObject({
      ok: true,
      value: { normalized: '202601762392' }
    })
  })

  test('a 12-digit number carries its own century — the clock only matters for FUTURE', () => {
    // Test number 189001019802, parsed "in 2099".
    const result = parse('189001019802', new Date('2099-01-01T12:00:00Z'))
    expect(result.ok && result.value.birthDate).toBe('1890-01-01')
  })

  test("in the 2100s a 10-digit '-' number infers the 2100s → CENTURY", () => {
    // 000101-2384 in 2100: '-' means "at most 99 this year" → born 2100,
    // a century we have no reason to believe Skatteverket will issue.
    const IN_2100 = new Date('2100-06-15T10:00:00Z')
    expect(reasonFor('000101-2384', IN_2100)).toBe('CENTURY')
    // With '+' it is test number 200001012384, a centenarian by then.
    expect(parse('000101+2384', IN_2100)).toMatchObject({ ok: true, value: { normalized: '200001012384' } })
  })

  test('an invalid referenceDate is a programming error — it throws, clearly', () => {
    // Not a reason code: a broken clock would infer wrong centuries for
    // every number, so it must fail loudly rather than parse quietly.
    expect(() => parsePersonnummer('196408233234', { referenceDate: new Date('nonsense') })).toThrow(
      'referenceDate must be a valid Date'
    )
  })
})

describe('leap years', () => {
  test('29 February 2000 is valid, 29 February 1900 is not (century rule)', () => {
    // Test number 200002292381. With century 19 the same ten digits name
    // 29 Feb 1900 — a date that never existed (1900 is not divisible by 400).
    expect(reasonFor('200002292381')).toBe('OK')
    expect(reasonFor('190002292381')).toBe('DATE')
  })

  test('the 10-digit form 000229-2381 infers 2000, so it is valid', () => {
    const result = parse('000229-2381')
    expect(result.ok && result.value.birthDate).toBe('2000-02-29')
  })

  test('28 February 1900 is fine', () => {
    // Test number 190002289825.
    expect(reasonFor('190002289825')).toBe('OK')
  })
})

describe('samordningsnummer (day + 60)', () => {
  test('a real date is reported with the 60 removed', () => {
    // Test samordningsnummer 191401682396: day 68 → 8 January 1914.
    expect(parse('191401682396')).toEqual({
      ok: true,
      value: { kind: 'samordningsnummer', normalized: '191401682396', birthDate: '1914-01-08' }
    })
  })

  test('the 10-digit form works the same way', () => {
    // Test samordningsnummer 201401612385: day 61 → 1 January 2014.
    const result = parse('140161-2385')
    expect(result.ok && result.value.kind).toBe('samordningsnummer')
    expect(result.ok && result.value.normalized).toBe('201401612385')
  })

  // All four are in Skatteverket's published test data. Rejecting them would
  // lock out people Skatteverket has actually given a number to.
  test.each([
    ['191711602399', 'day 60 = day 00, unknown day'],
    ['191500722390', 'month 00, unknown month'],
    ['193100602394', 'month and day both unknown'],
    ['193002902397', '30 February — a "nearby day" that does not exist']
  ])('%p (%s) is valid, with birthDate null', (input) => {
    expect(parse(input)).toEqual({
      ok: true,
      value: { kind: 'samordningsnummer', normalized: input, birthDate: null }
    })
  })

  test('month 13 is still rejected (computed, not a real number)', () => {
    expect(reasonFor('641383-3234')).toBe('DATE')
  })

  test('a samordningsnummer can be FUTURE too', () => {
    // Test samordningsnummer 202612912382 = 31 December 2026.
    expect(reasonFor('202612912382')).toBe('FUTURE')
    expect(reasonFor('202612912382', new Date('2027-01-01T12:00:00Z'))).toBe('OK')
  })
})

describe('parsePersonnummer — rejection reasons', () => {
  test.each([
    '',
    '   ',
    'abc',
    '64-0823-3234',
    '6408233-234',
    '64082332341', // 11 digits
    '6408 23-3234',
    '19640823+3234', // '+' with the century written out contradicts itself
    '１９６４０８２３３２３４' // full-width digits: \d is ASCII-only without the u flag
  ])('%p → FORMAT', (input) => {
    expect(reasonFor(input)).toBe('FORMAT')
  })

  test.each(['176408233234', '216408233234'])('%p → CENTURY', (input) => {
    expect(reasonFor(input)).toBe('CENTURY')
  })

  test.each(['640823-3235', '196408233235', '640823-3243'])('%p → CHECKSUM', (input) => {
    // The last one swaps two neighbouring digits — the other common typo.
    expect(reasonFor(input)).toBe('CHECKSUM')
  })

  // Computed numbers: valid Luhn, impossible date.
  test.each([
    ['641323-3237', 'month 13'],
    ['640800-3231', 'day 00 (only a samordningsnummer may have an unknown day)'],
    ['640845-3238', 'day 45 — neither a personnummer nor a samordningsnummer'],
    ['640892-3230', 'day 92 — past the samordningsnummer range']
  ])('%p (%s) → DATE', (input) => {
    expect(reasonFor(input)).toBe('DATE')
  })

  test('born after today → FUTURE', () => {
    // Test number 202612312385, checked in June 2026.
    expect(reasonFor('202612312385')).toBe('FUTURE')
  })
})

describe('isValidPersonnummer', () => {
  test('is parse().ok', () => {
    expect(isValidPersonnummer('640823-3234', AT_MIDSUMMER)).toBe(true)
    expect(isValidPersonnummer('640823-3235', AT_MIDSUMMER)).toBe(false)
  })
})

describe('normalizePersonnummer', () => {
  test('returns the twelve digits', () => {
    expect(normalizePersonnummer('640823-3234', AT_MIDSUMMER)).toBe('196408233234')
  })

  test('throws a 400 ValidationError carrying the reason', () => {
    let thrown: unknown = null
    try {
      normalizePersonnummer('640823-3235', AT_MIDSUMMER)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ValidationError)
    expect((thrown as ValidationError).statusCode).toBe(400)
    expect((thrown as ValidationError).details).toEqual({ reason: 'CHECKSUM' })
  })

  test('🔑 the error never contains the number — errors end up in logs', () => {
    let thrown: unknown = null
    try {
      normalizePersonnummer('19640823-3235', AT_MIDSUMMER)
    } catch (error) {
      thrown = error
    }
    const everything = `${(thrown as Error).message} ${JSON.stringify((thrown as ValidationError).details)} ${(thrown as Error).stack}`
    expect(everything).not.toContain('640823')
    expect(everything).not.toContain('3235')
  })
})

describe('formatPersonnummer / maskPersonnummer', () => {
  test('format is the 12-digit form with a dash', () => {
    expect(formatPersonnummer('6408233234', AT_MIDSUMMER)).toBe('19640823-3234')
  })

  test("format uses '-' even for someone over 100 — the century is written out", () => {
    expect(formatPersonnummer('900101+9802', AT_MIDSUMMER)).toBe('18900101-9802')
  })

  test('mask keeps the birth date and hides the four identifying digits', () => {
    expect(maskPersonnummer('640823-3234', AT_MIDSUMMER)).toBe('19640823-****')
  })

  test('both refuse an invalid number rather than display garbage', () => {
    expect(() => formatPersonnummer('640823-3235', AT_MIDSUMMER)).toThrow(ValidationError)
    expect(() => maskPersonnummer('nonsense', AT_MIDSUMMER)).toThrow(ValidationError)
  })
})

describe('personnummerLookupKey', () => {
  const PEPPER = Buffer.alloc(32, 1)

  test('🔑 pinned vector — a format change would orphan every stored key', () => {
    // If this fails, someone changed the prefix, the normalisation or the
    // encoding. Every user linked by personnummer would silently stop
    // matching. Do not "fix" the expected value — fix the code, or write a
    // migration that recomputes every key under a new version prefix.
    //
    // Pinned on the 12-digit form so the vector cannot depend on the clock:
    // a 10-digit form is only "1964" for as long as century inference says so.
    expect(personnummerLookupKey('196408233234', PEPPER, AT_MIDSUMMER)).toBe(
      '2a332fedbfbad70000a17f51e5417ed4dc7dff33b9fcf658a4941ba9a85a6fce'
    )
  })

  test('every written form of the same number gives the same key', () => {
    const keys = new Set(
      ['640823-3234', '6408233234', '19640823-3234', '196408233234'].map((form) =>
        personnummerLookupKey(form, PEPPER, AT_MIDSUMMER)
      )
    )
    expect(keys.size).toBe(1)
  })

  test('forwards referenceDate — a 10-digit form keys the person the clock says it is', () => {
    // At 23:30 on New Year's Eve in Stockholm, 260176-2392 is test
    // samordningsnummer 192601762392 (see the New Year test above).
    const lateEvening = { referenceDate: new Date('2025-12-31T22:30:00Z') }
    expect(personnummerLookupKey('260176-2392', PEPPER, lateEvening)).toBe(
      personnummerLookupKey('192601762392', PEPPER, lateEvening)
    )
  })

  test('a different pepper gives a different key — the secret is what protects it', () => {
    expect(personnummerLookupKey('196408233234', Buffer.alloc(32, 2), AT_MIDSUMMER)).not.toBe(
      personnummerLookupKey('196408233234', PEPPER, AT_MIDSUMMER)
    )
  })

  test('is 64 lowercase hex characters', () => {
    expect(personnummerLookupKey('191401682396', PEPPER, AT_MIDSUMMER)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('refuses a pepper shorter than 32 bytes', () => {
    expect(() => personnummerLookupKey('196408233234', Buffer.alloc(31, 1), AT_MIDSUMMER)).toThrow(
      'at least 32 bytes'
    )
  })

  test('🔑 refuses a pepper that is not bytes — even a long string', () => {
    // The trap: a string has no byteLength, so `undefined < 32` is false and a
    // length check alone lets it through — and createHmac takes string keys.
    // Wave 2 reads the pepper from env, where it arrives as text.
    const textPepper = 'x'.repeat(64) as unknown as Uint8Array
    expect(() => personnummerLookupKey('196408233234', textPepper, AT_MIDSUMMER)).toThrow('must be a Uint8Array')
    expect(() => personnummerLookupKey('196408233234', undefined as unknown as Uint8Array, AT_MIDSUMMER)).toThrow(
      'must be a Uint8Array'
    )
  })

  test('refuses an invalid number with a ValidationError', () => {
    expect(() => personnummerLookupKey('640823-3235', PEPPER, AT_MIDSUMMER)).toThrow(ValidationError)
  })
})

describe('organisationsnummer', () => {
  test.each([
    ['556703-7485', '5567037485', '556703-7485'],
    ['5567037485', '5567037485', '556703-7485'],
    ['202100-5448', '2021005448', '202100-5448'] // Skatteverket's own
  ])('%p is valid', (input, normalized, formatted) => {
    expect(isValidOrganisationsnummer(input)).toBe(true)
    expect(normalizeOrganisationsnummer(input)).toBe(normalized)
    expect(formatOrganisationsnummer(input)).toBe(formatted)
  })

  test('a personnummer is not an organisationsnummer — third digit < 2', () => {
    // Valid Luhn, but the third digit is the first digit of a month (0 or 1).
    expect(isValidOrganisationsnummer('640823-3234')).toBe(false)
  })

  test.each(['556703-7486', '556703-748', 'abc', '', '16556703-7485'])('%p is invalid', (input) => {
    expect(isValidOrganisationsnummer(input)).toBe(false)
  })

  test('normalize throws a ValidationError', () => {
    expect(() => normalizeOrganisationsnummer('556703-7486')).toThrow(ValidationError)
  })
})

// ─── Live: every number Skatteverket has published ─────────────────────────
//
// Calls Skatteverket's open-data API. Set SKIP_NETWORK_TESTS=1 to skip (CI does).
// This is how the samordningsnummer rules above were established: the Luhn
// digit is over day + 60, and some numbers carry month 00 / day 00 / 30 Feb.
const describeNetwork = process.env.SKIP_NETWORK_TESTS ? describe.skip : describe

const OPEN_DATA = 'https://skatteverket.entryscape.net/rowstore/dataset/'
const TEST_PERSONNUMMER = 'b4de7df7-63c0-4e7e-bb59-1f156a591763'
const TEST_SAMORDNINGSNUMMER = '9f29fe09-4dbc-4d2f-848f-7cffdd075383'

async function fetchDataset(id: string): Promise<string[]> {
  const numbers: string[] = []
  let url: string | undefined = `${OPEN_DATA}${id}/json?_limit=500&_offset=0`
  while (url) {
    // Only ever follow pagination links back to the same API.
    if (!url.startsWith(OPEN_DATA)) throw new Error('Unexpected pagination link')
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Skatteverket open data answered ${response.status}`)
    const page = (await response.json()) as { next?: string; results: Array<Record<string, string>> }
    for (const row of page.results) numbers.push(...Object.values(row))
    url = page.next
  }
  return numbers
}

describeNetwork('Skatteverket open test data (live)', () => {
  // The data set includes numbers born later THIS year — Skatteverket
  // publishes ahead — so "now" is set far enough out that none is FUTURE.
  const FAR_FUTURE = new Date('2099-12-31T12:00:00Z')

  test(
    'every published test personnummer parses as a personnummer',
    async () => {
      const numbers = await fetchDataset(TEST_PERSONNUMMER)
      expect(numbers.length).toBeGreaterThan(40_000)
      const failures = numbers.filter((n) => {
        const result = parsePersonnummer(n, { referenceDate: FAR_FUTURE })
        return !result.ok || result.value.kind !== 'personnummer' || result.value.birthDate === null
      })
      expect(failures).toEqual([])
    },
    120_000
  )

  test(
    'every published test samordningsnummer parses as a samordningsnummer',
    async () => {
      const numbers = await fetchDataset(TEST_SAMORDNINGSNUMMER)
      expect(numbers.length).toBeGreaterThan(2_000)
      const failures = numbers.filter((n) => {
        const result = parsePersonnummer(n, { referenceDate: FAR_FUTURE })
        return !result.ok || result.value.kind !== 'samordningsnummer'
      })
      expect(failures).toEqual([])
    },
    120_000
  )
})
