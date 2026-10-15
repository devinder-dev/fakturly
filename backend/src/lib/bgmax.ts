// bgmax.ts — parser for BgMax, Bankgirot's report of incoming bankgiro
// payments. Wave 2 imports these files to mark invoices paid; this file only
// turns bytes into typed, cross-checked data. No database, no env, no clock.
//
// THE FORMAT. Fixed width: every record is one line of 80 characters, and a
// field is identified by its COLUMNS, not by a separator. The first two
// characters are the record type ("transaktionskod", TK):
//
//   01 start
//     05 opening — one deposit to one receiving bankgiro, in SEK
//       20 payment   | 21 deduction (e.g. a credit note)
//         22 extra reference | 23 extra reference, NEGATIVE amount
//         25 information text (up to 90)
//         26 name, 27 address, 28 city/country, 29 organisation number (0–1 each)
//     15 deposit — date, serial, amount, number of 20+21 records
//   70 end — file totals
//
// FIELD POSITIONS (1-based, inclusive), from "Bankgiro Inbetalningar Teknisk
// manual", oktober 2023, tables 2–17. N = digits, A = text,
// h0 = right-aligned zero-filled, vb = left-aligned blank-filled,
// hb = right-aligned blank-filled.
//
//   TK01  3–22 layout name "BGMAX" (A:vb)    23–24 version (N:h0)
//         25–44 timestamp CCYYMMDDHHmmSSNNNNNN (NNNNNN = microseconds)
//         45 test marker: "T" test file, "P" production file
//   TK05  3–12 receiving bankgiro (N:h0)      13–22 plusgiro, only on conversion (N:h0 or blank)
//         23–25 currency
//   TK20  3–12 sender bankgiro (N:h0)         13–37 reference (format per reference code)
//   TK21  38–55 amount, öre (N:h0, 18)        56 reference code   57 payment channel
//         58–69 BGC serial (12)               70 image marker
//         TK21 only: 71 deduction code (0 full, 1 partial with rest, 2 final partial)
//   TK22  same columns as TK20 for 3–70. The amount is a subtotal (extended
//   TK23  form registration) or zero; the payment's total is always in TK20.
//   TK25  3–52 information text (50)
//   TK26  3–37 name (35)                      38–72 extra name (35)
//   TK27  3–37 address (35)                   38–46 postal code (9)
//   TK28  3–37 city (35)                      38–72 country (35)     73–74 country code
//   TK29  3–14 organisation number (12, N:h0, "Anges med 10 siffror")
//   TK15  3–37 receiving bank account (35, N:h0): 22–25 clearing, 26–37 account
//         38–45 payment date CCYYMMDD         46–50 deposit serial (N:h0)
//         51–68 deposit amount, öre (18)      69–71 currency
//         72–79 number of payment + deduction records   80 deposit type, or blank
//   TK70  3–10 payments   11–18 deductions   19–26 extra references   27–34 deposits
//
// Reference code (pos 56): 0/1 blank, 2 correct OCR reference (right-aligned),
// 3 one or more references (unchecked), 4 correct and 5 incorrect under
// extended form registration, 6–9 reserved. Payment channel (pos 57):
// 1 bank, 2 Leverantörsbetalningar, 3 paper form, 4–9 reserved.
//
// RULES, AND WHERE EACH COMES FROM
//
//   Encoding — NOT STATED in the manual (checked: neither the Swedish nor the
//   English edition names a character set). Bankgirot's five example files
//   are single-byte Latin-1 ("Kalles Plåt AB", å = 0xE5). We decode with
//   Buffer 'latin1', which is true ISO-8859-1: one byte, one character.
//   TRAP: TextDecoder('iso-8859-1') is WINDOWS-1252 (WHATWG maps the label;
//   its .encoding even says so) and turns 0x80 into '€' — hiding a byte the
//   control-character check below would otherwise catch. A UTF-8 file (a BOM,
//   or bytes that decode as valid UTF-8, i.e. "Ã¥" for "å") means someone
//   opened and re-saved the bank's file: refused as ENCODING.
//
//   Control characters (C0, DEL, C1) are fatal — including TAB. A tab shifts
//   every later column, so its meaning depends on an editor's tab width.
//   Bankgirot's own example file has two at line 17 (an editor artefact).
//   Owner decision (2026-10-15): report it, never guess tab stops.
//
//   Line length: lines are split on CRLF, LF or CR. A shorter line is padded
//   with blanks (editors strip trailing spaces; every trailing field is text
//   or reserved, and a truncated number fails its own digit check). Overflow
//   past column 80 is tolerated only if it is blanks.
//
//   Unknown record types are ignored with a warning — the manual: "En
//   applikation som läser filer i BgMax bör konstrueras så att den ignorerar
//   posttyper den inte känner igen." Unknown LAYOUT VERSIONS are not: a new
//   version may move fields, so anything but "01" is refused.
//
//   Identifiers (bankgiro, plusgiro, organisation number) are parsed
//   leniently — blanks trimmed — because the official examples break the
//   zero-fill rule ("009701233 "). Amounts, dates and counts are strict.
//
//   Amounts: exactly 18 digits → BigInt → must be ≤ Number.MAX_SAFE_INTEGER.
//   Never parseFloat. Sums are computed in BigInt: each amount fits a JS
//   number, but a running sum can pass 2^53 and silently round.
//
//   Currency: SEK only — "Bankgiro Inbetalningar redovisar endast
//   inbetalningar i SEK från och med 31 oktober 2016."
//
//   Cross-checks: each deposit amount = Σ payments − Σ deductions (extra
//   reference amounts are subtotals and do not count); each deposit's record
//   count; and the end record's four totals, where TK23 counts as an extra
//   reference together with TK22. Deposit serials must be unique per
//   receiving bankgiro and year ("Unikt per Bankgironummer och år").
//
//   Extra references (TK22/23) must carry their payment's sender bankgiro
//   and BGC serial, as the manual says they do. That ties each one to its
//   parent and catches shifted columns. Whether their subtotals add up to
//   the payment is NOT a rule in the manual, so it is reported per entry
//   (`subtotalsBalanced`), never fatal: one payer's odd form must not block
//   a whole bank file. Wave 2 must not split money by unbalanced subtotals.
//
//   Memory: the line count is checked on the raw bytes before splitting
//   (MAX_LINES), and lines are never padded into copies — field() pads the
//   slice it reads. A 2 MiB upload of bare line endings once cost ~470 MB.
//
//   BGC SERIAL IS NOT A KEY. The manual says it is "unikt i två år", yet
//   Bankgirot's own example file gives serial 000000000016 to two payments
//   from different payers. Wave 2 keys a payment on receiving bankgiro +
//   year + deposit serial ("Unikt per Bankgironummer och år") + the entry's
//   `position` in its deposit. A false duplicate there would drop real money.
//
//   TEST MARKER: all five official example files say "P" (production). The
//   marker cannot be used to recognise Bankgirot's examples.
//
// ERRORS. parseBgmax never throws on file content. It works in passes and
// stops after the first pass that finds errors, so one real problem is not
// buried under the follow-on errors it causes: bytes → line hygiene →
// records and structure → totals. At most MAX_ISSUES errors are reported.
// Messages are Swedish: the admin who uploaded the file reads them.
//
// SOURCES (checked 2026-10-15):
//   Teknisk manual (sv): https://www.bankgirot.se/globalassets/dokument/tekniska-manualer/bankgiroinbetalningar_tekniskmanual_sv.pdf
//   Technical manual (en): https://www.bankgirot.se/globalassets/dokument/tekniska-manualer/bankgiroreceivables_bankgiroinbetalningar_technicalmanual_en.pdf
//   Example files: https://www.bankgirot.se/kundservice/exempelfiler/

