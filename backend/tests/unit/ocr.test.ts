// ocr.test.ts — Luhn check digits and OCR references.

import { describe, test, expect } from 'bun:test'
import { luhnCheckDigit, isValidLuhn, ocrReference } from '../../src/lib/ocr.ts'

describe('luhnCheckDigit', () => {
  test('matches a known credit-card style example', () => {
    // 7992739871 has check digit 3 — the textbook Luhn example.
    expect(luhnCheckDigit('7992739871')).toBe(3)
  })

  test('matches a Swedish personnummer', () => {
    // 811218-987 + check digit 6 (Skatteverket's own documentation example).
    expect(luhnCheckDigit('811218987')).toBe(6)
  })

  test('rejects non-digits', () => {
    expect(() => luhnCheckDigit('12a4')).toThrow()
  })
})

describe('isValidLuhn', () => {
  test('accepts a correct number and rejects a single-digit typo', () => {
    expect(isValidLuhn('79927398713')).toBe(true)
    expect(isValidLuhn('79927398710')).toBe(false)
    expect(isValidLuhn('79927398793')).toBe(false)
  })

  test('rejects most neighbouring transpositions', () => {
    // 8116 -> 8161 (digits 2 and 3 swapped) — caught.
    expect(isValidLuhn('79927398713')).toBe(true)
    expect(isValidLuhn('79927389713')).toBe(false)
    // The famous Luhn blind spot: 09 <-> 90 is NOT caught. Worth knowing.
  })
})

describe('ocrReference', () => {
  test('🔑 is digits + length digit + check digit', () => {
    const ref = ocrReference('2026-0007')

    // 8 invoice digits, 1 length digit, 1 check digit = 10 characters.
    expect(ref).toHaveLength(10)
    expect(ref.startsWith('20260007')).toBe(true)
    // Length digit: 10 mod 10.
    expect(ref[8]).toBe('0')
    expect(isValidLuhn(ref)).toBe(true)
  })

  test('is deterministic — derived, never stored', () => {
    expect(ocrReference('2026-0007')).toBe(ocrReference('2026-0007'))
  })

  test('different invoices get different references', () => {
    expect(ocrReference('2026-0007')).not.toBe(ocrReference('2026-0008'))
  })

  test('a mistyped reference fails the bank-side check', () => {
    const ref = ocrReference('2026-0042')
    const typo = ref.slice(0, 5) + ((Number(ref[5]) + 1) % 10) + ref.slice(6)
    expect(isValidLuhn(typo)).toBe(false)
    // This is exactly what the customer's bank does before accepting the
    // payment — the typo is rejected at the keyboard.
  })

  test('refuses an invoice number with no digits at all', () => {
    expect(() => ocrReference('----')).toThrow()
  })
})
