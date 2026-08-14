// clients.routes.ts — client endpoints.
//
// Note the two different protection levels below. Most routes are ADMIN only.
// Two are open to any authenticated user, and for those the ownership check
// lives in the service — because "may this caller see this row" depends on
// the row, which a route cannot know.

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

  /** GET /clients — admin only. Paginated, capped at 100 per page. */
  app.get(
    '/clients',
    { onRequest: [authenticate, authorize('ADMIN')] },
    clientsController.listClients
  )

  /**
   * GET /clients/me — the caller's own record.
   *
   * Declared BEFORE /clients/:id. Fastify's router is not order-dependent for
   * static versus parametric segments — a static segment always wins — but
   * keeping them in this order makes the intent obvious to a reader, who
   * would otherwise wonder whether "me" is being parsed as an id.
   *
   * No authorize(): any authenticated user may ask for their own record. An
   * ADMIN has no client profile and gets a 403 from the service.
   */
  app.get(
    '/clients/me',
    { onRequest: [authenticate] },
    clientsController.getOwnClient
  )

  /**
   * GET /clients/:id — one client.
   *
   * Deliberately NOT admin-only. A client may read their own record through
   * this route too, so the decision cannot be made here: it depends on which
   * row :id resolves to. The service enforces it and answers 404 rather than
   * 403 when the row belongs to someone else, so probing ids reveals nothing.
   */
  app.get(
    '/clients/:id',
    { onRequest: [authenticate] },
    clientsController.getClient
  )

  /**
   * PATCH /clients/:id — admin only.
   *
   * Clients cannot edit their own details. In an invoicing system the
   * customer record is billing data: an address change alters what appears on
   * a legal document, so it goes through the business that issues it.
   */
  app.patch(
    '/clients/:id',
    { onRequest: [authenticate, authorize('ADMIN')] },
    clientsController.updateClient
  )
}
