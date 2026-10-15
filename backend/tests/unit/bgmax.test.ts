// bgmax.test.ts — the BgMax parser against Bankgirot's five official example
// files, then one builder-made file per error code, the money arithmetic,
// and a fuzz run proving the parser never throws on content.

import { describe, test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  parseBgmax,
  parseBgmaxOrThrow,
  MAX_ISSUES,
  MAX_LINES,
  type BgmaxErrorCode,
  type BgmaxFile,
  type BgmaxIssue
} from '../../src/lib/bgmax.ts'
import { ValidationError } from '../../src/lib/errors.ts'
import { buildBgmax, buildBgmaxLines, toLatin1, type BuildFile } from '../fixtures/bgmax-builder.ts'

const FIXTURES = new URL('../fixtures/bgmax/', import.meta.url)
const official = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, FIXTURES)))

function parsedFile(bytes: Uint8Array): BgmaxFile {
  const result = parseBgmax(bytes)
  if (!result.ok) throw new Error(`Expected a valid file, got ${JSON.stringify(result.errors)}`)
  return result.file
}

function errorsOf(bytes: Uint8Array): BgmaxIssue[] {
  const result = parseBgmax(bytes)
  if (result.ok) throw new Error('Expected the file to be refused')
  return result.errors
}

function codesOf(bytes: Uint8Array): BgmaxErrorCode[] {
  return errorsOf(bytes).map((issue) => issue.code as BgmaxErrorCode)
}

/** What the plan calls "expanding tabs": 8-column tab stops, as an editor shows them. */
function expandTabs(bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes).toString('latin1')
  const expanded = text
    .split('\r\n')
    .map((line) => {
      let out = ''
      for (const char of line) out += char === '\t' ? ' '.repeat(8 - (out.length % 8)) : char
      return out
    })
    .join('\r\n')
  return new Uint8Array(Buffer.from(expanded, 'latin1'))
}

/** One valid deposit with one payment — the base most negative tests bend. */
const SMALL: BuildFile = {
  deposits: [{ entries: [{ amountOre: 125000, reference: '2026000709', payer: { name: 'Kalles Plåt AB' } }] }]
}

// ─── Official files ───────────────────────────────────────────────────────

