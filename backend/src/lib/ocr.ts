// ocr.ts — Swedish payment references (OCR-nummer).
//
// When a customer pays a Swedish invoice through their bank, they type a
// reference number. The bank validates it BEFORE the payment goes through,
// which is why a mistyped reference is rejected at the keyboard instead of
// arriving as money nobody can match to an invoice.
//
// That validation is the Luhn algorithm (modulus 10), the same check digit
// scheme behind Swedish personnummer and every credit card number. Bankgirot
// adds one more digit in front of the check digit: the LENGTH of the whole
// reference, mod 10. Together they catch every single-digit typo and almost
// every transposition of two neighbouring digits.
//
// Pure functions on strings of digits. No database, no dates — trivially
// testable, and nothing here can round or lose an öre because nothing here
// is money.

/**
 * Luhn check digit for a string of digits.
 *
 * Walking from the RIGHT, every second digit is doubled, and a doubled value
 * above 9 has its digits summed (which is the same as subtracting 9). The
 * check digit is whatever brings the total to a multiple of ten.
 */
export function luhnCheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) {
    throw new Error('Luhn input must be digits only')
  }

  let sum = 0
  // The check digit will occupy the rightmost position, so the digit
  // immediately left of it is the first to be doubled.
  let double = true

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i])
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }

  return (10 - (sum % 10)) % 10
}

/** True when the last digit is a valid Luhn check digit for the rest. */
export function isValidLuhn(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false
  const body = digits.slice(0, -1)
  const check = Number(digits.at(-1))
  return luhnCheckDigit(body) === check
}

/**
 * Builds an OCR reference from an invoice number.
 *
 * "2026-0007" becomes 20260007, then a length digit, then a Luhn check digit:
 *
 *   20260007        the invoice number's digits
 *   2026000 7 0     + length digit: the full reference is 10 characters, 10 mod 10 = 0
 *   2026000 7 0 8   + Luhn check digit over everything before it
 *
 * The length digit is Bankgirot's "hård kontroll" variant. With it, the bank
 * also rejects a reference with a digit missing or added — which is the
 * error a person actually makes when copying a number by hand.
 *
 * Deterministic on purpose: the reference is derived from the invoice number
 * every time rather than stored, so it cannot disagree with itself.
 */
export function ocrReference(invoiceNumber: string): string {
  const digits = invoiceNumber.replace(/\D/g, '')
  if (digits.length === 0) {
    throw new Error(`Cannot build an OCR reference from "${invoiceNumber}"`)
  }

  // +2 for the length digit itself and the check digit that follows it.
  const lengthDigit = (digits.length + 2) % 10
  const withLength = `${digits}${lengthDigit}`

  return `${withLength}${luhnCheckDigit(withLength)}`
}
