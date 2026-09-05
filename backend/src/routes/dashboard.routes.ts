// dashboard.routes.ts — the admin overview endpoint.

import type { FastifyInstance } from 'fastify'
import * as dashboardController from '../controllers/dashboard.controller.ts'
import { authenticate } from '../middleware/authenticate.ts'
import { authorize } from '../middleware/authorize.ts'

export default async function dashboardRoutes(app: FastifyInstance) {
  /**
   * GET /dashboard — totals across every client.
   *
   * Admin only, and there is no client variant of this route. A client's
   * "dashboard" is their own invoice list, which GET /invoices already scopes
   * to them; building a second aggregate endpoint that must ALSO remember to
   * scope by caller would be one more place to get ownership wrong.
   */
  app.get(
    '/dashboard',
    { onRequest: [authenticate, authorize('ADMIN')] },
    dashboardController.getDashboard
  )
}
