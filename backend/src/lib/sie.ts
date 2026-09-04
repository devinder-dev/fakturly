// sie.ts — the SIE 4 export format.
//
// SIE is the file format every Swedish accounting system imports: Fortnox,
// Visma, Bokio, Björn Lundén, and the auditor's software. Exporting to it
// means Fakturly's ledger can land in a real set of books without anyone
// re-keying an invoice. The specification is from SIE-gruppen; type 4 is the
// one carrying verifications (journal entries).
//
// The shape of the file:
//
//   #FLAGGA 0                       "not yet imported"
//   #PROGRAM "Fakturly" 1.0
//   #FORMAT PC8                     the character encoding — see below
//   #GEN 20260904
//   #SIETYP 4
//   #FNAMN "Fakturly Demo AB"
//   #ORGNR 559123-4567
//   #RAR 0 20260101 20261231        the financial year
//   #KONTO 1510 "Kundfordringar"    every account used
//   #VER "A" 1 20260115 "Faktura 2026-0001"
//   {
//      #TRANS 1510 {} 12500.00
//      #TRANS 3001 {} -10000.00
//      #TRANS 2611 {} -2500.00
//   }
//
// Debits are positive, credits negative, and every #VER must sum to zero —
// double-entry bookkeeping, enforced by a check at the end of this file.
//
// PC8 is IBM code page 437, a 1980s DOS encoding, and the spec still names
// it. Modern importers accept UTF-8 as well, but the conservative choice is
// the one every importer accepts, so this file writes CP437 bytes. Only the
// Swedish letters need mapping; everything else on an invoice is ASCII.

export type SieAccount = { number: string; name: string }

export type SieTransaction = {
  account: string
  /** Öre. Positive = debit, negative = credit. */
  amountOre: number
}

export type SieVerification = {
  date: Date
  text: string
  transactions: SieTransaction[]
}

export type SieDocument = {
  companyName: string
  orgNumber: string
  year: number
  generatedAt: Date
  accounts: SieAccount[]
  verifications: SieVerification[]
}

/** "20260904" */
function sieDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

/** Öre to "12500.00" — a dot, no grouping, always two decimals. Exact. */
export function sieAmount(ore: number): string {
  const sign = ore < 0 ? '-' : ''
  const absolute = Math.abs(ore)
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

/** Quotes a text field. SIE uses double quotes; an embedded quote is escaped with a backslash. */
function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Builds the file as text. Encoding to bytes is a separate step, so the
 * text can be inspected in tests without decoding CP437 first.
 */
export function buildSie(document: SieDocument): string {
  const lines: string[] = []

  lines.push('#FLAGGA 0')
  lines.push('#PROGRAM "Fakturly" 1.0')
  lines.push('#FORMAT PC8')
  lines.push(`#GEN ${sieDate(document.generatedAt)}`)
  lines.push('#SIETYP 4')
  lines.push(`#FNAMN ${quote(document.companyName)}`)
  lines.push(`#ORGNR ${document.orgNumber}`)
  lines.push(`#RAR 0 ${document.year}0101 ${document.year}1231`)
  lines.push('#VALUTA SEK')

  for (const account of document.accounts) {
    lines.push(`#KONTO ${account.number} ${quote(account.name)}`)
  }

  document.verifications.forEach((verification, index) => {
    const balance = verification.transactions.reduce((sum, t) => sum + t.amountOre, 0)
    if (balance !== 0) {
      // A verification that does not balance would be rejected by every
      // importer, and would mean a bug in how the ledger was mapped. Better
      // to fail here, loudly, than to hand an accountant a broken file.
      throw new Error(
        `SIE verification ${index + 1} ("${verification.text}") does not balance: ${balance} öre`
      )
    }

    lines.push(`#VER "A" ${index + 1} ${sieDate(verification.date)} ${quote(verification.text)}`)
    lines.push('{')
    for (const transaction of verification.transactions) {
      lines.push(`   #TRANS ${transaction.account} {} ${sieAmount(transaction.amountOre)}`)
    }
    lines.push('}')
  })

  return lines.join('\r\n') + '\r\n'
}

/**
 * The CP437 bytes for the characters that differ from ASCII.
 *
 * Only what a Swedish invoice can contain. Anything else outside ASCII
 * becomes '?', which is visible and honest — a silently wrong byte would
 * pass every check and show up as garbage in someone's books.
 */
const CP437: Record<string, number> = {
  å: 0x86,
  ä: 0x84,
  ö: 0x94,
  Å: 0x8f,
  Ä: 0x8e,
  Ö: 0x99,
  é: 0x82,
  É: 0x90,
  ü: 0x81,
  Ü: 0x9a
}

export function encodeCp437(text: string): Buffer {
  const bytes = new Uint8Array(text.length)
  let i = 0

  for (const char of text) {
    const code = char.charCodeAt(0)
    bytes[i] = code < 0x80 ? code : (CP437[char] ?? 0x3f) // 0x3f = '?'
    i += 1
  }

  return Buffer.from(bytes.subarray(0, i))
}
