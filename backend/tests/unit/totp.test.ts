// totp.test.ts — HOTP/TOTP against the RFC test vectors, base32 against
// RFC 4648, and the verification rules (window, replay, format).
//
// The RFC vectors are the reason a hand-rolled TOTP is acceptable: if all
// of them pass, the implementation computes what every authenticator app
// computes.

import { describe, test, expect } from 'bun:test'
import {
  base32Decode,
  base32Encode,
  generateTotp,
  generateTotpSecret,
  hotp,
  totpStep,
  totpUri,
  verifyTotp,
  TOTP_SECRET_BYTES
} from '../../src/lib/totp.ts'

// RFC 4226 App. D and RFC 6238 App. B (SHA1): the ASCII string "12345678901234567890".
const RFC_SECRET = Buffer.from('12345678901234567890')

describe('hotp — RFC 4226 Appendix D', () => {
  // [count, truncated decimal, 6-digit HOTP] exactly as printed in the RFC.
  const VECTORS: Array<[number, number, string]> = [
    [0, 1284755224, '755224'],
    [1, 1094287082, '287082'],
    [2, 137359152, '359152'],
    [3, 1726969429, '969429'],
    [4, 1640338314, '338314'],
    [5, 868254676, '254676'],
    [6, 1918287922, '287922'],
    [7, 82162583, '162583'],
    [8, 673399871, '399871'],
    [9, 645520489, '520489']
  ]

  test.each(VECTORS)('count %p → %p → %p', (count, _decimal, expected) => {
    expect(hotp(RFC_SECRET, count)).toBe(expected)
  })

  test.each(VECTORS)('count %p, 8 digits = the RFC decimal mod 10^8', (count, decimal) => {
    // Proves the truncation itself, not just its last six digits.
    expect(hotp(RFC_SECRET, count, 8)).toBe(String(decimal % 100_000_000).padStart(8, '0'))
  })
})

describe('generateTotp — RFC 6238 Appendix B (SHA1 rows)', () => {
  // [Unix seconds, T as printed (hex), 8-digit TOTP]
  const VECTORS: Array<[number, string, string]> = [
    [59, '0000000000000001', '94287082'],
    [1111111109, '00000000023523EC', '07081804'],
    [1111111111, '00000000023523ED', '14050471'],
    [1234567890, '000000000273EF07', '89005924'],
    [2000000000, '0000000003F940AA', '69279037'],
    [20000000000, '0000000027BC86AA', '65353130'] // year 2603: Unix time past 32 bits
  ]

  test.each(VECTORS)('t=%p → T=%p → %p', (seconds, stepHex, expected) => {
    expect(totpStep(seconds * 1000)).toBe(Number.parseInt(stepHex, 16))
    expect(generateTotp({ secret: RFC_SECRET, nowMs: seconds * 1000, digits: 8 })).toBe(expected)
  })

  test('the step changes exactly on the 30-second boundary', () => {
    // RFC 6238 §4: "T = 1 if the current Unix time is 59 seconds, and T = 2
    // if the current Unix time is 60 seconds."
    expect(totpStep(59_999)).toBe(1)
    expect(totpStep(60_000)).toBe(2)
  })
})

describe('hotp — traps', () => {
  test('🔑 counter 2^32 is not counter 0 — the counter is 64 bits, not 32', () => {
    // A 32-bit implementation (`counter >>> 0`) wraps 2^32 to 0 and gives
    // both the same code.
    expect(hotp(RFC_SECRET, 2 ** 32)).not.toBe(hotp(RFC_SECRET, 0))
  })

  test('number and bigint counters agree', () => {
    expect(hotp(RFC_SECRET, 2n ** 40n)).toBe(hotp(RFC_SECRET, 2 ** 40))
  })

  test.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('refuses counter %p', (counter) => {
    expect(() => hotp(RFC_SECRET, counter)).toThrow('non-negative safe integer')
  })

  test('refuses a counter past 64 bits', () => {
    expect(() => hotp(RFC_SECRET, 2n ** 64n)).toThrow('64 bits')
  })

  test('refuses a secret shorter than 128 bits (RFC 4226 R6)', () => {
    expect(() => hotp(Buffer.alloc(15, 1), 0)).toThrow('at least 16 bytes')
  })

  test.each([5, 9])('refuses %p digits', (digits) => {
    expect(() => hotp(RFC_SECRET, 0, digits)).toThrow('6, 7 or 8')
  })
})

