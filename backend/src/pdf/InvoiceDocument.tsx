// pdf/InvoiceDocument.tsx — the printed invoice.
//
// WHY REACT IN THE BACKEND: @react-pdf/renderer describes a PDF as a tree of
// components and lays it out with flexbox — the same mental model as the
// frontend, with no DOM and no browser. The alternative, pdfkit, is a pen:
// doc.text('Netto', 320, 540) for every label, and a table becomes a page of
// arithmetic. For a document whose layout must not break, flexbox wins.
//
// WHAT THE LAW REQUIRES on a Swedish invoice (mervärdesskattelagen 17 kap.),
// and where each item is rendered below:
//
//   fakturadatum                    Header, "Fakturadatum"
//   löpnummer (unbroken series)     Header, the invoice number
//   säljarens momsregistreringsnr   Seller block, "Momsreg.nr"
//   säljarens namn och adress       Seller block
//   köparens namn och adress        Buyer block
//   varornas/tjänsternas omfattning The line table
//   beskattningsunderlag per sats   Totals, one row per VAT rate
//   momssats och momsbelopp         Same rows
//   "Godkänd för F-skatt"           Footer — without it the buyer must
//                                   withhold tax on the payment
//
// Not required by law but expected by every Swedish accounts department:
// förfallodatum, bankgiro, OCR reference, and the late-fee terms — which
// must be STATED on the invoice for the fee to be chargeable at all.
//
// This file is presentation only. Every number arrives already calculated;
// the only arithmetic is grouping VAT by rate for the totals block, and
// that is a sum of stored integers.

import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { formatOre, totalDueOre } from '../lib/money.ts'
import type { InvoiceRecord } from '../repositories/invoice.repository.ts'
import type { ClientRecord } from '../repositories/client.repository.ts'

export type SellerDetails = {
  name: string
  address: string
  orgNumber: string
  vatNumber: string
  email: string
  bankgiro: string
}

export type InvoiceDocumentProps = {
  invoice: InvoiceRecord
  client: ClientRecord
  seller: SellerDetails
  ocrReference: string
  /** Statutory reminder fee, stated as a term on the invoice. */
  reminderFeeOre: number
}

const styles = StyleSheet.create({
  page: {
    padding: 48,
    fontFamily: 'Helvetica',
    fontSize: 10,
    color: '#0f172a',
    lineHeight: 1.4
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 32
  },
  // lineHeight in points, not a multiplier: the page-level 1.4 multiplier
  // gave a 22pt title a line box too short for its own glyphs, and the
  // seller name below rendered on top of it.
  title: { fontSize: 22, fontFamily: 'Helvetica-Bold', letterSpacing: 1, lineHeight: 1.1, marginBottom: 6 },
  meta: { alignItems: 'flex-end' },
  metaRow: { flexDirection: 'row', gap: 8 },
  metaLabel: { color: '#64748b', width: 90, textAlign: 'right' },
  metaValue: { fontFamily: 'Helvetica-Bold', width: 80, textAlign: 'right' },

  parties: { flexDirection: 'row', gap: 24, marginBottom: 28 },
  party: { flex: 1 },
  partyLabel: {
    fontSize: 8,
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4
  },
  partyName: { fontFamily: 'Helvetica-Bold', fontSize: 11 },

  table: { marginBottom: 20 },
  tableHead: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#0f172a',
    paddingBottom: 4,
    marginBottom: 2,
    fontSize: 8,
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.8
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: '#e2e8f0',
    paddingVertical: 5
  },
  colDescription: { flex: 5 },
  colQty: { flex: 1, textAlign: 'right' },
  colPrice: { flex: 2, textAlign: 'right' },
  colVat: { flex: 1, textAlign: 'right' },
  colAmount: { flex: 2, textAlign: 'right' },

  totals: { alignSelf: 'flex-end', width: 260 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  totalLabel: { color: '#475569' },
  grand: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#0f172a',
    marginTop: 4,
    paddingTop: 6,
    fontSize: 12,
    fontFamily: 'Helvetica-Bold'
  },

  payment: {
    marginTop: 28,
    padding: 12,
    backgroundColor: '#f1f5f9',
    borderRadius: 4,
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  paymentBlock: { gap: 2 },
  paymentLabel: { fontSize: 8, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.8 },
  paymentValue: { fontFamily: 'Helvetica-Bold', fontSize: 11 },

  terms: { marginTop: 20, fontSize: 8, color: '#475569' },

  footer: {
    position: 'absolute',
    left: 48,
    right: 48,
    bottom: 32,
    borderTopWidth: 0.5,
    borderTopColor: '#cbd5e1',
    paddingTop: 8,
    fontSize: 8,
    color: '#64748b',
    flexDirection: 'row',
    justifyContent: 'space-between'
  },

  status: {
    marginTop: 8,
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: '#166534'
  }
})

