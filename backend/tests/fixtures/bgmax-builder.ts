// bgmax-builder.ts — builds BgMax files for tests.
//
// A test describes the file it needs — deposits, payments, references —
// and gets Latin-1 bytes back, with every column padded per the manual and
// every total (deposit sums, counts, the end record) computed. A test then
// only states what it is about. The *Override fields make one total wrong on
// purpose, for the negative tests.
//
// It refuses rather than truncates: a value wider than its field, a
// non-digit in a numeric field, or a character Latin-1 cannot hold all
// throw, so a fixture can never silently differ from what the test says.

export type BuildExtraReference = {
  reference: string
  /** Default 0. Negative → a TK23 record holding the absolute value. */
  amountOre?: number
  referenceCode?: number
}

export type BuildPayer = {
  name?: string
  extraName?: string
  address?: string
  postalCode?: string
  city?: string
  country?: string
  countryCode?: string
  organisationNumber?: string
}

export type BuildEntry = {
  kind?: 'payment' | 'deduction'
  amountOre: number
  senderBankgiro?: string
  reference?: string
  /** Default 2 (a correct OCR reference) when there is a reference, else 0. */
  referenceCode?: number
  paymentChannel?: number
  bgcSerial?: string
  imageMarker?: number
  deductionCode?: number
  extraReferences?: BuildExtraReference[]
  information?: string[]
  payer?: BuildPayer
}

export type BuildDeposit = {
  receivingBankgiro?: string
  receivingPlusgiro?: string
  currency?: string
  clearingNumber?: string
  accountNumber?: string
  /** 'YYYY-MM-DD'. */
  paymentDate?: string
  serial?: number
  entries: BuildEntry[]
  amountOreOverride?: number
  entryCountOverride?: number
  depositCurrencyOverride?: string
}

export type BuildFile = {
  layout?: string
  version?: string
  /** 20 digits, CCYYMMDDHHmmSSNNNNNN. */
  writtenAt?: string
  testMarker?: string
  deposits: BuildDeposit[]
  totalsOverride?: Partial<{ payments: number; deductions: number; extraReferences: number; deposits: number }>
}

/** Bankgirot's own test bankgiro from the official example files, 991-2346. */
export const TEST_BANKGIRO = '9912346'

/** The file as 80-character lines, without line endings. */
export function buildBgmaxLines(file: BuildFile): string[] {
  const lines: string[] = []
  let payments = 0
  let deductions = 0
  let extraReferences = 0
  let bgcSerial = 0

  lines.push(
    record('01', [
      text(file.layout ?? 'BGMAX', 20),
      num(file.version ?? '01', 2),
      num(file.writtenAt ?? '20261015120000000000', 20),
      text(file.testMarker ?? 'T', 1)
    ])
  )

  file.deposits.forEach((deposit, depositIndex) => {
    const currency = deposit.currency ?? 'SEK'
    lines.push(
      record('05', [
        num(deposit.receivingBankgiro ?? TEST_BANKGIRO, 10),
        deposit.receivingPlusgiro === undefined ? blanks(10) : num(deposit.receivingPlusgiro, 10),
        text(currency, 3)
      ])
    )

    let sum = 0n
    for (const entry of deposit.entries) {
      const isDeduction = entry.kind === 'deduction'
      const serial = entry.bgcSerial ?? String((bgcSerial += 1))
      const referenceCode = entry.referenceCode ?? (entry.reference ? 2 : 0)
      const common = [
        num(entry.senderBankgiro ?? '0', 10),
        reference(entry.reference ?? '', referenceCode),
        num(String(entry.amountOre), 18),
        num(String(referenceCode), 1),
        num(String(entry.paymentChannel ?? 1), 1),
        num(serial, 12),
        num(String(entry.imageMarker ?? 0), 1)
      ]
      lines.push(record(isDeduction ? '21' : '20', isDeduction ? [...common, num(String(entry.deductionCode ?? 0), 1)] : common))
      sum += isDeduction ? -BigInt(entry.amountOre) : BigInt(entry.amountOre)
      if (isDeduction) deductions += 1
      else payments += 1

      for (const extra of entry.extraReferences ?? []) {
        const amount = extra.amountOre ?? 0
        const code = extra.referenceCode ?? 2
        lines.push(
          record(amount < 0 ? '23' : '22', [
            num(entry.senderBankgiro ?? '0', 10),
            reference(extra.reference, code),
            num(String(Math.abs(amount)), 18),
            num(String(code), 1),
            num(String(entry.paymentChannel ?? 1), 1),
            num(serial, 12),
            num(String(entry.imageMarker ?? 0), 1)
          ])
        )
        extraReferences += 1
      }
      for (const info of entry.information ?? []) lines.push(record('25', [text(info, 50)]))
      const payer = entry.payer
      if (payer) {
        if (payer.name !== undefined || payer.extraName !== undefined) {
          lines.push(record('26', [text(payer.name ?? '', 35), text(payer.extraName ?? '', 35)]))
        }
        if (payer.address !== undefined || payer.postalCode !== undefined) {
          lines.push(record('27', [text(payer.address ?? '', 35), text(payer.postalCode ?? '', 9)]))
        }
        if (payer.city !== undefined || payer.country !== undefined || payer.countryCode !== undefined) {
          lines.push(record('28', [text(payer.city ?? '', 35), text(payer.country ?? '', 35), text(payer.countryCode ?? '', 2)]))
        }
        if (payer.organisationNumber !== undefined) lines.push(record('29', [num(payer.organisationNumber, 12)]))
      }
    }

    const account = `${'0'.repeat(19)}${num(deposit.clearingNumber ?? '5841', 4)}${num(deposit.accountNumber ?? '1009823', 12)}`
    lines.push(
      record('15', [
        account,
        num((deposit.paymentDate ?? '2026-10-15').replace(/-/g, ''), 8),
        num(String(deposit.serial ?? depositIndex + 1), 5),
        num(String(deposit.amountOreOverride ?? sum), 18),
        text(deposit.depositCurrencyOverride ?? currency, 3),
        num(String(deposit.entryCountOverride ?? deposit.entries.length), 8),
        blanks(1)
      ])
    )
  })

  const totals = {
    payments,
    deductions,
    extraReferences,
    deposits: file.deposits.length,
    ...file.totalsOverride
  }
  lines.push(
    record('70', [
      num(String(totals.payments), 8),
      num(String(totals.deductions), 8),
      num(String(totals.extraReferences), 8),
      num(String(totals.deposits), 8)
    ])
  )
  return lines
}

