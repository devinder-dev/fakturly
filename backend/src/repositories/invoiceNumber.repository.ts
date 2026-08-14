// invoiceNumber.repository.ts — allocates the next invoice number.
//
// Bokföringslagen requires invoice numbers to form an unbroken series. The
// point is that you cannot delete an invoice and hide the fact: if 2026-0007
// is missing, that absence is visible and must be explained.

import { prisma } from '../lib/prisma.ts'

/**
 * Allocates the next number for a year, atomically.
 *
 * The whole operation is ONE statement. INSERT ... ON CONFLICT DO UPDATE is
 * atomic in Postgres, so two concurrent invoice creations cannot receive the
 * same number — the second waits for the first's row lock, which is released
 * as soon as that statement completes.
 *
 * WHY NOT SELECT-then-UPDATE: between reading 7 and writing 8, another
 * request reads 7 too. Both write 8. Two invoices, one number. Classic
 * lost-update race, and it only appears under load — which for an invoicing
 * system means it appears at month end.
 *
 * WHY NOT `SELECT ... FOR UPDATE` inside the invoice transaction: that would
 * hold the lock until the whole invoice commits, serialising every invoice
 * creation in the system behind one row.
 *
 * THE TRADE-OFF, stated plainly: because this runs in its own transaction,
 * a number can be allocated and then the invoice creation can fail, leaving
 * a gap. That is the same behaviour a Postgres sequence has. A gap is
 * explainable; a duplicate or a silently reused number is not.
 */
export async function allocateInvoiceNumber(year: number): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ lastNumber: number }>>`
    INSERT INTO "InvoiceNumberSeries" ("year", "lastNumber")
    VALUES (${year}, 1)
    ON CONFLICT ("year")
    DO UPDATE SET "lastNumber" = "InvoiceNumberSeries"."lastNumber" + 1
    RETURNING "lastNumber"
  `

  const next = rows[0]?.lastNumber
  if (next === undefined) {
    throw new Error('Failed to allocate invoice number')
  }

  // Zero-padded to 4 digits: 2026-0001. Numbers beyond 9999 simply get
  // longer rather than wrapping — 2026-10000 sorts and reads fine.
  return `${year}-${String(next).padStart(4, '0')}`
}

/** Current allocation for a year. Read-only; used by tests and reporting. */
export async function peekLastNumber(year: number): Promise<number> {
  const row = await prisma.invoiceNumberSeries.findUnique({ where: { year } })
  return row?.lastNumber ?? 0
}