describe('base32 — RFC 4648 §10', () => {
  const VECTORS: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======']
  ]

  test.each(VECTORS)('%p ⇄ %p', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded)
    expect(base32Decode(encoded).toString()).toBe(plain)
  })

  test.each(VECTORS)('%p decodes without padding and in lower case too', (plain, encoded) => {
    expect(base32Decode(encoded.replace(/=/g, '')).toString()).toBe(plain)
    expect(base32Decode(encoded.toLowerCase()).toString()).toBe(plain)
  })

  test('padding can be switched off — the Key URI format omits it', () => {
    expect(base32Encode(Buffer.from('foobar'), { padding: false })).toBe('MZXW6YTBOI')
  })

  test.each([
    ['MY1=====', 'unexpected character'], // 1 is not in the alphabet
    ['MZ XW', 'unexpected character'],
    ['M', 'impossible length'],
    ['MZX', 'impossible length'],
    ['MZXW6Y', 'impossible length'],
    ['MY=', 'wrong padding'],
    ['MZXW6YTB========', 'wrong padding'],
    ['MZ', 'non-zero trailing bits'], // canonical is MY; MZ sets a bit that encodes nothing
    // Unicode look-alikes that toUpperCase() would turn into ASCII:
    ['MZXW6YTBOı', 'unexpected character'], // dotless ı → I
    ['MZXW6Yß', 'unexpected character'], // ß → SS
    ['MZXW6YTBOſ', 'unexpected character'] // long s → S
  ])('%p is refused (%s)', (input, message) => {
    expect(() => base32Decode(input)).toThrow(message)
  })

  test('a generated secret survives the round trip', () => {
    const secret = generateTotpSecret()
    expect(base32Decode(base32Encode(secret))).toEqual(secret)
  })
})

describe('generateTotpSecret', () => {
  test('is 160 bits (RFC 4226 R6 recommends 160)', () => {
    expect(generateTotpSecret()).toHaveLength(TOTP_SECRET_BYTES)
    expect(TOTP_SECRET_BYTES * 8).toBe(160)
  })

  test('never repeats', () => {
    const secrets = new Set(Array.from({ length: 100 }, () => generateTotpSecret().toString('hex')))
    expect(secrets.size).toBe(100)
  })
})

