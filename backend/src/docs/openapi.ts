// docs/openapi.ts — the API described, from the same schemas that validate it.
//
// WHY HAND-ASSEMBLED rather than @fastify/swagger: the routes validate in the
// controllers with `schema.parse(request.body)`, not through Fastify's own
// schema option. Switching every route to Fastify-level validation just to
// get docs would mean a second error format, a rewrite of the error handler
// and touching every test — for documentation. Instead this file lists the
// routes and pulls each request shape from the Zod schema with
// `z.toJSONSchema`, so the documented body IS the validated body.
//
// The one thing a hand-written list can do is drift: a route added without a
// docs entry. tests/integration/openapi.test.ts compares this document
// against the routes Fastify actually registered, in both directions.
//
// Response shapes are written by hand and kept short. They describe the
// controllers' `toPublic*` functions, which are the only place a response is
// built, so there is one file to update when one of those changes.

import { z, type ZodType } from 'zod'
import { loginSchema, setPasswordSchema, createClientSchema } from '../validators/auth.validator.ts'
import { updateClientSchema, listQuerySchema } from '../validators/client.validator.ts'
import { createInvoiceSchema, invoiceListQuerySchema } from '../validators/invoice.validator.ts'
import { agingQuerySchema, vatQuerySchema, sieQuerySchema } from '../validators/report.validator.ts'
import { env } from '../lib/env.ts'

type JsonSchema = Record<string, unknown>

/**
 * Zod -> JSON Schema, for the REQUEST side.
 *
 * `io: 'input'` documents what the caller sends, not what the handler
 * receives after transforms. `unrepresentable: 'any'` keeps coerced dates
 * from throwing; they come out as `{}` and are annotated below.
 */
function fromZod(schema: ZodType, dates: string[] = []): JsonSchema {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema
  delete json.$schema

  const properties = json.properties as Record<string, JsonSchema> | undefined
  for (const name of dates) {
    if (properties?.[name]) {
      properties[name] = { type: 'string', format: 'date-time', description: 'ISO 8601' }
    }
  }
  return json
}

/** Query-string parameters from an object schema, one parameter per key. */
function queryParams(schema: ZodType, dates: string[] = []) {
  const json = fromZod(schema, dates)
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>
  const required = new Set((json.required ?? []) as string[])

  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: property
  }))
}

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'cuid'
}

// ─────────────────────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────────────────────

const ore = (description: string) => ({ type: 'integer', description: `${description}, in öre (exact integer)` })

const components = {
  securitySchemes: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        'Access token from POST /auth/login, valid 15 minutes. Refresh with POST /auth/refresh, which reads the httpOnly cookie.'
    }
  },
  schemas: {
    Error: {
      type: 'object',
      description: 'Every error, from every endpoint, has this shape.',
      properties: {
        error: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              enum: ['VALIDATION_ERROR', 'INVALID_CREDENTIALS', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'BUSINESS_RULE', 'INTERNAL_ERROR']
            },
            message: { type: 'string', description: 'Swedish, for display' },
            requestId: { type: 'string', description: 'Quote this when reporting a problem' },
            details: { description: 'Field errors for VALIDATION_ERROR' }
          },
          required: ['code', 'message', 'requestId']
        }
      }
    },
    User: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string' },
        role: { type: 'string', enum: ['ADMIN', 'CLIENT'] }
      }
    },
    Client: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string', nullable: true },
        address: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' }
      }
    },
    LedgerRow: {
      type: 'object',
      description: 'One immutable ledger entry. Positive grows the debt; a payment is recorded positive and reduces it.',
      properties: {
        id: { type: 'string' },
        type: {
          type: 'string',
          enum: ['INVOICE_CREATED', 'PAYMENT_RECEIVED', 'LATE_FEE_ADDED', 'REMINDER_FEE_ADDED', 'CREDIT_NOTE_ISSUED', 'LATE_FEE_WAIVED', 'REMINDER_FEE_WAIVED', 'REFUND', 'ADJUSTMENT']
        },
        amountOre: ore('Amount'),
        description: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' }
      }
    },
    Invoice: {
      type: 'object',
      description: 'Amounts are integer öre. The `formatted` strings are for display only.',
      properties: {
        id: { type: 'string' },
        invoiceNumber: { type: 'string', example: '2026-0007', description: 'Unbroken yearly series, allocated server-side' },
        clientId: { type: 'string' },
        status: { type: 'string', enum: ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CREDITED'] },
        type: { type: 'string', enum: ['INVOICE', 'CREDIT_NOTE'] },
        currency: { type: 'string', example: 'SEK' },
        creditsInvoice: { nullable: true, type: 'object', properties: { id: { type: 'string' }, invoiceNumber: { type: 'string' } } },
        creditNotes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, invoiceNumber: { type: 'string' } } } },
        netTotalOre: ore('Net'),
        vatTotalOre: ore('VAT'),
        grossTotalOre: ore('Gross'),
        lateFeeOre: ore('Accrued interest'),
        reminderFeeOre: ore('Statutory reminder fee'),
        totalDueOre: ore('gross + interest + fee'),
        formatted: {
          type: 'object',
          properties: { netTotal: { type: 'string' }, vatTotal: { type: 'string' }, grossTotal: { type: 'string' }, totalDue: { type: 'string', example: '12 500,00 SEK' } }
        },
        issueDate: { type: 'string', format: 'date-time' },
        dueDate: { type: 'string', format: 'date-time' },
        sentAt: { type: 'string', format: 'date-time', nullable: true },
        paidAt: { type: 'string', format: 'date-time', nullable: true },
        reminderSentAt: { type: 'string', format: 'date-time', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        ledger: { type: 'array', items: { $ref: '#/components/schemas/LedgerRow' } },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              quantity: { type: 'integer' },
              unitPriceOre: ore('Unit price excluding VAT'),
              vatRate: { type: 'integer', description: 'Basis points: 2500 = 25 %' },
              netOre: ore('Net'),
              vatOre: ore('VAT'),
              grossOre: ore('Gross')
            }
          }
        }
      }
    },
    Pagination: {
      type: 'object',
      properties: { total: { type: 'integer' }, limit: { type: 'integer' }, offset: { type: 'integer' } }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
})

