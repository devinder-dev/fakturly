// money.test.ts — the arithmetic every invoice depends on.
//
// Pure functions, no database. These are the tests that must never be
// allowed to fail, because everything downstream trusts them silently.

import { describe, test, expect } from 'bun:test'
import {
  roundOre,
  calculateLine,
  sumLines,
  formatOre,
  calculateLateFee,
  VatRate
} from '../../src/lib/money.ts'

describe('the premise: floats lose money', () => {
  test('0.1 + 0.2 !== 0.3 in binary floating point', () => {
    expect(0.1 + 0.2).not.toBe(0.3)
    expect(0.1 + 0.2).toBe(0.30000000000000004)
  })

  test('but integer öre are always exact', () => {
    expect(10 + 20).toBe(30)
  })
})

describe('roundOre — half away from zero', () => {
  test('rounds positives half up', () => {
    expect(roundOre(0.5)).toBe(1)
    expect(roundOre(1.5)).toBe(2)
    expect(roundOre(0.4)).toBe(0)
  })

  test('rounds negatives half DOWN, unlike Math.round', () => {
    // Math.round(-0.5) is 0 — it rounds toward positive infinity.
    expect(Math.round(-0.5)).toBe(-0)
    expect(roundOre(-0.5)).toBe(-1)
    expect(roundOre(-1.5)).toBe(-2)
  })

  test('is symmetric, which is what makes credit notes cancel', () => {
    for (const value of [0.5, 1.5, 2.5, 8.25, 12.34, 999.5]) {
      expect(roundOre(-value)).toBe(-roundOre(value))
    }
  })
})

describe('calculateLine', () => {
  test('100,00 SEK at 25% VAT', () => {
    const line = calculateLine({ quantity: 1, unitPriceOre: 10_000, vatRate: VatRate.STANDARD })
    expect(line.netOre).toBe(10_000)
    expect(line.vatOre).toBe(2_500)
    expect(line.grossOre).toBe(12_500)
  })

  test('rounds VAT that lands between öre', () => {
    // 25% of 33 öre is 8.25 öre, and there is no such coin.
    const line = calculateLine({ quantity: 1, unitPriceOre: 33, vatRate: VatRate.STANDARD })
    expect(line.vatOre).toBe(8)
    expect(line.grossOre).toBe(line.netOre + line.vatOre)
  })

  test('quantities multiply exactly', () => {
    const line = calculateLine({ quantity: 7, unitPriceOre: 12_345, vatRate: VatRate.STANDARD })
    expect(line.netOre).toBe(86_415)
    expect(line.vatOre).toBe(21_604) // 21603.75 rounds up
  })

  test('zero-rated items carry no VAT', () => {
    const line = calculateLine({ quantity: 3, unitPriceOre: 50_000, vatRate: VatRate.ZERO })
    expect(line.vatOre).toBe(0)
    expect(line.grossOre).toBe(line.netOre)
  })

  test('gross is always exactly net + vat', () => {
    for (const rate of Object.values(VatRate)) {
      for (const price of [1, 33, 99, 12_345, 1_000_000]) {
        const line = calculateLine({ quantity: 3, unitPriceOre: price, vatRate: rate })
        expect(line.grossOre).toBe(line.netOre + line.vatOre)
      }
    }
  })
})

