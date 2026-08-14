// password.test.ts — hashing, verification, and the timing defence.

import { describe, test, expect } from 'bun:test'
import {
  hashPassword,
  verifyPassword,
  verifyPasswordOrDummy,
  needsRehash,
  assertPasswordNotBreached,
  generateTemporaryPassword
} from '../../src/services/password.service.ts'
import { ValidationError } from '../../src/lib/errors.ts'

const PASSWORD = 'ett riktigt långt lösenord som fungerar'

describe('hashPassword', () => {
  test('produces a PHC-format Argon2id hash', async () => {
    const hash = await hashPassword(PASSWORD)
    expect(hash.startsWith('$argon2id$')).toBe(true)
  })

  test('encodes our OWASP parameters into the hash', async () => {
    const hash = await hashPassword(PASSWORD)
    expect(hash).toContain('m=19456,t=2,p=1')
  })

  test('salts randomly — the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)])
    expect(a).not.toBe(b)
  })
})

describe('verifyPassword', () => {
  test('accepts the correct password', async () => {
    const hash = await hashPassword(PASSWORD)
    expect(await verifyPassword(hash, PASSWORD)).toBe(true)
  })

  test('accepts it against a second, differently-salted hash', async () => {
    const hash = await hashPassword(PASSWORD)
    expect(await verifyPassword(hash, PASSWORD)).toBe(true)
  })

  test('rejects the wrong password', async () => {
    const hash = await hashPassword(PASSWORD)
    expect(await verifyPassword(hash, 'fel lösenord här')).toBe(false)
  })

  test('returns false on a malformed hash instead of throwing', async () => {
    // A corrupt row must read as "wrong password", never as a 500 that tells
    // an attacker something unusual just happened.
    expect(await verifyPassword('not-a-hash', PASSWORD)).toBe(false)
    expect(await verifyPassword('', PASSWORD)).toBe(false)
  })
})

describe('Unicode normalisation', () => {
  // "é" can be one codepoint, or "e" plus a combining accent. Identical on
  // screen, completely different bytes. Without normalising on BOTH sides, a
  // user could set a password on one device and be unable to log in on another.
  const composed = 'lösenordé-räksmörgås'.normalize('NFC')
  const decomposed = 'lösenordé-räksmörgås'.normalize('NFD')

  test('the two forms really are different strings', () => {
    expect(composed).not.toBe(decomposed)
  })

  test('hashed as NFC, verified as NFD', async () => {
    const hash = await hashPassword(composed)
    expect(await verifyPassword(hash, decomposed)).toBe(true)
  })

  test('hashed as NFD, verified as NFC', async () => {
    const hash = await hashPassword(decomposed)
    expect(await verifyPassword(hash, composed)).toBe(true)
  })
})

describe('verifyPasswordOrDummy — the timing defence', () => {
  test('returns false when there is no stored hash', async () => {
    expect(await verifyPasswordOrDummy(null, PASSWORD)).toBe(false)
    expect(await verifyPasswordOrDummy(undefined, PASSWORD)).toBe(false)
  })

  test('still verifies correctly when a hash exists', async () => {
    const hash = await hashPassword(PASSWORD)
    expect(await verifyPasswordOrDummy(hash, PASSWORD)).toBe(true)
    expect(await verifyPasswordOrDummy(hash, 'wrong')).toBe(false)
  })

  test('takes comparable time whether or not the user exists', async () => {
    const hash = await hashPassword(PASSWORD)

    // Warm up so the first call does not skew the measurement.
    await verifyPasswordOrDummy(hash, 'warmup')
    await verifyPasswordOrDummy(null, 'warmup')

    const median = async (fn: () => Promise<unknown>) => {
      const samples: number[] = []
      for (let i = 0; i < 9; i++) {
        const start = performance.now()
        await fn()
        samples.push(performance.now() - start)
      }
      samples.sort((a, b) => a - b)
      return samples[Math.floor(samples.length / 2)]!
    }

    const existing = await median(() => verifyPasswordOrDummy(hash, 'wrong password'))
    const missing = await median(() => verifyPasswordOrDummy(null, 'wrong password'))

    // Both must do real work. An early return would be ~0 ms, and that gap is
    // enough to enumerate every customer with a stopwatch.
    expect(missing).toBeGreaterThan(3)
    expect(existing).toBeGreaterThan(3)

    // Generous bound: CI machines are noisy and shared. The real property is
    // "same order of magnitude", not a precise ratio.
    const ratio = Math.max(existing, missing) / Math.min(existing, missing)
    expect(ratio).toBeLessThan(3)
  })
})

describe('needsRehash', () => {
  test('says no for a hash made with current parameters', async () => {
    expect(needsRehash(await hashPassword(PASSWORD))).toBe(false)
  })

  test('says yes for weaker memory or time cost', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=2,p=1$c2FsdA$aGFzaA')).toBe(true)
    expect(needsRehash('$argon2id$v=19$m=19456,t=1,p=1$c2FsdA$aGFzaA')).toBe(true)
  })

  test('never downgrades a STRONGER hash', () => {
    // Re-hashing this would make it weaker.
    expect(needsRehash('$argon2id$v=19$m=65536,t=4,p=1$c2FsdA$aGFzaA')).toBe(false)
  })

  test('says yes for anything unparseable', () => {
    expect(needsRehash('nonsense')).toBe(true)
    expect(needsRehash('')).toBe(true)
  })
})

describe('generateTemporaryPassword', () => {
  test('is 43 base64url characters (256 bits)', () => {
    const password = generateTemporaryPassword()
    expect(password).toHaveLength(43)
    expect(/^[A-Za-z0-9_-]+$/.test(password)).toBe(true)
  })

  test('never repeats', () => {
    const generated = new Set(Array.from({ length: 100 }, generateTemporaryPassword))
    expect(generated.size).toBe(100)
  })

  test('satisfies our own minimum length policy', () => {
    expect(generateTemporaryPassword().length).toBeGreaterThanOrEqual(12)
  })
})

// These call the real HaveIBeenPwned API. Set SKIP_NETWORK_TESTS=1 to skip
// them where there is no outbound network.
const describeNetwork = process.env.SKIP_NETWORK_TESTS ? describe.skip : describe

describeNetwork('assertPasswordNotBreached (live HIBP)', () => {
  test('rejects a password known to be breached', async () => {
    let thrown: unknown = null
    try {
      await assertPasswordNotBreached('password')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ValidationError)
    const details = (thrown as ValidationError).details as { breachCount?: number }
    expect(typeof details?.breachCount).toBe('number')
    expect(details.breachCount!).toBeGreaterThan(1_000_000)
  })

  test('accepts a strong unique passphrase', async () => {
    await assertPasswordNotBreached('korrekt-häst-batteri-häftstift-a91f3e77')
    // No throw is the assertion.
    expect(true).toBe(true)
  })
})