/** The file as Latin-1 bytes. */
export function buildBgmax(
  file: BuildFile,
  options: { lineEnding?: '\r\n' | '\n' | '\r'; finalLineEnding?: boolean } = {}
): Uint8Array {
  return toLatin1(buildBgmaxLines(file), options.lineEnding, options.finalLineEnding)
}

/**
 * Joins lines and encodes them as Latin-1.
 *
 * TRAP: Buffer.from(text, 'latin1') never fails — a character above U+00FF
 * silently keeps only its low byte, so '€' (U+20AC) becomes 0xAC, '¬'.
 * Hence the explicit check.
 */
export function toLatin1(lines: string[], lineEnding: '\r\n' | '\n' | '\r' = '\r\n', finalLineEnding = true): Uint8Array {
  const joined = lines.join(lineEnding) + (finalLineEnding ? lineEnding : '')
  for (const char of joined) {
    if ((char.codePointAt(0) ?? 0) > 0xff) throw new Error(`"${char}" cannot be written in Latin-1`)
  }
  return new Uint8Array(Buffer.from(joined, 'latin1'))
}

// ─── Fields ───────────────────────────────────────────────────────────────

function record(type: string, fields: string[]): string {
  const line = `${type}${fields.join('')}`
  if (line.length > 80) throw new Error(`Record ${type} is ${line.length} characters`)
  return line.padEnd(80, ' ')
}

/** Numeric, right-aligned and zero-filled (N:h0). */
function num(value: string, width: number): string {
  if (!/^\d+$/.test(value)) throw new Error(`"${value}" is not digits`)
  if (value.length > width) throw new Error(`"${value}" does not fit in ${width} digits`)
  return value.padStart(width, '0')
}

/** Text, left-aligned and blank-filled (A:vb). */
function text(value: string, width: number): string {
  if (value.length > width) throw new Error(`"${value}" does not fit in ${width} characters`)
  return value.padEnd(width, ' ')
}

/** A correct OCR reference (code 2) is right-aligned (N:hb); others are left-aligned. */
function reference(value: string, referenceCode: number): string {
  if (value.length > 25) throw new Error(`Reference "${value}" does not fit in 25 characters`)
  return referenceCode === 2 ? value.padStart(25, ' ') : value.padEnd(25, ' ')
}

function blanks(width: number): string {
  return ' '.repeat(width)
}
