// money.ts — every calculation involving money lives here.
//
// One file, so there is exactly one place to audit when the numbers are
// wrong. Nothing in this file touches the database, HTTP, or anything else —
// it is pure arithmetic on integers, which makes it trivially testable.
//
// THE RULES:
//   - Amounts are integer öre. Never a float, never parseFloat.
//   - VAT rates are basis points. 2500 = 25.00%.
//   - Rounding is explicit, documented, and happens in exactly one function.

/** Swedish VAT rates, in basis points. */
export const VatRate = {
  /** Standard — most goods and services */
  STANDARD: 2500, // 25%
  /** Food, restaurants, hotels */
  REDUCED_12: 1200, // 12%
  /** Books, newspapers, passenger transport, cultural events */
  REDUCED_6: 600, // 6%
  /** Exempt — e.g. certain healthcare, education, financial services */
  ZERO: 0
} as const

export const VALID_VAT_RATES: readonly number[] = Object.values(VatRate)

export type LineInput = {
  quantity: number
  unitPriceOre: number
  /** Basis points. 2500 = 25.00% */
  vatRate: number
}

export type CalculatedLine = {
  netOre: number
  vatOre: number
  grossOre: number
}

/**
 * Rounds a VAT amount to whole öre.
 *
 * WHY THIS IS ITS OWN FUNCTION: rounding is where money quietly disappears.
 * Isolating it means there is one line to point at when an accountant asks
 * how a figure was reached, and one line to change if the rule ever does.
 *
 * We round half away from zero — 0.5 öre becomes 1 öre, -0.5 becomes -1.
 * Math.round() alone rounds -0.5 to 0 (it rounds half UP, toward positive
 * infinity), which would make a credit note and its original invoice fail to
 * cancel out by one öre. That asymmetry is exactly the kind of bug that
 * surfaces months later as a ledger that will not balance.
 */
export function roundOre(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/**
 * Calculates one invoice line.
 *
 * netOre is exact: two integers multiplied.
 * vatOre needs rounding, because 25% of 33 öre is 8.25 öre and there is no
 * such coin.
 */
export function calculateLine(line: LineInput): CalculatedLine {
  const netOre = line.quantity * line.unitPriceOre
  const vatOre = roundOre((netOre * line.vatRate) / 10_000)

  return {
    netOre,
    vatOre,
    grossOre: netOre + vatOre
  }
}

export type InvoiceTotals = {
  netTotalOre: number
  vatTotalOre: number
  grossTotalOre: number
}

/**
 * Sums calculated lines into invoice totals.
 *
 * IMPORTANT — the order of rounding is a real decision, not an implementation
 * detail. We round each LINE's VAT and then sum those, rather than summing
 * the net and applying VAT once at the end. The two can differ by an öre or
 * two on a long invoice.
 *
 * Per-line rounding is chosen because it is what the printed invoice shows.
 * Each line displays its own VAT, and those displayed figures must add up to
 * the stated total — otherwise the document visibly does not sum, which is
 * the first thing anyone checking it will notice.
 *
 * Skatteverket permits either method; what it does not permit is switching
 * between them.
 */
export function sumLines(lines: readonly CalculatedLine[]): InvoiceTotals {
  let netTotalOre = 0
  let vatTotalOre = 0

  for (const line of lines) {
    netTotalOre += line.netOre
    vatTotalOre += line.vatOre
  }

  return {
    netTotalOre,
    vatTotalOre,
    // Deliberately net + vat, NOT a separate sum of grossOre. Those are equal
    // by construction, and computing it one way means they cannot drift apart
    // if someone later changes how a line is built.
    grossTotalOre: netTotalOre + vatTotalOre
  }
}

/**
 * The separator between thousand groups, and between amount and currency.
 *
 * This is U+00A0, a NON-BREAKING space, written as an escape so it is visible
 * in the source. A plain space here would be an invisible bug: it lets a
 * renderer wrap "12 345,67 SEK" as "12" / "345,67 SEK" across a line break,
 * turning one figure into two on a printed invoice.
 *
 * It is also exactly what Intl.NumberFormat('sv-SE') emits, so our output
 * matches anything the frontend formats for itself.
 *
 * Worth knowing, because it cost time once already: a non-breaking space is
 * NOT equal to a regular space. Two strings can look identical in a terminal,
 * a diff and an editor, and still fail ===. If a formatted value is ever
 * compared, exported to CSV, or parsed back, this is the character that will
 * surprise you.
 */
const NBSP = ' '

/**
 * Formats öre for display. The ONLY place öre becomes a decimal.
 *
 * Note this returns a string and is never fed back into a calculation.
 * The moment a money value becomes a float it stops being exact.
 */
export function formatOre(ore: number, currency = 'SEK'): string {
  const sign = ore < 0 ? '-' : ''
  const absolute = Math.abs(ore)
  const whole = Math.floor(absolute / 100)
  const fraction = String(absolute % 100).padStart(2, '0')

  // sv-SE grouping: 1 234 567,89
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)

  return `${sign}${grouped},${fraction}${NBSP}${currency}`
}

