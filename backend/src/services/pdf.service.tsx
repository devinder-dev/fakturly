// pdf.service.ts — renders an invoice to PDF bytes.
//
// Sits in the service layer because it decides WHAT goes on the document:
// which client, which seller details, which reference number. The layout
// itself is in pdf/InvoiceDocument.tsx and knows nothing about the database.
//
// Nothing is stored. The PDF is produced on every request from the invoice
// row, which is the record. A stored file would be a second copy that could
// disagree with the first — and a sent invoice is frozen, so regenerating
// it always yields the same document.

import { renderToBuffer } from '@react-pdf/renderer'
import { InvoiceDocument, type SellerDetails } from '../pdf/InvoiceDocument.tsx'
import { ocrReference } from '../lib/ocr.ts'
import { REMINDER_FEE_ORE } from '../lib/money.ts'
import { env } from '../lib/env.ts'
import * as clientRepository from '../repositories/client.repository.ts'
import { NotFoundError } from '../lib/errors.ts'
import type { InvoiceRecord } from '../repositories/invoice.repository.ts'

/** The seller, from configuration. One place, so every PDF agrees. */
export function sellerDetails(): SellerDetails {
  return {
    name: env.COMPANY_NAME,
    address: env.COMPANY_ADDRESS,
    orgNumber: env.COMPANY_ORG_NUMBER,
    vatNumber: env.COMPANY_VAT_NUMBER,
    email: env.COMPANY_EMAIL,
    bankgiro: env.COMPANY_BANKGIRO
  }
}

export type RenderedPdf = {
  bytes: Buffer
  /** Suggested file name, e.g. "faktura-2026-0007.pdf". */
  filename: string
}

/**
 * Renders an invoice the caller has ALREADY been allowed to see.
 *
 * Takes the loaded record rather than an id on purpose. Ownership is decided
 * by invoice.service.getInvoiceForCaller, and this function cannot be reached
 * without going through it — so there is no second copy of the "may this
 * client see this invoice" rule here to drift out of sync.
 */
export async function renderInvoicePdf(invoice: InvoiceRecord): Promise<RenderedPdf> {
  const client = await clientRepository.findClientById(invoice.clientId)
  if (!client) {
    throw new NotFoundError('Kunden')
  }

  const bytes = await renderToBuffer(
    <InvoiceDocument
      invoice={invoice}
      client={client}
      seller={sellerDetails()}
      ocrReference={ocrReference(invoice.invoiceNumber)}
      reminderFeeOre={REMINDER_FEE_ORE}
    />
  )

  return {
    bytes,
    filename: `faktura-${invoice.invoiceNumber}.pdf`
  }
}
