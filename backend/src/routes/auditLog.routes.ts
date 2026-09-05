// auditLog.routes.ts — reading the audit log.

import type { FastifyInstance } from 'fastify'
import * as auditLogController from '../controllers/auditLog.controller.ts'
import { authenticate } from '../middleware/authenticate.ts'
import { authorize } from '../middleware/authorize.ts'

export default async function auditLogRoutes(app: FastifyInstance) {
  /**
   * GET /audit-log — a page of the log, newest first. Admin only.
   *
   * There is no POST, PATCH or DELETE here and there never will be. Rows
   * are written by the services as a side effect of the actions they
   * describe; nothing reachable over HTTP writes one directly, and nothing
   * anywhere removes one.
   */
  app.get(
    '/audit-log',
    { onRequest: [authenticate, authorize('ADMIN')] },
    auditLogController.listAuditLog
  )
}
