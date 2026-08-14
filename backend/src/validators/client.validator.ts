// client.validator.ts — Zod schemas for client endpoints.

import { z } from 'zod'

/**
 * A cuid path parameter.
 *
 * Length-bounded rather than free-form: an id goes straight into a database
 * query, and while Prisma parameterises it (so this is not SQL injection
 * defence), there is no reason to send a 10 MB string to Postgres to be told
 * it matches nothing.
 */
export const idParamSchema = z.object({
  id: z.string().min(1).max(64)
})

/**
 * Pagination.
 *
 * `limit` is capped at 100. Without a cap, `?limit=1000000` is a free
 * denial-of-service: one request that loads every row into memory and
 * serialises it to JSON.
 *
 * coerce because query strings are always strings — "20" must become 20.
 */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0)
})

/**
 * Updating a client.
 *
 * Note what is NOT updatable here:
 *
 *   email  — it is the login identity. Changing it silently changes who can
 *            sign in, and would need re-verification of the new address.
 *            That is a separate, deliberate flow, not a field on a PATCH.
 *   userId — the link to the login account. Nothing should ever repoint it.
 *
 * .partial() makes every field optional (this is a PATCH), and the refine
 * rejects a completely empty body — otherwise "update" would succeed while
 * doing nothing, and still write an audit row claiming a change happened.
 */
export const updateClientSchema = z
  .object({
    name: z.string().trim().min(1, 'Namn krävs').max(200),
    phone: z.string().trim().max(50).nullable(),
    address: z.string().trim().max(500).nullable()
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Minst ett fält måste anges'
  })

export type ListQuery = z.infer<typeof listQuerySchema>
export type UpdateClientInput = z.infer<typeof updateClientSchema>
