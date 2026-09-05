// report.validator.ts — query parameters for the report endpoints.

import { z } from 'zod'

/** "csv" for a download, otherwise JSON. */
const formatSchema = z.enum(['json', 'csv']).default('json')

/**
 * Aging report — as of which date.
 *
 * Defaults to now. Accepting a date is what makes "how did the receivables
 * look at year end" answerable — an auditor's question, and a common one.
 */
export const agingQuerySchema = z.object({
  asOf: z.coerce.date().optional(),
  format: formatSchema
})

/**
 * VAT report — a period.
 *
 * `to` is exclusive: from=2026-01-01&to=2026-04-01 is the first quarter,
 * with no argument about whether 31 March at 23:59 belongs to it. Capped at
 * 366 days so nobody asks for a decade and waits.
 */
export const vatQuerySchema = z
  .object({
    from: z.coerce.date({ message: 'Ogiltigt startdatum' }),
    to: z.coerce.date({ message: 'Ogiltigt slutdatum' }),
    format: formatSchema
  })
  .refine((q) => q.to > q.from, { message: 'Slutdatum måste vara efter startdatum', path: ['to'] })
  .refine((q) => q.to.getTime() - q.from.getTime() <= 366 * 24 * 60 * 60 * 1000, {
    message: 'Perioden får vara högst ett år',
    path: ['to']
  })

/** SIE export — one financial year. */
export const sieQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100)
})

export type AgingQuery = z.infer<typeof agingQuerySchema>
export type VatQuery = z.infer<typeof vatQuerySchema>
export type SieQuery = z.infer<typeof sieQuerySchema>
