// invoice.validator.ts — Zod schemas for invoice endpoints.
//
// THE RULE THIS FILE ENFORCES: the caller supplies line items. It never
// supplies a total, a VAT amount, or an invoice number. Those are derived
// server-side from the items.
//
// If the API accepted grossTotalOre, an admin (or anyone who got hold of a
// token) could invoice 1 öre for a 10 000 kr job and the ledger would agree.
// A total is not input — it is a consequence of the input.

import { z } from 'zod'
import { VALID_VAT_RATES } from '../lib/money.ts'

/**
 * One line on the invoice.
 *
 * Note what is absent: netOre, vatOre, grossOre. Sending them would be
 * meaningless at best and a way to falsify an invoice at worst.
 */
export const invoiceItemSchema = z.object({
  description: z.string().trim().min(1, 'Beskrivning krävs').max(500),

  /**
   * Quantity may be negative — that is how a credit note is expressed, and
   * the money arithmetic is symmetric so it cancels the original exactly.
   * Zero is rejected: a line billing nothing is a mistake, not an intention.
   */
  quantity: z
    .number()
    .int('Antal måste vara ett heltal')
    .refine((value) => value !== 0, 'Antal får inte vara noll')
    .refine((value) => Math.abs(value) <= 1_000_000, 'Antal är orimligt stort'),

  /**
   * Unit price in öre, EXCLUDING VAT. Integer — never a decimal.
   *
   * The upper bound is 100 million öre (1 000 000 SEK) per unit. Not a
   * business rule so much as a guard: JavaScript integers stay exact only up
   * to 2^53, and a quantity times a price must not approach it. Capping both
   * keeps every product far inside the safe range.
   */
  unitPriceOre: z
    .number()
    .int('Styckpris måste anges i hela ören')
    .min(0, 'Styckpris kan inte vara negativt')
    .max(100_000_000, 'Styckpris är orimligt högt'),

  /**
   * VAT rate in basis points, and it must be one Sweden actually uses.
   *
   * A free-form number would let someone invoice at 3% — which is not a rate
   * that exists here, would not match any VAT return, and would be found by
   * an accountant long after the invoice was sent.
   */
  vatRate: z
    .number()
    .int()
    .refine(
      (value) => VALID_VAT_RATES.includes(value),
      `Momssats måste vara en av: ${VALID_VAT_RATES.map((r) => `${r / 100}%`).join(', ')}`
    )
})

export const createInvoiceSchema = z.object({
  clientId: z.string().min(1, 'Kund krävs').max(64),

  /**
   * Due date. Coerced because JSON has no date type — it arrives as a string.
   *
   * We do not require it to be in the future. Back-dating happens legitimately
   * when an invoice is entered late, and refusing it would push people to
   * falsify something else instead. The issue date is set server-side and
   * always records when the invoice was actually created.
   */
  dueDate: z.coerce.date({ message: 'Ogiltigt förfallodatum' }),

  /**
   * At least one line. An invoice with no lines has no amount, and a
   * zero-amount invoice is not a document anyone should be able to create by
   * accident.
   *
   * Capped at 200 lines: every line is validated, calculated and inserted, so
   * an unbounded array is a way to make one request expensive.
   */
  items: z
    .array(invoiceItemSchema)
    .min(1, 'Fakturan måste ha minst en rad')
    .max(200, 'Fakturan har för många rader')
})

/** Filtering the invoice list. */
export const invoiceListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE']).optional(),
  /** Admin only — a client is always scoped to their own invoices regardless. */
  clientId: z.string().min(1).max(64).optional()
})

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>
export type InvoiceItemInput = z.infer<typeof invoiceItemSchema>
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>
