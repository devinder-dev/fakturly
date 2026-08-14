// invoices.controller.ts — HTTP for invoice endpoints.

import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  createInvoiceSchema,
  invoiceListQuerySchema
} from '../validators/invoice.validator.ts'
import { idParamSchema } from '../validators/client.validator.ts'
import * as invoiceService from '../services/invoice.service.ts'
import * as paymentService from '../services/payment.service.ts'
import { formatOre } from '../lib/money.ts'
import { UnauthenticatedError } from '../lib/errors.ts'
import type { InvoiceRecord } from '../repositories/invoice.repository.ts'
import type { AuthenticatedUser } from '../types/auth.ts'

/**
 * Shapes an invoice for the API.
 *
 * Amounts go out as integer öre — the exact value — with a formatted string
 * alongside for display. Sending only the formatted string would force the
 * frontend to parse "12 345,67 SEK" back into a number to do anything with
 * it, and that parse is where a float creeps in.
 */
function toPublicInvoice(invoice: InvoiceRecord) {
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    clientId: invoice.clientId,
    status: invoice.status,
    currency: invoice.currency,

    netTotalOre: invoice.netTotalOre,
    vatTotalOre: invoice.vatTotalOre,
    grossTotalOre: invoice.grossTotalOre,
    lateFeeOre: invoice.lateFeeOre,

    formatted: {
      netTotal: formatOre(invoice.netTotalOre, invoice.currency),
      vatTotal: formatOre(invoice.vatTotalOre, invoice.currency),
      grossTotal: formatOre(invoice.grossTotalOre, invoice.currency)
    },

    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    sentAt: invoice.sentAt,
    paidAt: invoice.paidAt,
    createdAt: invoice.createdAt,

    items: invoice.items.map((item) => ({
      id: item.id,
      description: item.description,
      quantity: item.quantity,
      unitPriceOre: item.unitPriceOre,
      vatRate: item.vatRate,
      netOre: item.netOre,
      vatOre: item.vatOre,
      grossOre: item.grossOre
    }))
  }
}

function requireCaller(request: FastifyRequest): AuthenticatedUser {
  const caller = request.authUser
  if (!caller) throw new UnauthenticatedError()
  return caller
}

function requestContext(request: FastifyRequest) {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent']?.slice(0, 500)
  }
}

// ─────────────────────────────────────────────────────────────

export async function createInvoice(request: FastifyRequest, reply: FastifyReply) {
  // The schema accepts line items only. No total, no VAT amount, no invoice
  // number — those are derived, and accepting them would let a caller invoice
  // 1 öre for a 10 000 kr job.
  const input = createInvoiceSchema.parse(request.body)
  const admin = requireCaller(request)

  const invoice = await invoiceService.createInvoice(
    input,
    admin.id,
    requestContext(request)
  )

  return reply.code(201).send({ invoice: toPublicInvoice(invoice) })
}

export async function listInvoices(request: FastifyRequest, reply: FastifyReply) {
  const query = invoiceListQuerySchema.parse(request.query)
  const caller = requireCaller(request)

  // The service scopes the QUERY for a client, so another client's rows are
  // never loaded at all — not fetched and then filtered.
  const { invoices, total } = await invoiceService.listInvoicesForCaller(query, caller)

  return reply.code(200).send({
    invoices: invoices.map(toPublicInvoice),
    pagination: { total, limit: query.limit, offset: query.offset }
  })
}

export async function getInvoice(request: FastifyRequest, reply: FastifyReply) {
  const { id } = idParamSchema.parse(request.params)
  const caller = requireCaller(request)

  const invoice = await invoiceService.getInvoiceForCaller(id, caller)

  return reply.code(200).send({ invoice: toPublicInvoice(invoice) })
}

export async function sendInvoice(request: FastifyRequest, reply: FastifyReply) {
  const { id } = idParamSchema.parse(request.params)
  const admin = requireCaller(request)

  const invoice = await invoiceService.sendInvoice(id, admin.id, requestContext(request))

  return reply.code(200).send({ invoice: toPublicInvoice(invoice) })
}

export async function deleteInvoice(request: FastifyRequest, reply: FastifyReply) {
  const { id } = idParamSchema.parse(request.params)
  const admin = requireCaller(request)

  await invoiceService.deleteDraft(id, admin.id, requestContext(request))

  return reply.code(204).send()
}

/**
 * POST /invoices/:id/payment-link
 *
 * Creates a hosted Stripe checkout page for this invoice and returns its URL.
 *
 * A POST rather than a GET, even though it reads like one: it has a side
 * effect (a session is created at Stripe and recorded on the invoice), and a
 * GET would be retried by browsers and prefetched by link scanners.
 */
export async function createPaymentLink(request: FastifyRequest, reply: FastifyReply) {
  const { id } = idParamSchema.parse(request.params)
  const admin = requireCaller(request)

  const link = await paymentService.createPaymentLink(id, admin.id, requestContext(request))

  return reply.code(201).send({ paymentUrl: link.url, sessionId: link.sessionId })
}