describe('official example files', () => {
  test.each([
    ['utan-tillval.txt', 'abd6bd4510b068221e8dc4f27a5636caa3d7f17007724c595f5261bb01f1fce1'],
    ['ocr-kontroll.txt', '564b397d5d035771bcdb438d34ef142959219ba9e8a351576c8c386c3e391c22'],
    ['ocr-kontroll-langd.txt', '11e1657b50fdb7a1f3f68745a09cbc60f93014daf1a08b7dbb637c87a40fd446'],
    ['utokad-blankettregistrering.txt', '382ec919e23e653517003c7fbf0df792756306ea6685c8c10120f8a5a55938bd'],
    ['bildfil.txt', '187ca7ac4df0aa9b6bc90cad31859341d3de8cf01a1d4347f0206fb97325267e']
  ])('%s is byte-for-byte Bankgirot’s file (SHA-256)', (name, sha256) => {
    // If this fails, git or an editor rewrote the file (line endings, the
    // tab, the Latin-1 bytes) — and every test below would test the wrong thing.
    expect(createHash('sha256').update(official(name)).digest('hex')).toBe(sha256)
  })

  test('utan-tillval.txt: one deposit, five payments, payer details', () => {
    const file = parsedFile(official('utan-tillval.txt'))
    expect(file.writtenAt).toBe('2004-05-25T17:30:35.010331')
    expect(file.totals).toEqual({ payments: 5, deductions: 0, extraReferences: 0, deposits: 1 })

    const [deposit] = file.deposits
    expect(deposit).toMatchObject({
      receivingBankgiro: '9912346',
      receivingPlusgiro: null,
      currency: 'SEK',
      clearingNumber: '5841',
      accountNumber: '1009823',
      paymentDate: '2004-05-25',
      serial: 5,
      amountOre: 85000,
      entryCount: 5,
      depositType: null
    })
    expect(deposit?.entries[0]).toEqual({
      line: 3,
      position: 1,
      kind: 'payment',
      amountOre: 10000,
      senderBankgiro: '3783511',
      reference: '65598',
      referenceCode: 3,
      paymentChannel: 2,
      bgcSerial: '000000000001',
      imageMarker: 0,
      deductionCode: null,
      extraReferences: [],
      subtotalsBalanced: null,
      information: ['Här är betalning från mig till dig'],
      payer: {
        name: 'Kalles Plåt AB',
        extraName: null,
        address: 'Storgatan 2',
        postalCode: '12345',
        city: 'Storåker',
        country: null,
        countryCode: null,
        organisationNumber: '5500001234'
      }
    })
    // Sender bankgiro all zeros = the bank did not know it.
    expect(deposit?.entries[4]?.senderBankgiro).toBeNull()
  })

  test('🔑 the files are Latin-1: "å" is the single byte 0xE5', () => {
    const bytes = official('utan-tillval.txt')
    expect(bytes.indexOf(0xe5)).toBeGreaterThan(-1)
    expect(parsedFile(bytes).deposits[0]?.entries[0]?.payer?.name).toBe('Kalles Plåt AB')
  })

  test('ocr-kontroll.txt: plusgiro conversion, OCR references, extra references', () => {
    const file = parsedFile(official('ocr-kontroll.txt'))
    const [deposit] = file.deposits
    expect(deposit?.receivingPlusgiro).toBe('8156086')
    expect(deposit?.amountOre).toBe(210000)
    expect(deposit?.entries[0]).toMatchObject({ reference: '573949', referenceCode: 2, senderBankgiro: null })
    expect(deposit?.entries[2]?.reference).toBe('65896,65862,65763')
    expect(deposit?.entries[2]?.extraReferences.map((extra) => extra.reference)).toEqual(['65896', '65862', '65763'])
  })

  test('🔑 identifiers are lenient: "009701233 " (not zero-filled) is bankgiro 9701233', () => {
    const entry = parsedFile(official('ocr-kontroll.txt')).deposits[0]?.entries[3]
    expect(entry?.line).toBe(17)
    expect(entry?.senderBankgiro).toBe('9701233')
  })

  test('utokad-blankettregistrering.txt: three deposits, subtotals, a negative TK23', () => {
    const file = parsedFile(official('utokad-blankettregistrering.txt'))
    expect(file.deposits.map((d) => [d.serial, d.amountOre, d.entryCount])).toEqual([
      [56, 370000, 2],
      [57, 200000, 1],
      [58, 290000, 4]
    ])
    // TK23 counts as an extra reference in the end record: 8 × TK22 + 1 × TK23.
    expect(file.totals.extraReferences).toBe(9)
    const last = file.deposits[2]?.entries[3]
    expect(last?.extraReferences.map((extra) => extra.amountOre)).toEqual([100000, 50000, 40000, -50000])
    // The subtotals add up to the payment — the manual's "delsummor".
    expect(last?.extraReferences.reduce((sum, extra) => sum + extra.amountOre, 0)).toBe(last?.amountOre)
    expect(last?.subtotalsBalanced).toBe(true)
  })

  test('utokad-blankettregistrering.txt: an 88-character line (blank overflow) is accepted', () => {
    const line6 = Buffer.from(official('utokad-blankettregistrering.txt')).toString('latin1').split('\r\n')[5]
    expect(line6).toHaveLength(88)
    expect(parseBgmax(official('utokad-blankettregistrering.txt')).ok).toBe(true)
  })

  test('utokad-blankettregistrering.txt: the organisation number that is not zero-filled', () => {
    // Line 17 is "2900550000432 " — eleven digits, left-aligned: the example
    // itself is wrong. Padding is dropped only down to ten digits.
    const entry = parsedFile(official('utokad-blankettregistrering.txt')).deposits[0]?.entries[1]
    expect(entry?.payer?.organisationNumber).toBe('0550000432')
  })

  test('bildfil.txt: six payments, ten extra references', () => {
    const file = parsedFile(official('bildfil.txt'))
    expect(file.writtenAt).toBe('2005-12-06T17:30:35.010331')
    expect(file.totals).toEqual({ payments: 6, deductions: 0, extraReferences: 10, deposits: 1 })
    expect(file.deposits[0]?.amountOre).toBe(353300)
  })

  test('🔑 ocr-kontroll-langd.txt is refused: two TAB characters at line 17', () => {
    // Exactly one error. The skipped line would also break the end record's
    // count, but the parser stops after the line-hygiene pass — no cascade.
    expect(errorsOf(official('ocr-kontroll-langd.txt'))).toEqual([
      {
        code: 'CONTROL_CHARACTER',
        line: 17,
        message:
          'Otillåtet styrtecken (tabb) i kolumn 13. BgMax är en fil med fasta kolumner; filen har troligen öppnats och sparats om i en textredigerare.'
      }
    ])
  })

  test('ocr-kontroll-langd.txt parses once the tabs are expanded — short lines are padded', () => {
    const file = parsedFile(expandTabs(official('ocr-kontroll-langd.txt')))
    expect(file.totals).toEqual({ payments: 6, deductions: 1, extraReferences: 6, deposits: 2 })
    expect(file.deposits.map((d) => [d.serial, d.amountOre])).toEqual([
      [74, 190000],
      [75, 800000]
    ])
    // The expanded tabs land the reference in its right-aligned place.
    expect(file.deposits[0]?.entries[2]?.extraReferences[3]).toMatchObject({ line: 17, reference: '657965' })
    // A deduction: 1 000 + 1 400 − 500 = 1 900 kr.
    expect(file.deposits[0]?.entries[1]).toMatchObject({ kind: 'deduction', amountOre: 50000, deductionCode: 0 })
  })

  test('🔑 Bankgirot’s own file reuses a BGC serial — it is not a key', () => {
    const entries = parsedFile(expandTabs(official('ocr-kontroll-langd.txt'))).deposits.flatMap((d) => d.entries)
    const serial16 = entries.filter((entry) => entry.bgcSerial === '000000000016')
    expect(serial16.map((entry) => [entry.line, entry.senderBankgiro])).toEqual([
      [35, '1234567'],
      [40, '3783511']
    ])
  })

  test('🔑 wave 2’s key — bankgiro : year : deposit serial : position — is unique in every file', () => {
    const files = ['utan-tillval.txt', 'ocr-kontroll.txt', 'utokad-blankettregistrering.txt', 'bildfil.txt']
      .map((name) => parsedFile(official(name)))
      .concat(parsedFile(expandTabs(official('ocr-kontroll-langd.txt'))))
    const keys = files.flatMap((file) =>
      file.deposits.flatMap((d) =>
        d.entries.map((entry) => `${d.receivingBankgiro}:${d.paymentDate.slice(0, 4)}:${d.serial}:${entry.position}`)
      )
    )
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('all five are marked "P" (production) — the marker cannot spot Bankgirot’s examples', () => {
    for (const name of ['utan-tillval.txt', 'ocr-kontroll.txt', 'utokad-blankettregistrering.txt', 'bildfil.txt']) {
      expect(parsedFile(official(name)).isTest).toBe(false)
    }
    expect(Buffer.from(official('ocr-kontroll-langd.txt')).toString('latin1')[44]).toBe('P')
  })
})

// ─── Encoding ─────────────────────────────────────────────────────────────

describe('encoding', () => {
  test('🔑 a re-saved UTF-8 copy is refused ("Ã¥" for "å")', () => {
    const asUtf8 = new Uint8Array(Buffer.from(Buffer.from(official('utan-tillval.txt')).toString('latin1'), 'utf8'))
    expect(codesOf(asUtf8)).toEqual(['ENCODING'])
    expect(errorsOf(asUtf8)[0]?.message).toContain('Ã¥')
  })

  test('a UTF-8 byte order mark is refused even when the rest is ASCII', () => {
    expect(codesOf(new Uint8Array([0xef, 0xbb, 0xbf, ...buildBgmax({ ...SMALL, deposits: [{ entries: [{ amountOre: 1 }] }] })]))).toEqual([
      'ENCODING'
    ])
  })

  test('UTF-16 is refused', () => {
    expect(codesOf(new Uint8Array([0xff, 0xfe, 0x30, 0x00, 0x31, 0x00]))).toEqual(['ENCODING'])
  })

  test('a pure-ASCII file is fine (ASCII is valid in both encodings)', () => {
    expect(parseBgmax(buildBgmax({ deposits: [{ entries: [{ amountOre: 100 }] }] })).ok).toBe(true)
  })

  test('🔑 why Buffer "latin1" and not TextDecoder("iso-8859-1")', () => {
    // WHATWG maps the label to windows-1252, which turns 0x85 into "…".
    // Decoded as true Latin-1, 0x85 is a C1 control — and is refused.
    expect(new TextDecoder('iso-8859-1').encoding).toBe('windows-1252')
    expect(new TextDecoder('iso-8859-1').decode(new Uint8Array([0x85]))).toBe('…')
    const lines = buildBgmaxLines(SMALL)
    lines[3] = `26Kalles Plåt AB\u0085`.padEnd(80, ' ')
    expect(codesOf(toLatin1(lines))).toEqual(['CONTROL_CHARACTER'])
  })
})

// ─── Lines ────────────────────────────────────────────────────────────────

describe('lines', () => {
  test.each([
    ['LF', '\n'],
    ['CR', '\r']
  ] as const)('%s line endings parse exactly like CRLF', (_name, ending) => {
    const crlf = official('utan-tillval.txt')
    const other = new Uint8Array(Buffer.from(Buffer.from(crlf).toString('latin1').replace(/\r\n/g, ending), 'latin1'))
    expect(parsedFile(other)).toEqual(parsedFile(crlf))
  })

  test('a missing final line ending is fine', () => {
    expect(parseBgmax(buildBgmax(SMALL, { finalLineEnding: false })).ok).toBe(true)
  })

  test('trailing blanks stripped from every line (as editors do) change nothing', () => {
    const stripped = toLatin1(buildBgmaxLines(SMALL).map((line) => line.replace(/ +$/, '')))
    expect(parsedFile(stripped)).toEqual(parsedFile(buildBgmax(SMALL)))
  })

  test('text past column 80 → LINE_TOO_LONG', () => {
    const lines = buildBgmaxLines(SMALL)
    lines[2] = `${lines[2]}EXTRA`
    expect(errorsOf(toLatin1(lines))).toMatchObject([{ code: 'LINE_TOO_LONG', line: 3 }])
  })

  test('a no-break space (0xA0) past column 80 is NOT blank', () => {
    const lines = buildBgmaxLines(SMALL)
    lines[2] = `${lines[2]} `
    expect(codesOf(toLatin1(lines))).toEqual(['LINE_TOO_LONG'])
  })

  test.each([
    ['TAB', '\t'],
    ['NUL', '\u0000'],
    ['DEL', '\u007f']
  ])('%s anywhere → CONTROL_CHARACTER with line and column', (_name, char) => {
    const lines = buildBgmaxLines(SMALL)
    lines[3] = `26Kalles${char}Plåt AB`.padEnd(80, ' ')
    expect(errorsOf(toLatin1(lines))).toMatchObject([{ code: 'CONTROL_CHARACTER', line: 4 }])
    expect(errorsOf(toLatin1(lines))[0]?.message).toContain('kolumn 9')
  })
})

// ─── One file per error code ──────────────────────────────────────────────

describe('errors', () => {
  test('EMPTY_FILE — no bytes, or only line endings', () => {
    expect(codesOf(new Uint8Array())).toEqual(['EMPTY_FILE'])
    expect(codesOf(toLatin1(['', ''], '\r\n'))).toEqual(['EMPTY_FILE'])
  })

  test('STRUCTURE — not a BgMax file at all (a CSV)', () => {
    expect(errorsOf(toLatin1(['datum;belopp;referens', '2026-10-15;1250,00;2026000709']))).toMatchObject([
      { code: 'STRUCTURE', line: 1 }
    ])
  })

  test('FORMAT — another layout name', () => {
    expect(codesOf(buildBgmax({ ...SMALL, layout: 'BGMIN' }))).toEqual(['FORMAT'])
  })

  test('🔑 FORMAT — another layout version is refused, not guessed at', () => {
    expect(errorsOf(buildBgmax({ ...SMALL, version: '02' }))).toMatchObject([
      { code: 'FORMAT', line: 1, message: expect.stringContaining('version 02') }
    ])
  })

  test.each([
    ['a second start record', (lines: string[]) => lines.splice(2, 0, lines[0] ?? '')],
    ['a payment before any opening record', (lines: string[]) => lines.splice(1, 1)],
    ['a name record with no payment before it', (lines: string[]) => lines.splice(2, 1)],
    ['an opening record inside an open section', (lines: string[]) => lines.splice(3, 0, lines[1] ?? '')],
    ['no end record (a truncated file)', (lines: string[]) => lines.pop()],
    ['records after the end record', (lines: string[]) => lines.push(lines[2] ?? '')],
    ['the same payer record twice', (lines: string[]) => lines.splice(3, 0, lines[3] ?? '')]
  ])('STRUCTURE — %s', (_name, bend) => {
    const lines = buildBgmaxLines(SMALL)
    bend(lines)
    expect(codesOf(toLatin1(lines))).toContain('STRUCTURE')
  })

  test('STRUCTURE — a deposit with no payments', () => {
    const lines = buildBgmaxLines(SMALL)
    lines.splice(2, 2) // drop the payment and its name record
    expect(codesOf(toLatin1(lines))).toEqual(['STRUCTURE'])
  })

  test('STRUCTURE — more than 90 information records on one payment', () => {
    const information = Array.from({ length: 91 }, (_, i) => `Rad ${i + 1}`)
    expect(codesOf(buildBgmax({ deposits: [{ entries: [{ amountOre: 100, information }] }] }))).toEqual(['STRUCTURE'])
    expect(parseBgmax(buildBgmax({ deposits: [{ entries: [{ amountOre: 100, information: information.slice(0, 90) }] }] })).ok).toBe(true)
  })

  test.each([
    ['an amount with a blank in it', (lines: string[]) => (lines[2] = `${(lines[2] ?? '').slice(0, 40)} ${(lines[2] ?? '').slice(41)}`)],
    ['a payment date that does not exist (30 February)', (lines: string[]) => (lines[4] = (lines[4] ?? '').replace('20261015', '20260230'))],
    ['a test marker that is neither T nor P', (lines: string[]) => (lines[0] = `${(lines[0] ?? '').slice(0, 44)}X${(lines[0] ?? '').slice(45)}`)],
    ['a timestamp at 25 o’clock', (lines: string[]) => (lines[0] = (lines[0] ?? '').replace('20261015120000', '20261015250000'))],
    ['a reference code that is a letter', (lines: string[]) => (lines[2] = `${(lines[2] ?? '').slice(0, 55)}X${(lines[2] ?? '').slice(56)}`)]
  ])('INVALID_FIELD — %s', (_name, bend) => {
    const lines = buildBgmaxLines(SMALL)
    bend(lines)
    expect(codesOf(toLatin1(lines))).toEqual(['INVALID_FIELD'])
  })

  test('🔑 no cascade: a bad payment record is ONE error, not one per record after it', () => {
    const lines = buildBgmaxLines({
      deposits: [{ entries: [{ amountOre: 100, payer: { name: 'A', address: 'B', city: 'C', organisationNumber: '5567037485' } }] }]
    })
    lines[2] = `${(lines[2] ?? '').slice(0, 40)}X${(lines[2] ?? '').slice(41)}`
    expect(codesOf(toLatin1(lines))).toEqual(['INVALID_FIELD'])
  })

  test('AMOUNT_TOO_LARGE — 2^53 öre cannot be held exactly', () => {
    expect(codesOf(buildBgmax({ deposits: [{ entries: [{ amountOre: 2 ** 53 }], amountOreOverride: 1 }] }))).toContain(
      'AMOUNT_TOO_LARGE'
    )
  })

  test('CURRENCY — EUR in the opening record, and in the deposit record', () => {
    expect(codesOf(buildBgmax({ deposits: [{ ...SMALL.deposits[0], entries: SMALL.deposits[0]?.entries ?? [], currency: 'EUR' }] }))).toEqual([
      'CURRENCY',
      'CURRENCY'
    ])
    expect(codesOf(buildBgmax({ deposits: [{ entries: [{ amountOre: 100 }], depositCurrencyOverride: 'EUR' }] }))).toEqual(['CURRENCY'])
  })

  test('DEPOSIT_AMOUNT — the deposit does not equal payments minus deductions', () => {
    const errors = errorsOf(buildBgmax({ deposits: [{ entries: [{ amountOre: 125000 }], amountOreOverride: 125001 }] }))
    expect(errors).toMatchObject([{ code: 'DEPOSIT_AMOUNT', line: 4 }])
    expect(errors[0]?.message).toBe('Insättningen är 1 250,01 kr men betalningar minus avdrag blir 1 250,00 kr.')
  })

  test('DEPOSIT_COUNT — the deposit states the wrong number of records', () => {
    expect(codesOf(buildBgmax({ deposits: [{ entries: [{ amountOre: 100 }], entryCountOverride: 2 }] }))).toEqual(['DEPOSIT_COUNT'])
  })

  test.each([['payments'], ['deductions'], ['extraReferences'], ['deposits']] as const)(
    'FILE_TOTALS — the end record’s %s count is wrong',
    (key) => {
      expect(codesOf(buildBgmax({ ...SMALL, totalsOverride: { [key]: 7 } }))).toEqual(['FILE_TOTALS'])
    }
  )

  test('🔑 TOO_MANY_LINES — counted on the bytes, before anything is split', () => {
    // 2 MiB of bare line endings once grew to ~470 MB as padded lines.
    expect(codesOf(new Uint8Array(MAX_LINES).fill(0x0a))).toEqual(['TOO_MANY_LINES'])
    expect(codesOf(new Uint8Array(2 * 1024 * 1024).fill(0x0d))).toEqual(['TOO_MANY_LINES'])
    // Exactly at the limit, the line count is not what stops the file.
    expect(codesOf(new Uint8Array(MAX_LINES - 1).fill(0x0a))).toEqual(['EMPTY_FILE'])
  })

  test('🔑 STRUCTURE — an extra reference whose BGC serial is not its payment’s', () => {
    const lines = buildBgmaxLines({
      deposits: [{ entries: [{ amountOre: 100, extraReferences: [{ reference: '2026000709' }] }] }]
    })
    lines[3] = `${(lines[3] ?? '').slice(0, 57)}999999999999${(lines[3] ?? '').slice(69)}`
    expect(errorsOf(toLatin1(lines))).toMatchObject([{ code: 'STRUCTURE', line: 4, message: expect.stringContaining('rad 3') }])
  })

  test('🔑 STRUCTURE — one character deleted inside an extra reference shifts its columns', () => {
    // Without the parent check this was ACCEPTED with a different subtotal.
    const lines = buildBgmaxLines({
      deposits: [{ entries: [{ amountOre: 100000, referenceCode: 0, extraReferences: [{ reference: 'FAKTURA 7', referenceCode: 4, amountOre: 100000 }] }] }]
    })
    lines[3] = `${(lines[3] ?? '').slice(0, 14)}${(lines[3] ?? '').slice(15)}`
    expect(codesOf(toLatin1(lines))).toContain('STRUCTURE')
  })

  test('STRUCTURE — an extra reference that drifted onto the wrong payment past an unknown record', () => {
    const lines = buildBgmaxLines({
      deposits: [
        {
          entries: [
            { amountOre: 100 },
            { amountOre: 200, extraReferences: [{ reference: '2026000709' }] }
          ]
        }
      ]
    })
    // Move payment 2's extra reference up under payment 1, behind an unknown record.
    const extra = lines.splice(4, 1)[0] ?? ''
    lines.splice(3, 0, '24OKÄND'.padEnd(80, ' '), extra)
    expect(codesOf(toLatin1(lines))).toContain('STRUCTURE')
  })

  test('🔑 DUPLICATE_DEPOSIT — two deposits with one serial (same bankgiro, same year)', () => {
    const errors = errorsOf(
      buildBgmax({
        deposits: [
          { serial: 7, entries: [{ amountOre: 100 }] },
          { serial: 7, entries: [{ amountOre: 999900 }] }
        ]
      })
    )
    expect(errors).toMatchObject([{ code: 'DUPLICATE_DEPOSIT', line: 7 }])
  })

  test('the same serial in another year, or for another bankgiro, is fine', () => {
    expect(
      parseBgmax(
        buildBgmax({
          deposits: [
            { serial: 7, paymentDate: '2025-12-31', entries: [{ amountOre: 100 }] },
            { serial: 7, paymentDate: '2026-01-02', entries: [{ amountOre: 100 }] },
            { serial: 7, paymentDate: '2026-01-02', receivingBankgiro: '58410000', entries: [{ amountOre: 100 }] }
          ]
        })
      ).ok
    ).toBe(true)
  })

  test(`TOO_MANY_ERRORS — reporting stops after ${MAX_ISSUES}`, () => {
    const lines = buildBgmaxLines({ deposits: [{ entries: Array.from({ length: 60 }, () => ({ amountOre: 100 })) }] })
    for (let i = 2; i < 62; i += 1) lines[i] = `${(lines[i] ?? '').slice(0, 40)}X${(lines[i] ?? '').slice(41)}`
    const errors = errorsOf(toLatin1(lines))
    expect(errors).toHaveLength(MAX_ISSUES + 1)
    expect(errors.at(-1)?.code).toBe('TOO_MANY_ERRORS')
  })

  test('every message is Swedish text, never empty', () => {
    const lines = buildBgmaxLines(SMALL)
    lines[2] = `${(lines[2] ?? '').slice(0, 40)}X${(lines[2] ?? '').slice(41)}`
    for (const issue of errorsOf(toLatin1(lines))) {
      expect(issue.message.length).toBeGreaterThan(10)
      expect(issue.message).not.toContain('undefined')
    }
  })
})

// ─── Warnings ─────────────────────────────────────────────────────────────

describe('warnings — ignored, as the manual asks', () => {
  test('🔑 an unknown record type is skipped and does not end the payment', () => {
    const lines = buildBgmaxLines(SMALL)
    lines.splice(3, 0, '24EN FRAMTIDA POSTTYP'.padEnd(80, ' ')) // between the payment and its name record
    const result = parseBgmax(toLatin1(lines))
    expect(result.ok).toBe(true)
    expect(result.warnings).toMatchObject([{ code: 'UNKNOWN_RECORD', line: 4 }])
    // The name record after it still belongs to the payment.
    expect(result.ok && result.file.deposits[0]?.entries[0]?.payer?.name).toBe('Kalles Plåt AB')
  })

  test('SUSPICIOUS_DATE — a deposit dated after the file was written is reported, not refused', () => {
    const result = parseBgmax(
      buildBgmax({ writtenAt: '20261015120000000000', deposits: [{ paymentDate: '2095-10-15', entries: [{ amountOre: 100 }] }] })
    )
    expect(result.ok).toBe(true)
    expect(result.warnings).toMatchObject([{ code: 'SUSPICIOUS_DATE', line: 4 }])
  })

  test('a blank line in the middle is skipped with a warning', () => {
    const lines = buildBgmaxLines(SMALL)
    lines.splice(2, 0, '')
    const result = parseBgmax(toLatin1(lines))
    expect(result.ok).toBe(true)
    expect(result.warnings).toMatchObject([{ code: 'BLANK_LINE', line: 3 }])
  })
})

// ─── Money ────────────────────────────────────────────────────────────────

describe('money', () => {
  test('🔑 deposit sums are exact even when a running sum passes 2^53', () => {
    // (2^53 − 1) + 2 − (2^53 − 1) = 2. In floating point the first sum
    // rounds to 2^53 and the answer comes out 1 — a false mismatch.
    const MAX = Number.MAX_SAFE_INTEGER
    expect(MAX + 2 - MAX).toBe(1) // the trap, in plain JS numbers
    const file = parsedFile(
      buildBgmax({
        deposits: [{ entries: [{ amountOre: MAX }, { amountOre: 2 }, { kind: 'deduction', amountOre: MAX }] }]
      })
    )
    expect(file.deposits[0]?.amountOre).toBe(2)
  })

  test('a deduction subtracts; TK23 is a negative extra reference', () => {
    const file = parsedFile(
      buildBgmax({
        deposits: [
          {
            entries: [
              {
                amountOre: 100000,
                referenceCode: 4,
                reference: 'FAKTURA 7',
                extraReferences: [
                  { reference: '2026000709', amountOre: 120000 },
                  { reference: 'KREDIT 3', amountOre: -20000, referenceCode: 4 }
                ]
              },
              { kind: 'deduction', amountOre: 30000, deductionCode: 1 }
            ]
          }
        ]
      })
    )
    const [payment, deduction] = file.deposits[0]?.entries ?? []
    expect(file.deposits[0]?.amountOre).toBe(70000)
    expect(payment?.extraReferences.map((extra) => extra.amountOre)).toEqual([120000, -20000])
    expect(deduction).toMatchObject({ kind: 'deduction', amountOre: 30000, deductionCode: 1, position: 2 })
    expect(file.totals).toEqual({ payments: 1, deductions: 1, extraReferences: 2, deposits: 1 })
  })

  test('🔑 subtotalsBalanced: reported, never trusted blindly — and never fatal', () => {
    // A 100 kr payment claiming 10 000 + 5 000 kr of subtotals is accepted
    // (the manual never says subtotals must balance), but flagged, so wave 2
    // does not split money by them.
    const entries = (extraReferences: { reference: string; amountOre: number }[]) =>
      parsedFile(buildBgmax({ deposits: [{ entries: [{ amountOre: 10000, referenceCode: 0, extraReferences }] }] })).deposits[0]?.entries[0]
    expect(entries([{ reference: '2026000709', amountOre: 1000000 }, { reference: '2026000808', amountOre: 500000 }])?.subtotalsBalanced).toBe(false)
    expect(entries([{ reference: '2026000709', amountOre: 6000 }, { reference: '2026000808', amountOre: 4000 }])?.subtotalsBalanced).toBe(true)
    expect(entries([{ reference: '2026000709', amountOre: 0 }])?.subtotalsBalanced).toBeNull()
  })

  test('a zero TK23 is 0, not -0', () => {
    const lines = buildBgmaxLines({ deposits: [{ entries: [{ amountOre: 100, extraReferences: [{ reference: '1', amountOre: 0 }] }] }] })
    lines[3] = `23${(lines[3] ?? '').slice(2)}`
    const amount = parsedFile(toLatin1(lines)).deposits[0]?.entries[0]?.extraReferences[0]?.amountOre
    expect(Object.is(amount, 0)).toBe(true)
  })
})

// ─── Robustness ───────────────────────────────────────────────────────────

describe('never throws on content', () => {
  // Small deterministic PRNG (mulberry32), so a failure can be reproduced.
  function random(seed: number): () => number {
    let state = seed
    return () => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  test('🔑 2 500 mutated official files and 500 random byte strings', () => {
    const next = random(20261015)
    const pick = (n: number) => Math.floor(next() * n)
    const sources = ['utan-tillval.txt', 'ocr-kontroll.txt', 'utokad-blankettregistrering.txt', 'bildfil.txt', 'ocr-kontroll-langd.txt'].map(official)
    let accepted = 0

    for (let i = 0; i < 2500; i += 1) {
      const bytes = Array.from(sources[i % sources.length] ?? new Uint8Array())
      const mutations = 1 + pick(3)
      for (let m = 0; m < mutations; m += 1) {
        const at = pick(bytes.length)
        const kind = pick(4)
        if (kind === 0) bytes[at] = pick(256) // any byte
        else if (kind === 1) bytes[at] = 0x30 + pick(10) // a plausible digit
        else if (kind === 2) bytes.splice(at, 1 + pick(40)) // a cut
        else bytes.splice(at, 0, ...bytes.slice(pick(bytes.length), pick(bytes.length))) // a duplicated slice
      }
      const result = parseBgmax(new Uint8Array(bytes))
      if (result.ok) accepted += 1
      else for (const issue of result.errors) expect(typeof issue.message).toBe('string')
    }
    for (let i = 0; i < 500; i += 1) {
      parseBgmax(new Uint8Array(Array.from({ length: pick(400) }, () => pick(256))))
    }
    // Most mutations break a check; a few land in free text and pass.
    expect(accepted).toBeLessThan(2500)
  })

  test('the wrong argument type is a programming error — it throws', () => {
    expect(() => parseBgmax('01BGMAX' as unknown as Uint8Array)).toThrow(TypeError)
  })
})

describe('parseBgmaxOrThrow', () => {
  test('returns the file', () => {
    expect(parseBgmaxOrThrow(official('bildfil.txt')).totals.payments).toBe(6)
  })

  test('throws a 400 ValidationError carrying every issue', () => {
    let thrown: unknown = null
    try {
      parseBgmaxOrThrow(official('ocr-kontroll-langd.txt'))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ValidationError)
    expect((thrown as ValidationError).statusCode).toBe(400)
    expect((thrown as ValidationError).details).toMatchObject({ errors: [{ code: 'CONTROL_CHARACTER', line: 17 }] })
  })
})

describe('the builder', () => {
  test('refuses a character Latin-1 cannot hold — Buffer would silently write the low byte', () => {
    expect(Buffer.from('€', 'latin1')).toEqual(Buffer.from([0xac])) // the trap: '€' became '¬'
    expect(() => buildBgmax({ deposits: [{ entries: [{ amountOre: 1, payer: { name: 'Café €' } }] }] })).toThrow('Latin-1')
  })

  test('refuses a value wider than its field instead of cutting it', () => {
    expect(() => buildBgmax({ deposits: [{ entries: [{ amountOre: 1, reference: '1'.repeat(26) }] }] })).toThrow('25')
  })
})
