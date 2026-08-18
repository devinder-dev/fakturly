// invoices.routes.ts — invoice endpoints.

import type { FastifyInstance } from 'fastify'
import * as invoicesController from '../controllers/invoices.controller.ts'
import { authenticate } from '../middleware/authenticate.ts'
import { authorize } from '../middleware/authorize.ts'

export default async function invoiceRoutes(app: FastifyInstance) {
  /** POST /invoices — admin issues an invoice. Starts as DRAFT. */
  app.post(
    '/invoices',
    { onRequest: [authenticate, authorize('ADMIN')] },
    invoicesController.createInvoice
  )

  /**
   * GET /invoices — list.
   *
   * Open to both roles, because the service scopes the query: an admin sees
   * everything, a client sees only their own. Restricting the route to ADMIN
   * would mean building a second, near-identical endpoint for the client
   * portal — and two endpoints reading the same table is two places to get
   * the scoping wrong.
   */
  app.get('/invoices', { onRequest: [authenticate] }, invoicesController.listInvoices)

  /**
   * GET /invoices/:id — one invoice.
   *
   * Ownership is decided in the service, which answers 404 rather than 403
   * for someone else's invoice. That matters more here than for clients:
   * invoice numbers are sequential by law, so confirming that 2026-0007
   * exists reveals how many invoices the business has issued this year.
   */
  app.get('/invoices/:id', { onRequest: [authenticate] }, invoicesController.getInvoice)

  /**
   * POST /invoices/:id/send — DRAFT becomes SENT.
   *
   * A POST to a sub-resource rather than a PATCH of the status field. The
   * distinction is deliberate: this is not "set a column", it is an action
   * with consequences — the invoice becomes a financial document and can
   * never be edited again. A generic PATCH would invite arbitrary status
   * changes, including ones the transition table forbids.
   */
  app.post(
    '/invoices/:id/send',
    { onRequest: [authenticate, authorize('ADMIN')] },
    invoicesController.sendInvoice
  )

  /**
   * DELETE /invoices/:id — drafts only.
   *
   * The service refuses anything already sent. A sent invoice belongs to the
   * numbered series required by law, and its absence would be a hole someone
   * has to account for. Corrections are credit notes.
   */
  /**
   * POST /invoices/:id/payment-link — a hosted Stripe page for this invoice.
   *
   * Admin only. The client receives the URL by email rather than calling this
   * themselves, so nothing about the amount is under their control.
   */
  app.post(
    '/invoices/:id/payment-link',
    { onRequest: [authenticate, authorize('ADMIN')] },
    invoicesController.createPaymentLink
  )

  app.delete(
    '/invoices/:id',
    { onRequest: [authenticate, authorize('ADMIN')] },
    invoicesController.deleteInvoice
  )
}
