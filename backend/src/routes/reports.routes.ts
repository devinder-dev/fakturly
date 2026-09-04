// reports.routes.ts — admin reports.

import type { FastifyInstance } from 'fastify'
import * as reportsController from '../controllers/reports.controller.ts'
import { authenticate } from '../middleware/authenticate.ts'
import { authorize } from '../middleware/authorize.ts'

export default async function reportRoutes(app: FastifyInstance) {
  const adminOnly = { onRequest: [authenticate, authorize('ADMIN')] }

  /** GET /reports/aging?asOf=&format=csv — kundreskontra, who owes what and how late. */
  app.get('/reports/aging', adminOnly, reportsController.aging)

  /** GET /reports/vat?from=&to=&format=csv — momsrapport for a period. */
  app.get('/reports/vat', adminOnly, reportsController.vat)

  /**
   * GET /reports/sie?year= — the ledger as a SIE 4 file.
   *
   * A GET that is audited: the export has no side effect on our data, but
   * handing the ledger to an outside system is worth a row in the log.
   */
  app.get('/reports/sie', adminOnly, reportsController.sie)
}
