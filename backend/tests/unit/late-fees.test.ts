// late-fees.test.ts — Swedish statutory late payment interest.
//
// Räntelagen (1975:635) § 6: referensränta + 8 percentage points per year,
// accruing from the due date.

import { describe, test, expect } from 'bun:test'
import {
  calculateLateInterest,
  daysBetween,
  REFERENCE_RATE_BASIS_POINTS,
  LATE_INTEREST_MARKUP_BASIS_POINTS,
  REMINDER_FEE_ORE,
  formatOre
} from '../../src/lib/money.ts'

describe('the statutory rate', () => {
  test('is the reference rate plus 8 percentage points', () => {
    expect(LATE_INTEREST_MARKUP_BASIS_POINTS).toBe(800)
    const total = REFERENCE_RATE_BASIS_POINTS + LATE_INTEREST_MARKUP_BASIS_POINTS
    expect(total).toBe(1000) // 10.00% at a 2% reference rate
  })

  test('the statutory reminder fee is 60 SEK', () => {
    expect(REMINDER_FEE_ORE).toBe(6_000)
    expect(formatOre(REMINDER_FEE_ORE)).toContain('60,00')
  })
})

describe('calculateLateInterest', () => {
  test('is zero before the due date', () => {
    expect(calculateLateInterest(1_250_000, 0)).toBe(0)
    expect(calculateLateInterest(1_250_000, -5)).toBe(0)
  })

  test('accrues per day', () => {
    // 12 500,00 SEK at 10% annual = 1 250,00 per year = ~3,42 per day
    const oneDay = calculateLateInterest(1_250_000, 1)
    expect(oneDay).toBe(342) // 3,42 SEK

    const thirtyDays = calculateLateInterest(1_250_000, 30)
    expect(thirtyDays).toBe(10_274) // 102,74 SEK
  })

  test('🔑 grows with the delay — which a flat percentage does not', () => {
    const day30 = calculateLateInterest(1_250_000, 30)
    const day400 = calculateLateInterest(1_250_000, 400)

    expect(day400).toBeGreaterThan(day30)
    // A flat 10% would charge 1 250,00 whether they were one day late or two
    // years late. That is a penalty, not interest.
    expect(day400).toBeGreaterThan(day30 * 10)
  })

  test('a full year equals the annual rate', () => {
    const yearly = calculateLateInterest(1_000_000, 365)
    // 10 000,00 at 10% = 1 000,00
    expect(yearly).toBe(100_000)
  })

  test('scales with the outstanding amount, up to rounding', () => {
    const small = calculateLateInterest(100_000, 30) // 821.92 -> 822
    const large = calculateLateInterest(1_000_000, 30) // 8219.18 -> 8219

    expect(small).toBe(822)
    expect(large).toBe(8_219)

    // NOT exactly small * 10. Rounding does not distribute over
    // multiplication: rounding once at 8219.18 is not the same as rounding at
    // 821.92 and multiplying the result. The difference is an öre, and it is
    // the correct answer — the interest is computed on the actual balance,
    // not extrapolated from a smaller one.
    expect(large).not.toBe(small * 10)
    expect(Math.abs(large - small * 10)).toBeLessThanOrEqual(10)
  })

  test('returns whole öre', () => {
    for (const amount of [33, 999, 12_345, 9_999_999]) {
      for (const days of [1, 7, 30, 365]) {
        expect(Number.isInteger(calculateLateInterest(amount, days))).toBe(true)
      }
    }
  })

  test('is zero on a zero or negative balance', () => {
    expect(calculateLateInterest(0, 30)).toBe(0)
    expect(calculateLateInterest(-1000, 30)).toBe(0)
  })

  test('accepts a different reference rate — it changes twice a year', () => {
    const atTwo = calculateLateInterest(1_000_000, 365, 200)
    const atFour = calculateLateInterest(1_000_000, 365, 400)

    expect(atTwo).toBe(100_000) // 10%
    expect(atFour).toBe(120_000) // 12%
  })

  test('stays exact on a very large invoice', () => {
    // 10 million SEK, a year late. Well inside safe integer range, but this
    // is where an implementation that multiplied before dividing would drift.
    const result = calculateLateInterest(1_000_000_000, 365)
    expect(result).toBe(100_000_000)
    expect(Number.isSafeInteger(result)).toBe(true)
  })
})

describe('daysBetween', () => {
  test('counts whole days', () => {
    const due = new Date('2026-01-01T00:00:00Z')
    expect(daysBetween(due, new Date('2026-01-01T00:00:00Z'))).toBe(0)
    expect(daysBetween(due, new Date('2026-01-02T00:00:00Z'))).toBe(1)
    expect(daysBetween(due, new Date('2026-01-31T00:00:00Z'))).toBe(30)
  })

  test('floors a partial day', () => {
    const due = new Date('2026-01-01T00:00:00Z')
    expect(daysBetween(due, new Date('2026-01-01T23:59:00Z'))).toBe(0)
    // Interest starts the day AFTER the due date, not the same afternoon.
  })

  test('never goes negative', () => {
    const due = new Date('2026-06-01T00:00:00Z')
    expect(daysBetween(due, new Date('2026-01-01T00:00:00Z'))).toBe(0)
  })

  test('handles a leap day', () => {
    expect(
      daysBetween(new Date('2028-02-28T00:00:00Z'), new Date('2028-03-01T00:00:00Z'))
    ).toBe(2)
  })
})