describe('verifyTotp', () => {
  // 2026-06-15 10:00:00 UTC, exactly on a step boundary.
  const NOW = Date.UTC(2026, 5, 15, 10, 0, 0)
  const STEP = totpStep(NOW)
  const codeAt = (step: number) => hotp(RFC_SECRET, step)

  test('accepts the current code and returns its step', () => {
    expect(verifyTotp({ secret: RFC_SECRET, code: codeAt(STEP), nowMs: NOW })).toEqual({ ok: true, step: STEP })
  })

  test('accepts the code as the app displays it, "123 456"', () => {
    const code = codeAt(STEP)
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`
    expect(verifyTotp({ secret: RFC_SECRET, code: spaced, nowMs: NOW }).ok).toBe(true)
  })

  test('window 1 accepts one step either side, and reports which', () => {
    expect(verifyTotp({ secret: RFC_SECRET, code: codeAt(STEP - 1), nowMs: NOW })).toEqual({ ok: true, step: STEP - 1 })
    expect(verifyTotp({ secret: RFC_SECRET, code: codeAt(STEP + 1), nowMs: NOW })).toEqual({ ok: true, step: STEP + 1 })
  })

  test('two steps away is MISMATCH with the default window', () => {
    expect(verifyTotp({ secret: RFC_SECRET, code: codeAt(STEP - 2), nowMs: NOW })).toEqual({ ok: false, reason: 'MISMATCH' })
    expect(verifyTotp({ secret: RFC_SECRET, code: codeAt(STEP + 2), nowMs: NOW })).toEqual({ ok: false, reason: 'MISMATCH' })
  })

  test('window 0 accepts only the current step', () => {
    expect(verifyTotp({ secret: RFC_SECRET, code: codeAt(STEP - 1), nowMs: NOW, window: 0 }).ok).toBe(false)
  })

  test.each([3, -1, 0.5])('refuses window %p', (window) => {
    expect(() => verifyTotp({ secret: RFC_SECRET, code: codeAt(STEP), nowMs: NOW, window })).toThrow('window')
  })

  test.each(['', '12345', '1234567', 'abcdef', '12345a', '１２３４５６'])('%p → FORMAT', (code) => {
    // Full-width digits fail too: \d is ASCII-only without the u flag.
    expect(verifyTotp({ secret: RFC_SECRET, code, nowMs: NOW })).toEqual({ ok: false, reason: 'FORMAT' })
  })

  test('a wrong code of the right shape is MISMATCH, not FORMAT', () => {
    const wrong = codeAt(STEP) === '000000' ? '000001' : '000000'
    expect(verifyTotp({ secret: RFC_SECRET, code: wrong, nowMs: NOW })).toEqual({ ok: false, reason: 'MISMATCH' })
  })

  describe('replay (RFC 6238 §5.2)', () => {
    test('the same code twice: the second attempt is REPLAY', () => {
      const first = verifyTotp({ secret: RFC_SECRET, code: codeAt(STEP), nowMs: NOW })
      expect(first.ok).toBe(true)
      const lastUsedStep = first.ok ? first.step : null
      expect(verifyTotp({ secret: RFC_SECRET, code: codeAt(STEP), nowMs: NOW + 5_000, lastUsedStep })).toEqual({
        ok: false,
        reason: 'REPLAY'
      })
    })

    test('an older code still inside the window is REPLAY once a newer one was used', () => {
      expect(verifyTotp({ secret: RFC_SECRET, code: codeAt(STEP - 1), nowMs: NOW, lastUsedStep: STEP })).toEqual({
        ok: false,
        reason: 'REPLAY'
      })
    })

    test('the next step’s code is fine', () => {
      expect(verifyTotp({ secret: RFC_SECRET, code: codeAt(STEP + 1), nowMs: NOW + 30_000, lastUsedStep: STEP })).toEqual({
        ok: true,
        step: STEP + 1
      })
    })

    test('null lastUsedStep (never used) is the same as none', () => {
      expect(verifyTotp({ secret: RFC_SECRET, code: codeAt(STEP), nowMs: NOW, lastUsedStep: null }).ok).toBe(true)
    })

    test('lastUsedStep 0 still counts — `!= null`, not truthiness', () => {
      expect(verifyTotp({ secret: RFC_SECRET, code: codeAt(0), nowMs: 0, lastUsedStep: 0 })).toEqual({
        ok: false,
        reason: 'REPLAY'
      })
    })

    test.each([Number.NaN, 1.5, Number.POSITIVE_INFINITY])(
      '🔑 lastUsedStep %p throws instead of switching replay detection off',
      (lastUsedStep) => {
        // `step <= NaN` is false: unchecked, a corrupt stored value would let
        // the same code in twice.
        expect(() => verifyTotp({ secret: RFC_SECRET, code: codeAt(STEP), nowMs: NOW, lastUsedStep })).toThrow(
          'lastUsedStep must be a safe integer'
        )
      }
    )

    test('🔑 one code valid in two adjacent steps: the HIGHER step is recorded', () => {
      // Found by search and checked here: under the RFC secret, steps
      // 59061240 and 59061241 (2026-02-23 09:00–09:01 UTC) both give 963181.
      // About one adjacent pair in a million collides like this.
      const LOW = 59061240
      expect(hotp(RFC_SECRET, LOW)).toBe('963181')
      expect(hotp(RFC_SECRET, LOW + 1)).toBe('963181')

      const nowMs = LOW * 30_000 + 15_000 // inside LOW: the window covers LOW-1 … LOW+1
      const first = verifyTotp({ secret: RFC_SECRET, code: '963181', nowMs })
      expect(first).toEqual({ ok: true, step: LOW + 1 })

      // Had LOW been recorded, this second submission would match LOW+1 > LOW
      // and be accepted again. With LOW+1 recorded, both matches are ≤ it.
      expect(verifyTotp({ secret: RFC_SECRET, code: '963181', nowMs, lastUsedStep: LOW + 1 })).toEqual({
        ok: false,
        reason: 'REPLAY'
      })
    })

    test('a server clock behind lastUsedStep fails safe: REPLAY until time catches up', () => {
      expect(verifyTotp({ secret: RFC_SECRET, code: codeAt(STEP), nowMs: NOW, lastUsedStep: STEP + 10 })).toEqual({
        ok: false,
        reason: 'REPLAY'
      })
    })
  })

  test('an authenticator app 20 seconds slow still works', () => {
    const appCode = generateTotp({ secret: RFC_SECRET, nowMs: NOW - 20_000 })
    expect(verifyTotp({ secret: RFC_SECRET, code: appCode, nowMs: NOW }).ok).toBe(true)
  })
})

describe('totpUri', () => {
  test('matches the Key URI format exactly', () => {
    expect(totpUri({ secret: RFC_SECRET, issuer: 'Fakturly Demo', accountName: 'anna@exempel.se' })).toBe(
      'otpauth://totp/Fakturly%20Demo:anna%40exempel.se' +
        '?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Fakturly%20Demo&algorithm=SHA1&digits=6&period=30'
    )
  })

  test('🔑 a space is %20, never "+" — apps would show "Fakturly+Demo"', () => {
    const uri = totpUri({ secret: RFC_SECRET, issuer: 'Fakturly Demo', accountName: 'anna@exempel.se' })
    expect(uri).not.toContain('+')
    // The trap it avoids:
    expect(new URLSearchParams({ issuer: 'Fakturly Demo' }).toString()).toBe('issuer=Fakturly+Demo')
  })

  test('the secret is unpadded base32 and decodes back', () => {
    const secret = generateTotpSecret()
    const uri = totpUri({ secret, issuer: 'Fakturly', accountName: 'anna@exempel.se' })
    const encoded = /[?&]secret=([^&]+)/.exec(uri)?.[1] ?? ''
    expect(encoded).not.toContain('=')
    expect(base32Decode(encoded)).toEqual(secret)
  })

  test.each([
    ['issuer', { issuer: 'Fakturly:AB', accountName: 'anna@exempel.se' }],
    ['accountName', { issuer: 'Fakturly', accountName: 'anna:b@exempel.se' }],
    ['issuer', { issuer: '', accountName: 'anna@exempel.se' }]
  ])('refuses a %s with a colon or nothing in it', (field, names) => {
    expect(() => totpUri({ secret: RFC_SECRET, ...names })).toThrow(`${field} must be non-empty`)
  })

  test('the error names the field, never the value — an account name is an email', () => {
    let message = ''
    try {
      totpUri({ secret: RFC_SECRET, issuer: 'Fakturly', accountName: 'anna:b@exempel.se' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('exempel')
  })
})