const date = (value: Date) => value.toLocaleDateString('sv-SE')

/** An amount without its currency, for table cells where the unit is implied. */
const plain = (ore: number) => formatOre(ore, '').trim()

/** "25 %" from basis points. */
const vatPercent = (basisPoints: number) => `${basisPoints / 100} %`

/**
 * Groups line VAT by rate for the totals block.
 *
 * The law asks for the taxable amount and the VAT amount PER RATE, not a
 * single VAT total. A consulting invoice with one book on it has two rows
 * here. Summing stored integers — nothing is recalculated.
 */
function vatByRate(invoice: InvoiceRecord) {
  const groups = new Map<number, { netOre: number; vatOre: number }>()

  for (const item of invoice.items) {
    const group = groups.get(item.vatRate) ?? { netOre: 0, vatOre: 0 }
    group.netOre += item.netOre
    group.vatOre += item.vatOre
    groups.set(item.vatRate, group)
  }

  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, sums]) => ({ rate, ...sums }))
}

export function InvoiceDocument({
  invoice,
  client,
  seller,
  ocrReference,
  reminderFeeOre
}: InvoiceDocumentProps) {
  const currency = invoice.currency
  const due = totalDueOre(invoice)
  const isPaid = invoice.status === 'PAID'
  const isCreditNote = invoice.type === 'CREDIT_NOTE'
  const isCredited = invoice.status === 'CREDITED'
  // A credit note asks for no payment; a credited invoice no longer does.
  const showPayment = !isPaid && !isCreditNote && !isCredited
  const kind = isCreditNote ? 'Kreditfaktura' : 'Faktura'

  return (
    <Document
      title={`${kind} ${invoice.invoiceNumber}`}
      author={seller.name}
      subject={`${kind} ${invoice.invoiceNumber} till ${client.name}`}
    >
      <Page size="A4" style={styles.page}>
        {/* ── Header ─────────────────────────────────────────── */}
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>{kind.toUpperCase()}</Text>
            <Text style={{ color: '#64748b', marginTop: 2 }}>{seller.name}</Text>
            {isPaid && invoice.paidAt && (
              <Text style={styles.status}>BETALD {date(invoice.paidAt)}</Text>
            )}
            {/*
              The reference to what is being credited is required on a
              credit note — without it the customer's bookkeeping cannot
              match the two documents.
            */}
            {isCreditNote && invoice.creditsInvoice && (
              <Text style={styles.status}>KREDITERAR FAKTURA {invoice.creditsInvoice.invoiceNumber}</Text>
            )}
            {isCredited && invoice.creditNotes[0] && (
              <Text style={{ ...styles.status, color: '#b91c1c' }}>
                KREDITERAD GENOM {invoice.creditNotes[0].invoiceNumber}
              </Text>
            )}
          </View>

          <View style={styles.meta}>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Fakturanummer</Text>
              <Text style={styles.metaValue}>{invoice.invoiceNumber}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Fakturadatum</Text>
              <Text style={styles.metaValue}>{date(invoice.issueDate)}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Förfallodatum</Text>
              <Text style={styles.metaValue}>{date(invoice.dueDate)}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>OCR-referens</Text>
              <Text style={styles.metaValue}>{ocrReference}</Text>
            </View>
          </View>
        </View>

        {/* ── Parties ────────────────────────────────────────── */}
        <View style={styles.parties}>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>Fakturamottagare</Text>
            <Text style={styles.partyName}>{client.name}</Text>
            {client.address && <Text>{client.address}</Text>}
            <Text>{client.email}</Text>
          </View>

          <View style={styles.party}>
            <Text style={styles.partyLabel}>Avsändare</Text>
            <Text style={styles.partyName}>{seller.name}</Text>
            <Text>{seller.address}</Text>
            <Text>{seller.email}</Text>
            <Text>Org.nr {seller.orgNumber}</Text>
            <Text>Momsreg.nr {seller.vatNumber}</Text>
          </View>
        </View>

        {/* ── Lines ──────────────────────────────────────────── */}
        <View style={styles.table}>
          <View style={styles.tableHead}>
            <Text style={styles.colDescription}>Beskrivning</Text>
            <Text style={styles.colQty}>Antal</Text>
            <Text style={styles.colPrice}>À-pris</Text>
            <Text style={styles.colVat}>Moms</Text>
            <Text style={styles.colAmount}>Belopp</Text>
          </View>

          {invoice.items.map((item) => (
            <View key={item.id} style={styles.row} wrap={false}>
              <Text style={styles.colDescription}>{item.description}</Text>
              <Text style={styles.colQty}>{item.quantity}</Text>
              <Text style={styles.colPrice}>{plain(item.unitPriceOre)}</Text>
              <Text style={styles.colVat}>{vatPercent(item.vatRate)}</Text>
              <Text style={styles.colAmount}>{plain(item.netOre)}</Text>
            </View>
          ))}
        </View>

        {/* ── Totals ─────────────────────────────────────────── */}
        <View style={styles.totals}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Netto</Text>
            <Text>{formatOre(invoice.netTotalOre, currency)}</Text>
          </View>

          {vatByRate(invoice).map((group) => (
            <View key={group.rate} style={styles.totalRow}>
              <Text style={styles.totalLabel}>
                Moms {vatPercent(group.rate)} på {formatOre(group.netOre, currency)}
              </Text>
              <Text>{formatOre(group.vatOre, currency)}</Text>
            </View>
          ))}

          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Summa inkl. moms</Text>
            <Text>{formatOre(invoice.grossTotalOre, currency)}</Text>
          </View>

          {invoice.lateFeeOre > 0 && (
            <View style={styles.totalRow}>
              <Text style={{ ...styles.totalLabel, color: '#b91c1c' }}>Dröjsmålsränta</Text>
              <Text style={{ color: '#b91c1c' }}>{formatOre(invoice.lateFeeOre, currency)}</Text>
            </View>
          )}

          {invoice.reminderFeeOre > 0 && (
            <View style={styles.totalRow}>
              <Text style={{ ...styles.totalLabel, color: '#b91c1c' }}>Påminnelseavgift</Text>
              <Text style={{ color: '#b91c1c' }}>{formatOre(invoice.reminderFeeOre, currency)}</Text>
            </View>
          )}

          <View style={styles.grand}>
            <Text>{isPaid ? 'Betalt' : isCreditNote ? 'Tillgodo' : isCredited ? 'Krediterat' : 'Att betala'}</Text>
            <Text>{formatOre(isCreditNote || isCredited ? invoice.grossTotalOre : due, currency)}</Text>
          </View>
        </View>

        {/* ── Payment ────────────────────────────────────────── */}
        {showPayment && (
          <View style={styles.payment}>
            <View style={styles.paymentBlock}>
              <Text style={styles.paymentLabel}>Bankgiro</Text>
              <Text style={styles.paymentValue}>{seller.bankgiro}</Text>
            </View>
            <View style={styles.paymentBlock}>
              <Text style={styles.paymentLabel}>OCR / referens</Text>
              <Text style={styles.paymentValue}>{ocrReference}</Text>
            </View>
            <View style={styles.paymentBlock}>
              <Text style={styles.paymentLabel}>Belopp</Text>
              <Text style={styles.paymentValue}>{formatOre(due, currency)}</Text>
            </View>
            <View style={styles.paymentBlock}>
              <Text style={styles.paymentLabel}>Senast</Text>
              <Text style={styles.paymentValue}>{date(invoice.dueDate)}</Text>
            </View>
          </View>
        )}

        {/*
          The terms. Stating them is what makes the fees chargeable: räntelagen
          applies regardless, but the 60 kr reminder fee may only be charged if
          the invoice said so in advance.
        */}
        {isCreditNote ? (
          <Text style={styles.terms}>
            Denna kreditfaktura upphäver faktura{' '}
            {invoice.creditsInvoice?.invoiceNumber ?? ''} i sin helhet. Beloppet regleras
            mot kommande fakturor eller återbetalas.
          </Text>
        ) : (
          <Text style={styles.terms}>
            Betalningsvillkor 30 dagar. Efter förfallodatum debiteras dröjsmålsränta enligt
            räntelagen (referensränta + 8 procentenheter) samt lagstadgad påminnelseavgift om{' '}
            {formatOre(reminderFeeOre, currency)}. Ange OCR-referensen vid betalning.
          </Text>
        )}

        {/* ── Footer ─────────────────────────────────────────── */}
        <View style={styles.footer} fixed>
          <Text>
            {seller.name} · Org.nr {seller.orgNumber} · Godkänd för F-skatt
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Sida ${pageNumber} av ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}
