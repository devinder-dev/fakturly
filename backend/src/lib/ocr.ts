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
 *   202600070       + length digit: the full reference is 10 characters, 10 mod 10 = 0
 *   2026000709      + Luhn check digit over everything before it
 *
 * (tests/unit/ocr-reverse.test.ts pins this exact value, so this comment and
 * the code cannot drift apart again — an earlier version claimed 8.)
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

/**
 * The reverse of ocrReference: from the reference a payer typed at their
 * bank (or that arrives in a Bankgirot file) back to the invoice number it
 * was built from. Null when it cannot be one of our references.
 *
 * Possible without a database because ocrReference loses nothing: the only
 * non-digit in an invoice number is the dash, and it always follows the
 * 4-digit year. So: verify, strip the length and check digits, put the
 * dash back.
 *
 * Rules (Bankgirot, OCR-referenskontroll: "Enbart siffror godkänns",
 * "minst 2 tecken men max 25 tecken", length digit second to last,
 * modulus-10 check digit last —
 * https://www.bankgirot.se/tjanster/inbetalningar/bankgiro-inbetalningar/ocr-referenskontroll/):
 *   - digits only, 10–25 of them. 10 because our shortest invoice number
 *     (2026-0001) has 8 digits; 25 is Bankgirot's maximum.
 *   - the length digit equals the length mod 10
 *   - the Luhn check digit is valid
 *
 * Strict on purpose: no trimming, no stripping of spaces. The caller decides
 * what a raw bank field may contain; this function only answers "is this
 * exact string one of ours?".
 *
 * A non-null result is a CANDIDATE, not a match. It may name an invoice that
 * does not exist, belongs to another tenant, or is a credit note (credit
 * notes share the number series). The payment matcher must still look the
 * invoice up and compare amounts.
 */
export function invoiceNumberFromOcr(reference: string): string | null {
  if (!/^\d{10,25}$/.test(reference)) return null

  const lengthDigit = Number(reference.at(-2))
  if (lengthDigit !== reference.length % 10) return null

  if (!isValidLuhn(reference)) return null

  const digits = reference.slice(0, -2)
  return `${digits.slice(0, 4)}-${digits.slice(4)}`
}