import { ValidationError } from './errors.ts'

export const MAX_ISSUES = 50
const LINE_LENGTH = 80
const MAX_INFORMATION_RECORDS = 90
const SUPPORTED_VERSION = '01'
/**
 * Lines, not bytes, are what a split costs: 2 MiB of bare line endings is
 * two million strings. Counted on the raw bytes BEFORE splitting. 200 000
 * lines is ~16 MB of real 80-character records — more than any upload the
 * app accepts (the caller limits bytes; this limits lines).
 */
export const MAX_LINES = 200_000

export type BgmaxErrorCode =
  | 'ENCODING'
  | 'EMPTY_FILE'
  | 'TOO_MANY_LINES'
  | 'CONTROL_CHARACTER'
  | 'LINE_TOO_LONG'
  | 'FORMAT'
  | 'STRUCTURE'
  | 'INVALID_FIELD'
  | 'AMOUNT_TOO_LARGE'
  | 'CURRENCY'
  | 'DEPOSIT_AMOUNT'
  | 'DEPOSIT_COUNT'
  | 'DUPLICATE_DEPOSIT'
  | 'FILE_TOTALS'
  | 'TOO_MANY_ERRORS'

/**
 * Not fatal. SUSPICIOUS_DATE: a deposit dated after the file was written —
 * impossible in the official examples, but unverified against production
 * files, so it is reported rather than refused.
 */
export type BgmaxWarningCode = 'UNKNOWN_RECORD' | 'BLANK_LINE' | 'SUSPICIOUS_DATE'

export type BgmaxIssue<Code extends string = BgmaxErrorCode | BgmaxWarningCode> = {
  code: Code
  /** 1-based line in the file, or null for the file as a whole. */
  line: number | null
  /** Swedish, for the admin who uploaded the file. */
  message: string
}