describe('sumLines', () => {
  test('handles mixed VAT rates on one invoice', () => {
    const lines = [
      calculateLine({ quantity: 10, unitPriceOre: 100_000, vatRate: VatRate.STANDARD }),
      calculateLine({ quantity: 3, unitPriceOre: 24_900, vatRate: VatRate.REDUCED_6 }),
      calculateLine({ quantity: 2, unitPriceOre: 15_000, vatRate: VatRate.REDUCED_12 }),
      calculateLine({ quantity: 1, unitPriceOre: 50_000, vatRate: VatRate.ZERO })
    ]
    const totals = sumLines(lines)

    expect(totals.netTotalOre).toBe(1_000_000 + 74_700 + 30_000 + 50_000)
    expect(totals.vatTotalOre).toBe(250_000 + 4_482 + 3_600 + 0)
    expect(totals.grossTotalOre).toBe(totals.netTotalOre + totals.vatTotalOre)
  })

  test('the total equals the sum of the line grosses', () => {
    const lines = [33, 67, 199, 12_345].map((price) =>
      calculateLine({ quantity: 1, unitPriceOre: price, vatRate: VatRate.STANDARD })
    )
    const totals = sumLines(lines)
    const sumOfGross = lines.reduce((sum, line) => sum + line.grossOre, 0)

    expect(totals.grossTotalOre).toBe(sumOfGross)
  })

  test('an empty invoice totals zero', () => {
    expect(sumLines([])).toEqual({ netTotalOre: 0, vatTotalOre: 0, grossTotalOre: 0 })
  })

  test('per-line rounding genuinely differs from total-first rounding', () => {
    // Three lines of 33 öre at 25%: per-line gives 8+8+8 = 24.
    // Rounding the total instead: 25% of 99 = 24.75 -> 25.
    const lines = Array.from({ length: 3 }, () =>
      calculateLine({ quantity: 1, unitPriceOre: 33, vatRate: VatRate.STANDARD })
    )
    const perLine = sumLines(lines).vatTotalOre
    const totalFirst = roundOre((99 * 2500) / 10_000)

    expect(perLine).toBe(24)
    expect(totalFirst).toBe(25)
    expect(perLine).not.toBe(totalFirst)
    // We use per-line, so the figures printed on each row add up to the
    // figure printed as the total.
  })
})

describe('credit notes', () => {
  test('cancel the original exactly, including VAT', () => {
    const original = calculateLine({ quantity: 3, unitPriceOre: 33, vatRate: VatRate.STANDARD })
    const credit = calculateLine({ quantity: -3, unitPriceOre: 33, vatRate: VatRate.STANDARD })

    expect(original.netOre + credit.netOre).toBe(0)
    expect(original.vatOre + credit.vatOre).toBe(0)
    expect(original.grossOre + credit.grossOre).toBe(0)
  })

  test('cancel across a whole invoice', () => {
    const inputs = [
      { quantity: 2, unitPriceOre: 4_999, vatRate: VatRate.STANDARD },
      { quantity: 7, unitPriceOre: 333, vatRate: VatRate.REDUCED_6 }
    ]
    const original = sumLines(inputs.map(calculateLine))
    const credit = sumLines(inputs.map((i) => calculateLine({ ...i, quantity: -i.quantity })))

    expect(original.grossTotalOre + credit.grossTotalOre).toBe(0)
  })
})

describe('formatOre', () => {
  // U+00A0 non-breaking space — see the NBSP constant in money.ts.
  const S = ' '

  test('formats whole and fractional öre', () => {
    expect(formatOre(12_500)).toBe(`125,00${S}SEK`)
    expect(formatOre(5)).toBe(`0,05${S}SEK`)
    expect(formatOre(0)).toBe(`0,00${S}SEK`)
  })

  test('groups thousands', () => {
    expect(formatOre(1_234_567)).toBe(`12${S}345,67${S}SEK`)
    expect(formatOre(100_000_000)).toBe(`1${S}000${S}000,00${S}SEK`)
  })

  test('keeps the sign', () => {
    expect(formatOre(-12_500)).toBe(`-125,00${S}SEK`)
  })

  test('accepts another currency', () => {
    expect(formatOre(12_500, 'EUR')).toBe(`125,00${S}EUR`)
  })

  test('uses a non-breaking space, not a regular one', () => {
    // This is not pedantry: a regular space lets a renderer split
    // "12 345,67 SEK" across a line break, turning one figure into two.
    expect(formatOre(1_234_567)).not.toContain(' ')
    expect(formatOre(1_234_567)).toContain(S)
  })

  test('matches what Intl produces for sv-SE', () => {
    expect(new Intl.NumberFormat('sv-SE').format(12345)).toContain(S)
  })
})

describe('calculateLateFee', () => {
  test('applies a percentage of the gross total', () => {
    expect(calculateLateFee(12_500, 1000)).toBe(1_250) // 10%
    expect(calculateLateFee(100_000, 800)).toBe(8_000) // 8%
  })

  test('rounds to whole öre', () => {
    expect(calculateLateFee(33, 800)).toBe(3) // 2.64 -> 3
  })

  test('is zero at a zero rate', () => {
    expect(calculateLateFee(999_999, 0)).toBe(0)
  })
})