/**
 * What a customer owes on an invoice right now.
 *
 * Three parts, each with its own legal basis and its own ledger rows:
 * the invoice itself (gross, VAT included), interest under räntelagen,
 * and the fixed reminder fee. Defined once so that the payment link, the
 * PDF, the dashboard and the customer's screen can never disagree about
 * the figure.
 */
export function totalDueOre(invoice: {
  grossTotalOre: number
  lateFeeOre: number
  reminderFeeOre: number
}): number {
  return invoice.grossTotalOre + invoice.lateFeeOre + invoice.reminderFeeOre
}

/**
 * Late fee: a percentage of the invoice's gross total.
 *
 * Applied to gross rather than net because that is the amount actually
 * outstanding — the client owes the VAT too, and it is the unpaid sum that
 * accrues the fee.
 *
 * Kept as a primitive; the Swedish statutory model below is what actually
 * gets used.
 */
export function calculateLateFee(grossTotalOre: number, rateBasisPoints: number): number {
  return roundOre((grossTotalOre * rateBasisPoints) / 10_000)
}

// ─────────────────────────────────────────────────────────────
// Dröjsmålsränta — Swedish statutory late payment interest
// ─────────────────────────────────────────────────────────────
//
// Räntelagen (1975:635) § 6: interest accrues at the Riksbank's referensränta
// plus 8 percentage points, per year, from the due date.
//
// This replaces the flat 10% originally planned. A flat percentage is a
// PENALTY, not interest: it does not grow with the delay, and a penalty
// clause that was never contractually agreed is generally unenforceable. It
// also under-charges a debtor who is a year late and over-charges one who is
// a day late.

/**
 * The Riksbank reference rate, in basis points.
 *
 * Set twice a year, so it is configuration rather than a constant. It lives
 * here with a date so that anyone reading knows how stale it might be —
 * a hardcoded rate with no provenance is worse than one you can check.
 *
 * Last updated: 2026-08-14. Verify against riksbank.se before relying on it.
 */
export const REFERENCE_RATE_BASIS_POINTS = 200 // 2.00%

/** Räntelagen adds 8 percentage points to the reference rate. */
export const LATE_INTEREST_MARKUP_BASIS_POINTS = 800

/**
 * Statutory reminder fee — lagstadgad påminnelseavgift.
 *
 * 60 SEK, fixed by lag (1981:739) om ersättning för inkassokostnader. Charged
 * per reminder, and only if the right to charge it was stated on the invoice.
 */
export const REMINDER_FEE_ORE = 6_000

/**
 * Interest owed on an overdue invoice, for a given number of days.
 *
 * Deliberately takes `daysLate` rather than computing it from dates: a pure
 * function of numbers is trivially testable, and the caller already knows
 * which two dates it is comparing.
 *
 * Uses a 365-day year. Räntelagen does not mandate a day-count convention,
 * and 365 (rather than 360) is the common Swedish practice.
 */
export function calculateLateInterest(
  outstandingOre: number,
  daysLate: number,
  referenceRateBasisPoints = REFERENCE_RATE_BASIS_POINTS
): number {
  if (daysLate <= 0 || outstandingOre <= 0) return 0

  const annualRate = referenceRateBasisPoints + LATE_INTEREST_MARKUP_BASIS_POINTS

  // Split the division to keep the intermediate value small. Multiplying an
  // öre amount by rate AND by days before dividing would push a large invoice
  // toward the limit of exact integer representation.
  return roundOre((outstandingOre * annualRate * daysLate) / 10_000 / 365)
}

/** Whole days between two dates, floored. Never negative. */
export function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime()
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)))
}