/** Who paid, when the bank passed it on (records 26–29). Unverified, informational. */
export type BgmaxPayer = {
  name: string | null
  extraName: string | null
  address: string | null
  postalCode: string | null
  city: string | null
  country: string | null
  countryCode: string | null
  organisationNumber: string | null
}

export type BgmaxExtraReference = {
  line: number
  reference: string
  referenceCode: number
  /** A subtotal or 0. NEGATIVE for a TK23 record. */
  amountOre: number
}

export type BgmaxEntry = {
  line: number
  /**
   * 1-based position among the deposit's payment and deduction records.
   * Stable for a given file, so it is part of wave 2's idempotency key.
   */
  position: number
  kind: 'payment' | 'deduction'
  /** Always ≥ 0; `kind` says which way it counts. */
  amountOre: number
  /** Digits without leading zeros; null when the bank did not know it. */
  senderBankgiro: string | null
  /** Blanks trimmed; '' when there is none. */
  reference: string
  referenceCode: number
  paymentChannel: number
  /** Bankgirot's serial. NOT unique in practice — never use it as a key. */
  bgcSerial: string
  imageMarker: number
  /** Deductions only: 0 full, 1 partial with a remainder, 2 final partial. */
  deductionCode: number | null
  extraReferences: BgmaxExtraReference[]
  /**
   * Do the extra references' amounts (Σ TK22 − Σ TK23) add up to `amountOre`?
   * null when they are all 0 (no subtotals). The manual says only that they
   * "kan innehålla delsummor" — never that they must balance — so a mismatch
   * is not an error. Splitting money across invoices by subtotal is only
   * safe when this is true.
   */
  subtotalsBalanced: boolean | null
  information: string[]
  payer: BgmaxPayer | null
}

export type BgmaxDeposit = {
  /** Line of the opening (05) record. */
  openingLine: number
  /** Line of the deposit (15) record. */
  line: number
  /** Digits without leading zeros — what the org's bankgiro is compared with. */
  receivingBankgiro: string
  receivingPlusgiro: string | null
  currency: 'SEK'
  clearingNumber: string
  accountNumber: string
  /** 'YYYY-MM-DD'. */
  paymentDate: string
  /** Unique per receiving bankgiro and year (the manual). */
  serial: number
  amountOre: number
  entryCount: number
  depositType: string | null
  entries: BgmaxEntry[]
}

export type BgmaxFile = {
  version: '01'
  /** 'YYYY-MM-DDTHH:mm:ss.ffffff', Bankgirot's local time — the file names no zone. */
  writtenAt: string
  isTest: boolean
  deposits: BgmaxDeposit[]
  totals: { payments: number; deductions: number; extraReferences: number; deposits: number }
}

export type BgmaxResult =
  | { ok: true; file: BgmaxFile; warnings: BgmaxIssue<BgmaxWarningCode>[] }
  | { ok: false; errors: BgmaxIssue<BgmaxErrorCode>[]; warnings: BgmaxIssue<BgmaxWarningCode>[] }

/**
 * Parses a BgMax file. Never throws on content: every problem is returned
 * as an issue with a line number and a Swedish message.
 */
export function parseBgmax(bytes: Uint8Array): BgmaxResult {
  // The one throw: a caller passing the wrong type is a bug, not a bad file.
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parseBgmax expects a Uint8Array')

  const issues = new Issues()

  // ── Pass 1: bytes ──────────────────────────────────────────────────────
  const encoding = encodingProblem(bytes)
  if (encoding) {
    issues.error('ENCODING', null, encoding)
    return issues.failure()
  }
  if (countLines(bytes) > MAX_LINES) {
    issues.error('TOO_MANY_LINES', null, `Filen har fler än ${MAX_LINES.toLocaleString('sv-SE')} rader.`)
    return issues.failure()
  }
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
  const rawLines = text.split(/\r\n|\n|\r/)
  // A final line ending (or several) leaves empty strings at the end.
  while (rawLines.length > 0 && isBlank(rawLines[rawLines.length - 1] ?? '')) rawLines.pop()
  if (rawLines.length === 0) {
    issues.error('EMPTY_FILE', null, 'Filen är tom.')
    return issues.failure()
  }

  // ── Pass 2: line hygiene ───────────────────────────────────────────────
  const lines: string[] = []
  rawLines.forEach((raw, index) => {
    const lineNumber = index + 1
    // C0 controls, DEL and C1 controls. CR and LF were consumed by the split.
    const control = /[\x00-\x1f\x7f-\x9f]/.exec(raw)
    if (control) {
      issues.error(
        'CONTROL_CHARACTER',
        lineNumber,
        `Otillåtet styrtecken (${describeControl(control[0])}) i kolumn ${control.index + 1}. ` +
          'BgMax är en fil med fasta kolumner; filen har troligen öppnats och sparats om i en textredigerare.'
      )
      return
    }
    if (raw.length > LINE_LENGTH && !isBlank(raw.slice(LINE_LENGTH))) {
      issues.error('LINE_TOO_LONG', lineNumber, `Raden är ${raw.length} tecken; en BgMax-post är högst 80.`)
      return
    }
    // Stored as read. NOT padded to 80: a padded copy per line made blank
    // lines cost 80 characters each (a 2 MiB upload of line endings grew to
    // ~470 MB). field() pads only the slice it reads.
    lines.push(raw)
  })
  // Returning here also keeps line numbers honest below: a line is only ever
  // dropped together with an error, so from now on lines[i] is line i + 1.
  if (issues.hasErrors()) return issues.failure()

  // ── Pass 3: records and structure ──────────────────────────────────────
  const parsed = parseRecords(lines, issues)
  if (!parsed || issues.hasErrors()) return issues.failure()

  // ── Pass 4: totals ─────────────────────────────────────────────────────
  crossCheck(parsed, issues)
  if (issues.hasErrors()) return issues.failure()

  return { ok: true, file: parsed.file, warnings: issues.warnings }
}

