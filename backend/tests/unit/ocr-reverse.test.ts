// ocr-reverse.test.ts — from an OCR reference back to the invoice number.
//
// Wave 2 matches incoming Bankgirot payments to invoices with this. A wrong
// answer here is money booked against the wrong invoice, so the round trip
// is tested for every number in a realistic year, not a handful.

import { describe, test, expect } from 'bun:test'
import { invoiceNumberFromOcr, ocrReference, luhnCheckDigit } from '../../src/lib/ocr.ts'

describe('ocrReference — the documented example', () => {
  test('🔑 2026-0007 → 2026000709 (the doc comment used to say the check digit was 8)', () => {
    expect(ocrReference('2026-0007')).toBe('2026000709')
  })
})

describe('invoiceNumberFromOcr', () => {
  test('reverses the documented example', () => {
    expect(invoiceNumberFromOcr('2026000709')).toBe('2026-0007')
  })

  test('🔑 round trip for every invoice number 2026-0001 … 2026-12000', () => {
    // 12 000 covers the 4-digit range AND the switch to 5 digits at 10 000,
    // where the reference grows from 10 to 11 characters and the length
    // digit changes from 0 to 1.
    const mismatches: string[] = []
    for (let n = 1; n <= 12_000; n += 1) {
      const invoiceNumber = `2026-${String(n).padStart(4, '0')}`
      if (invoiceNumberFromOcr(ocrReference(invoiceNumber)) !== invoiceNumber) {
        mismatches.push(invoiceNumber)
      }
    }
    expect(mismatches).toEqual([])
  })

  test('accepts the maximum length, 25 digits', () => {
    const invoiceNumber = `2026-${'1'.repeat(19)}`
    const reference = ocrReference(invoiceNumber)
    expect(reference).toHaveLength(25)
    expect(invoiceNumberFromOcr(reference)).toBe(invoiceNumber)
  })

  test('rejects 26 digits — over Bankgirot\'s maximum', () => {
    const reference = ocrReference(`2026-${'1'.repeat(20)}`)
    expect(reference).toHaveLength(26)
    expect(invoiceNumberFromOcr(reference)).toBeNull()
  })

  test('rejects fewer than 10 digits — shorter than any reference we issue', () => {
    // A valid Bankgirot reference (length 9, length digit 9, Luhn OK), but
    // no invoice number of ours has fewer than 8 digits.
    const reference = ocrReference('2026-007')
    expect(reference).toHaveLength(9)
    expect(invoiceNumberFromOcr(reference)).toBeNull()
  })

  test('rejects a wrong length digit even when the Luhn digit is valid', () => {
    // Length digit 1 on a 10-character reference, check digit recomputed so
    // that ONLY the length check can catch it.
    const body = '202600071'
    const reference = `${body}${luhnCheckDigit(body)}`
    expect(invoiceNumberFromOcr(reference)).toBeNull()
  })

  test('rejects a wrong check digit', () => {
    expect(invoiceNumberFromOcr('2026000708')).toBeNull()
  })

  test.each(['', '2026-000709', ' 2026000709', '2026000709 ', '2026 000709', '２０２６０００７０９'])(
    '%p — only plain ASCII digits; the caller trims raw bank fields',
    (reference) => {
      expect(invoiceNumberFromOcr(reference)).toBeNull()
    }
  )

  test.each([
    ['2026-0000', 'all zeros — the series starts at 1'],
    ['2026-00000', 'all zeros, five digits'],
    ['2026-01234', 'a 5-digit sequence with a leading zero — we never pad past 4']
  ])('%p (%s) is a valid reference but not one of ours → null', (invoiceNumber) => {
    expect(invoiceNumberFromOcr(ocrReference(invoiceNumber))).toBeNull()
  })

  test('a 4-digit sequence with leading zeros is our normal spelling', () => {
    expect(invoiceNumberFromOcr(ocrReference('2026-0123'))).toBe('2026-0123')
  })

  describe('typos a payer makes', () => {
    // For these two references every variant below is rejected. That is
    // not a guarantee for every reference. Measured over all 12 000
    // references for 2026-0001 … 2026-12000, a single typo still yields
    // SOME candidate this often:
    //   deleted digit    ~0.03 % (0 for 10-digit references: 9 digits is
    //                    below our minimum; ~0.17 % for 11-digit ones)
    //   inserted digit   ~0.16 %
    //   swapped digits   ~0.76 % (mostly Luhn's blind spot, 09 <-> 90)
    // Rare, not impossible — which is why a non-null answer is only ever a
    // candidate (see the function's comment).
    const REFERENCES = [ocrReference('2026-0042'), ocrReference('2026-10042')]

    test('every single-digit substitution is rejected (Luhn catches all of these)', () => {
      for (const reference of REFERENCES) {
        for (let i = 0; i < reference.length; i += 1) {
          for (const digit of '0123456789') {
            if (digit === reference[i]) continue
            const typo = `${reference.slice(0, i)}${digit}${reference.slice(i + 1)}`
            expect(invoiceNumberFromOcr(typo)).toBeNull()
          }
        }
      }
    })

    test('a missing digit is rejected (the length digit is what catches it)', () => {
      for (const reference of REFERENCES) {
        for (let i = 0; i < reference.length; i += 1) {
          expect(invoiceNumberFromOcr(`${reference.slice(0, i)}${reference.slice(i + 1)}`)).toBeNull()
        }
      }
    })

    test('an extra digit is rejected', () => {
      for (const reference of REFERENCES) {
        for (let i = 0; i <= reference.length; i += 1) {
          for (const digit of '0123456789') {
            expect(invoiceNumberFromOcr(`${reference.slice(0, i)}${digit}${reference.slice(i)}`)).toBeNull()
          }
        }
      }
    })

    test('swapping two neighbouring digits is rejected', () => {
      for (const reference of REFERENCES) {
        for (let i = 0; i < reference.length - 1; i += 1) {
          if (reference[i] === reference[i + 1]) continue
          const swapped = `${reference.slice(0, i)}${reference[i + 1]}${reference[i]}${reference.slice(i + 2)}`
          expect(invoiceNumberFromOcr(swapped)).toBeNull()
        }
      }
    })
  })
})
