// exports.test.ts — CSV and SIE, the two file formats we hand to accountants.

import { describe, test, expect } from 'bun:test'
import { toCsv, csvAmount } from '../../src/lib/csv.ts'
import { buildSie, sieAmount, encodeCp437 } from '../../src/lib/sie.ts'

describe('csv', () => {
  test('amounts use a comma and no grouping', () => {
    expect(csvAmount(1_234_567)).toBe('12345,67')
    expect(csvAmount(5)).toBe('0,05')
    expect(csvAmount(-6_000)).toBe('-60,00')
  })

  test('starts with a BOM, separates with semicolons, ends lines with CRLF', () => {
    const csv = toCsv(['a', 'b'], [['x', 1]])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.slice(1)).toBe('a;b\r\nx;1\r\n')
  })

  test('quotes a cell containing the separator or a quote', () => {
    const csv = toCsv(['a'], [['Ek; Partner'], ['Say "hi"']])
    expect(csv).toContain('"Ek; Partner"')
    expect(csv).toContain('"Say ""hi"""')
  })

  test('🔒 neutralises a formula in a cell', () => {
    // A description of "=1+1" typed by a customer would EXECUTE in Excel.
    const csv = toCsv(['d'], [['=1+1'], ['+SUM(A1)'], ['@cmd']])
    expect(csv).toContain('\t=1+1')
    expect(csv).toContain('\t+SUM(A1)')
    expect(csv).toContain('\t@cmd')
  })

  test('empty cells stay empty', () => {
    expect(toCsv(['a', 'b'], [[null, undefined]]).slice(1)).toBe('a;b\r\n;\r\n')
  })
})

describe('sie', () => {
  const base = {
    companyName: 'Fakturly Demo AB',
    orgNumber: '559123-4567',
    year: 2026,
    generatedAt: new Date('2026-09-04T10:00:00Z'),
    accounts: [{ number: '1510', name: 'Kundfordringar' }]
  }

  test('amounts use a dot, two decimals, exact', () => {
    expect(sieAmount(1_250_000)).toBe('12500.00')
    expect(sieAmount(-1)).toBe('-0.01')
    expect(sieAmount(0)).toBe('0.00')
  })

  test('writes the header and one verification', () => {
    const text = buildSie({
      ...base,
      verifications: [
        {
          date: new Date('2026-01-15T00:00:00Z'),
          text: 'Faktura 2026-0001',
          transactions: [
            { account: '1510', amountOre: 1_250_000 },
            { account: '3001', amountOre: -1_000_000 },
            { account: '2611', amountOre: -250_000 }
          ]
        }
      ]
    })

    expect(text).toContain('#FLAGGA 0\r\n')
    expect(text).toContain('#GEN 20260904')
    expect(text).toContain('#FNAMN "Fakturly Demo AB"')
    expect(text).toContain('#VER "A" 1 20260115 "Faktura 2026-0001"')
    expect(text).toContain('   #TRANS 1510 {} 12500.00')
    expect(text).toContain('   #TRANS 3001 {} -10000.00')
  })

  test('🔑 refuses a verification that does not balance', () => {
    expect(() =>
      buildSie({
        ...base,
        verifications: [
          {
            date: new Date(),
            text: 'Trasig',
            transactions: [{ account: '1510', amountOre: 100 }, { account: '3001', amountOre: -99 }]
          }
        ]
      })
    ).toThrow(/does not balance/)
    // Double-entry bookkeeping: an importer would reject it anyway. Better
    // to fail here than hand an accountant a file that will not load.
  })

  test('escapes a quote inside a text', () => {
    const text = buildSie({
      ...base,
      verifications: [{ date: new Date(), text: 'Kund "AB"', transactions: [{ account: '1510', amountOre: 1 }, { account: '3001', amountOre: -1 }] }]
    })
    expect(text).toContain('"Kund \\"AB\\""')
  })

  test('encodes Swedish letters as CP437 bytes', () => {
    const bytes = encodeCp437('Påminnelseavgifter ÅÄÖ')
    expect(bytes[1]).toBe(0x86) // å
    expect(bytes.subarray(19, 22)).toEqual(Buffer.from([0x8f, 0x8e, 0x99]))
    expect(bytes.length).toBe(22) // one byte per character, not UTF-8's two
  })

  test('replaces anything it cannot encode with a visible ?', () => {
    expect(encodeCp437('a€b').toString('latin1')).toBe('a?b')
  })
})