/**
 * parseBgmax for callers that want an exception: a ValidationError (400)
 * whose details carry every issue.
 */
export function parseBgmaxOrThrow(bytes: Uint8Array): BgmaxFile {
  const result = parseBgmax(bytes)
  if (!result.ok) {
    throw new ValidationError('Filen kunde inte läsas som en BgMax-fil', { errors: result.errors })
  }
  return result.file
}

// ─── Pass 3 ───────────────────────────────────────────────────────────────

type Parsed = { file: BgmaxFile; endLine: number; extraReferenceCount: number }

type OpenSection = {
  openingLine: number
  receivingBankgiro: string
  receivingPlusgiro: string | null
  entries: BgmaxEntry[]
  /** Payment/deduction records seen, INCLUDING rejected ones — see the 15 case. */
  recordsSeen: number
}

function parseRecords(lines: string[], issues: Issues): Parsed | null {
  // The first line decides whether this is a BgMax file at all. Nothing is
  // skipped before it: a CSV or a PDF should be refused, not warned about.
  const first = lines[0] ?? ''
  if (first.slice(0, 2) !== '01') {
    issues.error('STRUCTURE', 1, 'Filen börjar inte med en startpost (01) — det är inte en BgMax-fil.')
    return null
  }
  const layout = blankTrim(field(first, 3, 22))
  const version = field(first, 23, 24)
  if (layout !== 'BGMAX') {
    issues.error('FORMAT', 1, `Startposten anger formatet "${layout}", inte BGMAX.`)
    return null
  }
  if (version !== SUPPORTED_VERSION) {
    issues.error('FORMAT', 1, `BgMax version ${version} stöds inte (bara ${SUPPORTED_VERSION}); kolumnerna kan ha flyttats.`)
    return null
  }
  const reader = new FieldReader(issues, 1)
  const writtenAt = reader.timestamp(field(first, 25, 44), 'Skrivdag')
  const marker = field(first, 45, 45)
  if (marker !== 'T' && marker !== 'P') reader.invalid('Testmarkering', 'ska vara T eller P')

  const deposits: BgmaxDeposit[] = []
  let section: OpenSection | null = null
  let entry: BgmaxEntry | null = null
  let payerSeen = new Set<string>()
  let extraReferenceCount = 0
  let endLine: number | null = null
  let totals: BgmaxFile['totals'] | null = null

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const lineNumber = index + 1
    const type = field(line, 1, 2)
    const read = new FieldReader(issues, lineNumber)

    if (endLine !== null) {
      if (!isBlank(line)) issues.error('STRUCTURE', lineNumber, 'Det finns poster efter slutposten (70).')
      continue
    }

    switch (type) {
      case '01':
        issues.error('STRUCTURE', lineNumber, 'Filen har mer än en startpost (01).')
        break

      case '05': {
        if (section) {
          issues.error('STRUCTURE', lineNumber, 'Ny öppningspost (05) innan föregående avsnitt avslutats med en insättningspost (15).')
        }
        const bankgiroField = field(line, 3, 12)
        const receivingBankgiro = read.identifier(bankgiroField, 'Mottagarbankgironummer')
        // identifier() already reported non-digits; this is the blank/zero case.
        if (receivingBankgiro === null && /^[ 0]*$/.test(bankgiroField)) read.invalid('Mottagarbankgironummer', 'saknas')
        const receivingPlusgiro = read.identifier(field(line, 13, 22), 'Mottagarplusgironummer')
        const currency = field(line, 23, 25)
        if (currency !== 'SEK') {
          issues.error('CURRENCY', lineNumber, `Valutan är "${blankTrim(currency)}"; Bankgiro Inbetalningar redovisar bara SEK.`)
        }
        section = {
          openingLine: lineNumber,
          receivingBankgiro: receivingBankgiro ?? '',
          receivingPlusgiro,
          entries: [],
          recordsSeen: 0
        }
        entry = null
        break
      }

      case '20':
      case '21': {
        const before = issues.errorCount
        if (!section) {
          issues.error('STRUCTURE', lineNumber, `${type === '20' ? 'Betalningspost (20)' : 'Avdragspost (21)'} utanför ett avsnitt — öppningspost (05) saknas.`)
        }
        const parsedEntry: BgmaxEntry = {
          line: lineNumber,
          position: (section?.entries.length ?? 0) + 1,
          kind: type === '20' ? 'payment' : 'deduction',
          senderBankgiro: read.identifier(field(line, 3, 12), 'Avsändarbankgironummer'),
          reference: blankTrim(field(line, 13, 37)),
          amountOre: read.amount(field(line, 38, 55), 'Belopp'),
          referenceCode: read.digit(field(line, 56, 56), 'Referenskod'),
          paymentChannel: read.digit(field(line, 57, 57), 'Betalningskanal'),
          bgcSerial: read.serial(field(line, 58, 69), 'BGC-löpnummer'),
          imageMarker: read.digit(field(line, 70, 70), 'Avibildmarkering'),
          deductionCode: type === '21' ? read.digit(field(line, 71, 71), 'Avdragskod') : null,
          extraReferences: [],
          subtotalsBalanced: null, // set once its extra references are read (pass 4)
          information: [],
          payer: null
        }
        // A bad record is reported once and kept OUT of the deposit — but it
        // still becomes the current entry, an orphan that absorbs its own
        // 22–29 records. Otherwise each of them would add a second, misleading
        // "belongs to no payment" error, or attach to the previous payment.
        entry = parsedEntry
        if (section) {
          section.recordsSeen += 1
          if (issues.errorCount === before) section.entries.push(parsedEntry)
        }
        payerSeen = new Set()
        break
      }

      case '22':
      case '23': {
        const parent = requireEntry(entry, issues, lineNumber, 'Extra referensnummerpost')
        if (!parent) break
        // The manual: an extra reference carries the SAME sender bankgiro and
        // BGC serial as the payment it belongs to. Checking it ties the record
        // to its parent — and catches a shifted column (a deleted or inserted
        // character moves the serial too), or a record that drifted onto the
        // wrong payment past an unknown record.
        const before = issues.errorCount
        const sender = read.identifier(field(line, 3, 12), 'Avsändarbankgironummer')
        const serial = read.serial(field(line, 58, 69), 'BGC-löpnummer')
        if (issues.errorCount === before && (sender !== parent.senderBankgiro || serial !== parent.bgcSerial)) {
          issues.error(
            'STRUCTURE',
            lineNumber,
            `Extra referensnummerpost (${type}) har annat avsändarbankgironummer eller BGC-löpnummer än betalningen den hör till (rad ${parent.line}).`
          )
        }
        const amount = read.amount(field(line, 38, 55), 'Belopp')
        parent.extraReferences.push({
          line: lineNumber,
          reference: blankTrim(field(line, 13, 37)),
          referenceCode: read.digit(field(line, 56, 56), 'Referenskod'),
          // `amount === 0 ? 0 : …`: a zero TK23 must not become -0, which a
          // writer choosing the record type by sign would turn back into TK22.
          amountOre: type === '23' && amount !== 0 ? -amount : amount
        })
        extraReferenceCount += 1
        break
      }

      case '25': {
        const parent = requireEntry(entry, issues, lineNumber, 'Informationspost (25)')
        if (!parent) break
        if (parent.information.length >= MAX_INFORMATION_RECORDS) {
          issues.error('STRUCTURE', lineNumber, `En betalning har fler än ${MAX_INFORMATION_RECORDS} informationsposter (25).`)
          break
        }
        parent.information.push(field(line, 3, 52).replace(/ +$/, ''))
        break
      }

      case '26':
      case '27':
      case '28':
      case '29': {
        const parent = requireEntry(entry, issues, lineNumber, `Betalaruppgift (${type})`)
        if (!parent) break
        if (payerSeen.has(type)) {
          issues.error('STRUCTURE', lineNumber, `Post ${type} förekommer mer än en gång för samma betalning.`)
          break
        }
        payerSeen.add(type)
        const payer = (parent.payer ??= emptyPayer())
        if (type === '26') {
          payer.name = textOrNull(field(line, 3, 37))
          payer.extraName = textOrNull(field(line, 38, 72))
        } else if (type === '27') {
          payer.address = textOrNull(field(line, 3, 37))
          payer.postalCode = textOrNull(field(line, 38, 46))
        } else if (type === '28') {
          payer.city = textOrNull(field(line, 3, 37))
          payer.country = textOrNull(field(line, 38, 72))
          payer.countryCode = textOrNull(field(line, 73, 74))
        } else {
          payer.organisationNumber = read.organisationNumber(field(line, 3, 14), 'Organisationsnummer')
        }
        break
      }

      case '15': {
        if (!section) {
          issues.error('STRUCTURE', lineNumber, 'Insättningspost (15) utan öppningspost (05).')
          break
        }
        // recordsSeen, not entries.length: a section whose only payment was
        // rejected for a bad field is not ALSO "a section without payments".
        if (section.recordsSeen === 0) {
          issues.error('STRUCTURE', lineNumber, 'Avsnittet innehåller ingen betalning; ett avsnitt måste ha minst en.')
        }
        const account = field(line, 3, 37)
        if (!/^\d{35}$/.test(account)) read.invalid('Mottagarbankkontonummer', 'ska vara 35 siffror')
        const currency = field(line, 69, 71)
        if (currency !== 'SEK') {
          issues.error('CURRENCY', lineNumber, `Insättningens valuta är "${blankTrim(currency)}"; Bankgiro Inbetalningar redovisar bara SEK.`)
        }
        const type80 = field(line, 80, 80)
        const paymentDate = read.date(field(line, 38, 45), 'Betalningsdag')
        // A deposit cannot be dated after the file reporting it was written —
        // true in every official example, but unverified against production
        // files, so reported instead of refused. Wave 2 decides what to do.
        if (paymentDate !== '' && writtenAt !== '' && paymentDate > writtenAt.slice(0, 10)) {
          issues.warn('SUSPICIOUS_DATE', lineNumber, `Betalningsdagen ${paymentDate} ligger efter filens skrivdag ${writtenAt.slice(0, 10)}.`)
        }
        deposits.push({
          openingLine: section.openingLine,
          line: lineNumber,
          receivingBankgiro: section.receivingBankgiro,
          receivingPlusgiro: section.receivingPlusgiro,
          currency: 'SEK',
          clearingNumber: field(line, 22, 25),
          accountNumber: field(line, 26, 37).replace(/^0+/, ''),
          paymentDate,
          serial: read.count(field(line, 46, 50), 'Insättningslöpnummer'),
          amountOre: read.amount(field(line, 51, 68), 'Insättningsbelopp'),
          entryCount: read.count(field(line, 72, 79), 'Antal betalningar'),
          depositType: type80 === ' ' ? null : type80,
          entries: section.entries
        })
        section = null
        entry = null
        break
      }

      case '70': {
        if (section) {
          issues.error('STRUCTURE', lineNumber, 'Slutposten (70) kommer innan avsnittet avslutats med en insättningspost (15).')
        }
        totals = {
          payments: read.count(field(line, 3, 10), 'Antal betalningsposter'),
          deductions: read.count(field(line, 11, 18), 'Antal avdragsposter'),
          extraReferences: read.count(field(line, 19, 26), 'Antal extra referensposter'),
          deposits: read.count(field(line, 27, 34), 'Antal insättningsposter')
        }
        endLine = lineNumber
        break
      }

      default:
        // The manual: ignore record types you do not recognise. Unknown records
        // do not end the current payment either — a future record type may
        // sit between a payment and its name record.
        if (isBlank(line)) issues.warn('BLANK_LINE', lineNumber, 'Tom rad ignorerades.')
        else issues.warn('UNKNOWN_RECORD', lineNumber, `Okänd posttyp "${type}" ignorerades (enligt Bankgirots manual).`)
    }
  }

  if (endLine === null || totals === null) {
    if (section) issues.error('STRUCTURE', null, 'Sista avsnittet avslutas aldrig med en insättningspost (15).')
    issues.error('STRUCTURE', null, 'Slutpost (70) saknas — filen är troligen avkortad.')
    return null
  }
  if (deposits.length === 0) {
    issues.error('STRUCTURE', endLine, 'Filen innehåller inget avsnitt; en BgMax-fil har minst ett.')
  }

  return {
    file: { version: SUPPORTED_VERSION, writtenAt, isTest: marker === 'T', deposits, totals },
    endLine,
    extraReferenceCount
  }
}

