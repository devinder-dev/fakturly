// auditLog.controller.ts — HTTP for reading the audit log.

import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import * as auditService from '../services/audit.service.ts'

/**
 * Filters for the log.
 *
 * `action` is validated against the closed set of actions the system writes,
 * so a typo returns 400 rather than an empty page that looks like "nothing
 * happened".
 */
const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  action: z
    .enum(Object.values(auditService.AuditAction) as [string, ...string[]])
    .optional(),
  resourceId: z.string().min(1).max(64).optional(),
  userId: z.string().min(1).max(64).optional()
})

export async function listAuditLog(request: FastifyRequest, reply: FastifyReply) {
  const query = auditQuerySchema.parse(request.query)
  const page = await auditService.listAuditEntries(query)

  return reply.code(200).send({
    entries: page.entries,
    pagination: { total: page.total, limit: query.limit, offset: query.offset },
    // The closed set, so a UI can offer a dropdown without hardcoding it.
    actions: Object.values(auditService.AuditAction)
  })
}
