// csv.ts — CSV that opens correctly in Swedish Excel.
//
// "CSV" is not one format. Excel reads the file according to the machine's
// locale, and a Swedish locale uses the comma as the DECIMAL separator — so
// a comma-separated file with "12345,67" in it is torn apart at the wrong
// place and every amount lands in two cells. Swedish Excel expects:
//
//   - a semicolon between fields
//   - a comma as decimal separator
//   - a UTF-8 byte order mark, or åäö come out as Ã¥Ã¤Ã¶
//   - CRLF line endings (LF alone works in most places, CRLF in all)
//
// This file produces exactly that and nothing else. Amounts are formatted
// from öre to a decimal STRING here — the one place öre become a decimal on
// the way out — and are never parsed back.

/** The UTF-8 byte order mark. Excel uses it to pick the right decoding. */
const BOM = '﻿'
const SEPARATOR = ';'
const NEWLINE = '\r\n'

export type CsvCell = string | number | null | undefined

/**
 * Quotes a cell when it must be quoted: it contains the separator, a quote,
 * or a line break. A quote inside is doubled, per RFC 4180.
 *
 * A leading =, +, - or @ is prefixed with a tab. Without that, a description
 * of "=1+1" or "@SUM(...)" is EXECUTED as a formula when the file is opened —
 * a real attack against anyone who exports data typed by others.
 */
function escapeCell(value: CsvCell): string {
  if (value === null || value === undefined) return ''

  let text = String(value)

  if (/^[=+\-@]/.test(text)) {
    text = `\t${text}`
  }

  if (text.includes(SEPARATOR) || text.includes('"') || /[\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }

  return text
}

/**
 * Öre to "12345,67" — a decimal string with a Swedish comma, no grouping.
 *
 * No thousands separator: Excel would treat "12 345,67" as text. The
 * display formatting belongs to the spreadsheet, not the file.
 */
export function csvAmount(ore: number): string {
  const sign = ore < 0 ? '-' : ''
  const absolute = Math.abs(ore)
  return `${sign}${Math.floor(absolute / 100)},${String(absolute % 100).padStart(2, '0')}`
}

/** Builds the whole file. Header row first. */
export function toCsv(header: string[], rows: CsvCell[][]): string {
  const lines = [header, ...rows].map((row) => row.map(escapeCell).join(SEPARATOR))
  return BOM + lines.join(NEWLINE) + NEWLINE
}