function requireEntry(entry: BgmaxEntry | null, issues: Issues, line: number, what: string): BgmaxEntry | null {
  if (!entry) issues.error('STRUCTURE', line, `${what} hör inte till någon betalning — betalningspost (20/21) saknas före den.`)
  return entry
}

// ─── Pass 4 ───────────────────────────────────────────────────────────────

function crossCheck(parsed: Parsed, issues: Issues): void {
  let payments = 0
  let deductions = 0
  const depositKeys = new Map<string, number>()

  for (const deposit of parsed.file.deposits) {
    // The manual: the deposit serial is "Unikt per Bankgironummer och år".
    // Two deposits sharing one would give their payments the same wave 2
    // key, and the second would be dropped as a "duplicate" — real money lost.
    const key = `${deposit.receivingBankgiro}:${deposit.paymentDate.slice(0, 4)}:${deposit.serial}`
    const first = depositKeys.get(key)
    if (first !== undefined) {
      issues.error(
        'DUPLICATE_DEPOSIT',
        deposit.line,
        `Insättningslöpnummer ${deposit.serial} förekommer redan på rad ${first} för samma bankgironummer och år.`
      )
    } else {
      depositKeys.set(key, deposit.line)
    }

    // BigInt: each amount fits a number, a running sum may not.
    let sum = 0n
    for (const entry of deposit.entries) {
      const subtotals = entry.extraReferences.map((extra) => BigInt(extra.amountOre))
      entry.subtotalsBalanced = subtotals.every((amount) => amount === 0n)
        ? null
        : subtotals.reduce((total, amount) => total + amount, 0n) === BigInt(entry.amountOre)

      if (entry.kind === 'payment') {
        sum += BigInt(entry.amountOre)
        payments += 1
      } else {
        sum -= BigInt(entry.amountOre)
        deductions += 1
      }
    }
    if (sum !== BigInt(deposit.amountOre)) {
      issues.error(
        'DEPOSIT_AMOUNT',
        deposit.line,
        `Insättningen är ${formatOre(BigInt(deposit.amountOre))} men betalningar minus avdrag blir ${formatOre(sum)}.`
      )
    }
    if (deposit.entries.length !== deposit.entryCount) {
      issues.error(
        'DEPOSIT_COUNT',
        deposit.line,
        `Insättningen anger ${deposit.entryCount} betalnings- och avdragsposter men avsnittet har ${deposit.entries.length}.`
      )
    }
  }

  const { totals } = parsed.file
  const mismatches = [
    ['betalningsposter', totals.payments, payments],
    ['avdragsposter', totals.deductions, deductions],
    ['extra referensposter', totals.extraReferences, parsed.extraReferenceCount],
    ['insättningsposter', totals.deposits, parsed.file.deposits.length]
  ] as const
  for (const [label, stated, counted] of mismatches) {
    if (stated !== counted) {
      issues.error('FILE_TOTALS', parsed.endLine, `Slutposten anger ${stated} ${label} men filen innehåller ${counted}.`)
    }
  }
}

