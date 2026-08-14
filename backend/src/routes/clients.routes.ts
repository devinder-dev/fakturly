// clients.routes.ts — client provisioning URLs.

import type { FastifyInstance } from 'fastify'
import * as clientsController from '../controllers/clients.controller.ts'
import { authenticate } from '../middleware/authenticate.ts'
import { authorize } from '../middleware/authorize.ts'

export default async function clientRoutes(app: FastifyInstance) {
  /**
   * POST /clients — admin provisions a new customer.
   *
   * The onRequest array order is load-bearing: authorize reads what
   * authenticate attached, so authenticate must run first.
   *
   * This is the endpoint that replaces public registration. A CLIENT calling
   * it gets 403, not 401 — we know exactly who they are, they simply may not.
   */
  app.post(
    '/clients',
    { onRequest: [authenticate, authorize('ADMIN')] },
    clientsController.createClient
  )
}