const json = (schema: JsonSchema, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } }
})

const invoiceResponse = json({ type: 'object', properties: { invoice: { $ref: '#/components/schemas/Invoice' } } })
const clientResponse = json({ type: 'object', properties: { client: { $ref: '#/components/schemas/Client' } } })

const authed = [{ bearerAuth: [] }]
const admin = { security: authed, responses: { 401: errorResponse('No or invalid token'), 403: errorResponse('Not an ADMIN') } }
const anyRole = { security: authed, responses: { 401: errorResponse('No or invalid token') } }

export const paths: Record<string, Record<string, unknown>> = {
  '/health': {
    get: { tags: ['Health'], summary: 'Liveness — is the process up', responses: { 200: json({ type: 'object', properties: { status: { type: 'string' } } }) } }
  },
  '/health/ready': {
    get: { tags: ['Health'], summary: 'Readiness — can it reach PostgreSQL and Redis', responses: { 200: json({ type: 'object' }), 503: { description: 'A dependency is down' } } }
  },

  '/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Log in',
      description: 'Rate limited per IP (5/min) and per account. Every failure returns the same 401 in the same time — wrong password, unknown email and locked account are indistinguishable by design.',
      requestBody: { required: true, content: { 'application/json': { schema: fromZod(loginSchema) } } },
      responses: {
        200: json({ type: 'object', properties: { accessToken: { type: 'string' }, user: { $ref: '#/components/schemas/User' } } }, 'Access token in the body, refresh token as an httpOnly cookie'),
        401: errorResponse('Invalid credentials'),
        429: errorResponse('Rate limited; see Retry-After')
      }
    }
  },
  '/auth/refresh': {
    post: { tags: ['Auth'], summary: 'Rotate the refresh token and issue a new access token', description: 'Reads the httpOnly cookie. Reusing a rotated token revokes the whole token family.', responses: { 200: json({ type: 'object', properties: { accessToken: { type: 'string' } } }), 401: errorResponse('No valid refresh cookie') } }
  },
  '/auth/logout': {
    post: { tags: ['Auth'], summary: 'Log out', description: 'Revokes the refresh token family and denylists the access token until it expires.', responses: { 204: { description: 'Logged out' } } }
  },
  '/auth/set-password': {
    post: {
      tags: ['Auth'],
      summary: 'Redeem an invite or reset link',
      description: 'Single-use token from the emailed link. The password is checked against HaveIBeenPwned before the token is spent.',
      requestBody: { required: true, content: { 'application/json': { schema: fromZod(setPasswordSchema) } } },
      responses: { 204: { description: 'Password set; every existing session revoked' }, 400: errorResponse('Password policy'), 401: errorResponse('Link invalid, expired or used') }
    }
  },
  '/auth/me': {
    get: { tags: ['Auth'], summary: 'The caller', ...anyRole, responses: { ...anyRole.responses, 200: json({ type: 'object', properties: { user: { $ref: '#/components/schemas/User' } } }) } }
  },

  '/clients': {
    get: {
      tags: ['Clients'], summary: 'List clients', ...admin, parameters: queryParams(listQuerySchema),
      responses: { ...admin.responses, 200: json({ type: 'object', properties: { clients: { type: 'array', items: { $ref: '#/components/schemas/Client' } }, pagination: { $ref: '#/components/schemas/Pagination' } } }) }
    },
    post: {
      tags: ['Clients'], summary: 'Provision a client', ...admin,
      description: 'Creates the User and Client rows atomically and emails a set-password invite. There is no public registration. `role` is never accepted from the body.',
      requestBody: { required: true, content: { 'application/json': { schema: fromZod(createClientSchema) } } },
      responses: { ...admin.responses, 201: clientResponse, 409: errorResponse('Email already registered (message deliberately vague)') }
    }
  },
  '/clients/me': {
    get: { tags: ['Clients'], summary: "The caller's own client record", ...anyRole, responses: { ...anyRole.responses, 200: clientResponse, 403: errorResponse('The caller is an ADMIN, who has no client record') } }
  },
  '/clients/{id}': {
    get: { tags: ['Clients'], summary: 'One client', ...anyRole, parameters: [idParam], description: "A client may read only their own record. Anyone else's answers 404, not 403, so ids cannot be enumerated.", responses: { ...anyRole.responses, 200: clientResponse, 404: errorResponse('Not found, or not yours') } },
    patch: { tags: ['Clients'], summary: 'Update a client', ...admin, parameters: [idParam], requestBody: { required: true, content: { 'application/json': { schema: fromZod(updateClientSchema) } } }, responses: { ...admin.responses, 200: clientResponse, 404: errorResponse('Not found') } }
  },

  '/invoices': {
    get: {
      tags: ['Invoices'], summary: 'List invoices', ...anyRole, parameters: queryParams(invoiceListQuerySchema),
      description: 'An ADMIN sees every invoice and may filter by clientId. A CLIENT is scoped to their own in the query itself; clientId is ignored.',
      responses: { ...anyRole.responses, 200: json({ type: 'object', properties: { invoices: { type: 'array', items: { $ref: '#/components/schemas/Invoice' } }, pagination: { $ref: '#/components/schemas/Pagination' } } }) }
    },
    post: {
      tags: ['Invoices'], summary: 'Create a DRAFT invoice', ...admin,
      description: 'Only line items are accepted. Totals, VAT and the invoice number are derived server-side; anything else sent is ignored.',
      requestBody: { required: true, content: { 'application/json': { schema: fromZod(createInvoiceSchema, ['dueDate']) } } },
      responses: { ...admin.responses, 201: invoiceResponse, 404: errorResponse('Unknown client'), 422: errorResponse('Lines cancel to zero') }
    }
  },
  '/invoices/{id}': {
    get: { tags: ['Invoices'], summary: 'One invoice, with its ledger', ...anyRole, parameters: [idParam], responses: { ...anyRole.responses, 200: invoiceResponse, 404: errorResponse('Not found, or not yours') } },
    delete: { tags: ['Invoices'], summary: 'Delete a DRAFT', ...admin, parameters: [idParam], description: 'Drafts only. A sent invoice is in the legal number series and is corrected with a credit note instead.', responses: { ...admin.responses, 204: { description: 'Deleted' }, 422: errorResponse('Not a draft') } }
  },
  '/invoices/{id}/pdf': {
    get: { tags: ['Invoices'], summary: 'The printable document', ...anyRole, parameters: [idParam], description: 'Rendered on every request from the invoice row. Contains every field mervärdesskattelagen requires, plus bankgiro and a Luhn-checked OCR reference.', responses: { ...anyRole.responses, 200: { description: 'application/pdf, inline', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, 404: errorResponse('Not found, or not yours') } }
  },
  '/invoices/{id}/send': {
    post: { tags: ['Invoices'], summary: 'DRAFT → SENT', ...admin, parameters: [idParam], description: 'The invoice becomes a financial document: the ledger row is written atomically with the status change, the customer is emailed, and the invoice can never be edited again.', responses: { ...admin.responses, 200: invoiceResponse, 422: errorResponse('Not a draft') } }
  },
  '/invoices/{id}/payment-link': {
    post: { tags: ['Payments'], summary: 'Create a Stripe Checkout session', ...admin, parameters: [idParam], description: 'Charges what is outstanding today: gross + accrued interest + reminder fee.', responses: { ...admin.responses, 201: json({ type: 'object', properties: { paymentUrl: { type: 'string' }, sessionId: { type: 'string' } } }), 422: errorResponse('Draft, paid, credited or a credit note') } }
  },
  '/invoices/{id}/credit-note': {
    post: { tags: ['Invoices'], summary: 'Cancel a sent invoice with a credit note', ...admin, parameters: [idParam], description: 'Issues a mirror-image document in the same number series, moves the original to CREDITED and writes ledger rows so the original sums to zero. A PAID invoice is refused: that is a refund.', responses: { ...admin.responses, 201: json({ type: 'object', properties: { creditNote: { $ref: '#/components/schemas/Invoice' }, original: { $ref: '#/components/schemas/Invoice' } } }), 422: errorResponse('Not SENT or OVERDUE') } }
  },
  '/invoices/{id}/reminder': {
    post: { tags: ['Invoices'], summary: 'Send a payment reminder', ...admin, parameters: [idParam], description: 'Charges the statutory 60 kr fee the first time only (lag 1981:739); later calls re-send without charging.', responses: { ...admin.responses, 200: json({ type: 'object', properties: { invoice: { $ref: '#/components/schemas/Invoice' }, feeCharged: { type: 'boolean' } } }), 422: errorResponse('Not SENT or OVERDUE') } }
  },

  '/dashboard': {
    get: { tags: ['Reports'], summary: 'Admin overview', ...admin, description: 'Outstanding and overdue from the invoice table; invoiced and received per month from the ledger; top debtors.', responses: { ...admin.responses, 200: json({ type: 'object', properties: { dashboard: { type: 'object' } } }) } }
  },
  '/reports/aging': {
    get: { tags: ['Reports'], summary: 'Kundreskontra — who owes what, and how late', ...admin, parameters: queryParams(agingQuerySchema, ['asOf']), responses: { ...admin.responses, 200: { description: 'JSON, or text/csv when format=csv' } } }
  },
  '/reports/vat': {
    get: { tags: ['Reports'], summary: 'Momsrapport — net and VAT per rate for a period', ...admin, parameters: queryParams(vatQuerySchema, ['from', 'to']), description: '`to` is exclusive. Credit notes reduce the period.', responses: { ...admin.responses, 200: { description: 'JSON, or text/csv when format=csv' }, 400: errorResponse('Inverted or over-long period') } }
  },
  '/reports/sie': {
    get: { tags: ['Reports'], summary: 'SIE 4 export of the ledger for a year', ...admin, parameters: queryParams(sieQuerySchema), description: 'Balanced verifications on the BAS chart of accounts, encoded in PC8 (CP437). The export is audited.', responses: { ...admin.responses, 200: { description: 'application/octet-stream, attachment' } } }
  },
  '/audit-log': {
    get: { tags: ['Audit'], summary: 'Read the audit log', ...admin, parameters: [
      { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } },
      { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
      { name: 'action', in: 'query', schema: { type: 'string' }, description: 'One of the closed set returned in `actions`' },
      { name: 'resourceId', in: 'query', schema: { type: 'string' } },
      { name: 'userId', in: 'query', schema: { type: 'string' } }
    ], description: 'Newest first. There is no endpoint that writes or deletes an entry.', responses: { ...admin.responses, 200: json({ type: 'object', properties: { entries: { type: 'array', items: { type: 'object' } }, pagination: { $ref: '#/components/schemas/Pagination' }, actions: { type: 'array', items: { type: 'string' } } } }) } }
  },

  '/webhooks/stripe': {
    post: { tags: ['Payments'], summary: 'Stripe webhook', description: 'Unauthenticated; the `stripe-signature` header IS the authentication. Idempotent on event id and on invoice status. Returns 200 for anything handled or deliberately ignored, 400 for a bad signature, 500 only when a retry is wanted.', responses: { 200: json({ type: 'object', properties: { received: { type: 'boolean' }, handled: { type: 'boolean' } } }), 400: { description: 'Invalid signature' } } }
  }
}

if (env.DEMO_MODE) {
  paths['/demo'] = {
    get: { tags: ['Demo'], summary: 'The public demo accounts', description: 'Exists only when DEMO_MODE is on.', responses: { 200: json({ type: 'object' }) } }
  }
}

export function buildOpenApiDocument() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Fakturly API',
      version: '1.0.0',
      description:
        'Invoicing and payments, built to the standards a financial application is held to. ' +
        'Money is integer öre. Sent invoices are immutable; corrections are credit notes. ' +
        'Every auth failure looks identical. Ownership failures answer 404.'
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'Health' }, { name: 'Auth' }, { name: 'Clients' }, { name: 'Invoices' },
      { name: 'Payments' }, { name: 'Reports' }, { name: 'Audit' }, ...(env.DEMO_MODE ? [{ name: 'Demo' }] : [])
    ],
    paths,
    components
  }
}