// ─── Fields ───────────────────────────────────────────────────────────────

/**
 * Characters `from`–`to`, 1-based and inclusive, exactly as the manual
 * numbers them. A line shorter than the field is read as blanks (editors
 * strip trailing spaces); a truncated number then fails its digit check.
 */
function field(line: string, from: number, to: number): string {
  return line.slice(from - 1, to).padEnd(to - from + 1, ' ')
}

/** Line count from the raw bytes: CRLF, LF and CR each end one line. */
function countLines(bytes: Uint8Array): number {
  let count = 1
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a) count += 1
    else if (bytes[i] === 0x0d && bytes[i + 1] !== 0x0a) count += 1
  }
  return count
}

/** Reads typed fields from one line, reporting INVALID_FIELD in Swedish. */
class FieldReader {
  constructor(
    private readonly issues: Issues,
    private readonly line: number
  ) {}

  invalid(name: string, problem: string): void {
    this.issues.error('INVALID_FIELD', this.line, `${name} ${problem}.`)
  }

  /** 18 digits of öre. Returns 0 after reporting a problem. */
  amount(raw: string, name: string): number {
    if (!/^\d{18}$/.test(raw)) {
      this.invalid(name, 'ska vara 18 siffror')
      return 0
    }
    const value = BigInt(raw)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      this.issues.error('AMOUNT_TOO_LARGE', this.line, `${name} är för stort för att hanteras exakt.`)
      return 0
    }
    return Number(value)
  }

  /** Zero-filled digits, e.g. a count or a serial. */
  count(raw: string, name: string): number {
    if (!/^\d+$/.test(raw)) {
      this.invalid(name, 'ska bestå av siffror')
      return 0
    }
    return Number(raw)
  }

  digit(raw: string, name: string): number {
    if (!/^\d$/.test(raw)) {
      this.invalid(name, 'ska vara en siffra')
      return 0
    }
    return Number(raw)
  }

  /**
   * Lenient: blanks around the digits are tolerated (the official examples
   * have them), leading zeros are padding. All zeros or blank → null.
   */
  identifier(raw: string, name: string): string | null {
    const digits = blankTrim(raw)
    if (!/^\d*$/.test(digits)) {
      this.invalid(name, 'ska bestå av siffror')
      return null
    }
    const significant = digits.replace(/^0+/, '')
    return significant === '' ? null : significant
  }

  /**
   * "Anges med 10 siffror" in a 12-character field: drop leading zero
   * PADDING down to 10 digits, never further — a sole trader's
   * organisationsnummer is their personnummer, and one born in the 2000s
   * starts with 0.
   */
  organisationNumber(raw: string, name: string): string | null {
    const digits = blankTrim(raw)
    if (!/^\d*$/.test(digits)) {
      this.invalid(name, 'ska bestå av siffror')
      return null
    }
    if (/^0*$/.test(digits)) return null
    return digits.length > 10 && /^0+$/.test(digits.slice(0, digits.length - 10)) ? digits.slice(-10) : digits
  }

  /** Kept as written, leading zeros and all — it is a lookup value, not a number. */
  serial(raw: string, name: string): string {
    const digits = blankTrim(raw)
    if (!/^\d+$/.test(digits)) {
      this.invalid(name, 'ska bestå av siffror')
      return ''
    }
    return digits
  }

  /** CCYYMMDD → 'YYYY-MM-DD'. */
  date(raw: string, name: string): string {
    if (!/^\d{8}$/.test(raw) || !isRealDate(raw.slice(0, 4), raw.slice(4, 6), raw.slice(6, 8))) {
      this.invalid(name, 'är inte ett giltigt datum (ÅÅÅÅMMDD)')
      return ''
    }
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  }

  /** CCYYMMDDHHmmSSNNNNNN → 'YYYY-MM-DDTHH:mm:ss.ffffff'. */
  timestamp(raw: string, name: string): string {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{6})$/.exec(raw)
    const [, y = '', mo = '', d = '', h = '', mi = '', s = '', us = ''] = match ?? []
    if (!match || !isRealDate(y, mo, d) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
      this.invalid(name, 'är inte en giltig tidsstämpel')
      return ''
    }
    return `${y}-${mo}-${d}T${h}:${mi}:${s}.${us}`
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Collects errors and warnings, each capped at MAX_ISSUES. */
class Issues {
  readonly errors: BgmaxIssue<BgmaxErrorCode>[] = []
  readonly warnings: BgmaxIssue<BgmaxWarningCode>[] = []
  private capped = false

