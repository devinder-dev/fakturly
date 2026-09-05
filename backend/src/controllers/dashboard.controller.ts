// dashboard.controller.ts — HTTP for the admin overview.

import type { FastifyReply, FastifyRequest } from 'fastify'
import * as dashboardService from '../services/dashboard.service.ts'
import { formatOre } from '../lib/money.ts'

/**
 * GET /dashboard
 *
 * Same convention as invoices: exact öre for arithmetic, a formatted string
 * alongside for display. The chart uses the öre; the stat tiles show the
 * strings.
 */
export async function getDashboard(_request: FastifyRequest, reply: FastifyReply) {
  const dashboard = await dashboardService.getAdminDashboard()

  return reply.code(200).send({
    dashboard: {
      ...dashboard,
      formatted: {
        outstanding: formatOre(dashboard.outstanding.amountOre),
        overdue: formatOre(dashboard.overdue.amountOre),
        invoicedThisMonth: formatOre(dashboard.thisMonth.invoicedOre),
        receivedThisMonth: formatOre(dashboard.thisMonth.receivedOre)
      }
    }
  })
}