  get errorCount(): number {
    return this.errors.length
  }

  error(code: BgmaxErrorCode, line: number | null, message: string): void {
    if (this.capped) return
    if (this.errors.length >= MAX_ISSUES) {
      this.errors.push({ code: 'TOO_MANY_ERRORS', line: null, message: `Fler än ${MAX_ISSUES} fel — resten visas inte.` })
      this.capped = true
      return
    }
    this.errors.push({ code, line, message })
  }

  warn(code: BgmaxWarningCode, line: number, message: string): void {
    if (this.warnings.length < MAX_ISSUES) this.warnings.push({ code, line, message })
  }

  hasErrors(): boolean {
    return this.errors.length > 0
  }

  failure(): BgmaxResult {
    return { ok: false, errors: this.errors, warnings: this.warnings }
  }
}

/** A Swedish explanation if the bytes are clearly not a Latin-1 file, else null. */
function encodingProblem(bytes: Uint8Array): string | null {
  const reSaved = 'BgMax-filer från Bankgirot är Latin-1 (ISO 8859-1); filen har troligen öppnats och sparats om. Ladda upp originalfilen.'
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return `Filen börjar med en UTF-8-markering (BOM). ${reSaved}`
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return `Filen är UTF-16-kodad. ${reSaved}`
  // A Latin-1 file with å/ä/ö is almost never valid UTF-8: 0xE5 ('å') must
  // be followed by two continuation bytes, and a name is not. So non-ASCII
  // bytes that DO decode as UTF-8 mean "å" was stored as "Ã¥".
  if (bytes.some((byte) => byte >= 0x80)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return `Filen är UTF-8-kodad (å visas som "Ã¥"). ${reSaved}`
    } catch {
      // Not UTF-8 — the expected case for a real BgMax file.
    }
  }
  return null
}

function describeControl(char: string): string {
  if (char === '\t') return 'tabb'
  return `tecken U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
}

/** Blank means ASCII spaces only — not NBSP (0xA0), which trim() would also eat. */
function isBlank(text: string): boolean {
  return /^ *$/.test(text)
}

function blankTrim(text: string): string {
  return text.replace(/^ +| +$/g, '')
}

function textOrNull(text: string): string | null {
  const trimmed = blankTrim(text)
  return trimmed === '' ? null : trimmed
}

function emptyPayer(): BgmaxPayer {
  return {
    name: null,
    extraName: null,
    address: null,
    postalCode: null,
    city: null,
    country: null,
    countryCode: null,
    organisationNumber: null
  }
}

function isRealDate(year: string, month: string, day: string): boolean {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  if (m < 1 || m > 12 || d < 1) return false
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/** For messages only: öre → "1 234,50 kr". Exact for any BigInt. */
function formatOre(ore: bigint): string {
  const negative = ore < 0n
  const absolute = negative ? -ore : ore
  const kronor = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  const fraction = (absolute % 100n).toString().padStart(2, '0')
  return `${negative ? '−' : ''}${kronor},${fraction} kr`
}
