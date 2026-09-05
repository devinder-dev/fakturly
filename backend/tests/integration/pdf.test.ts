// pdf.test.ts — the printable invoice, and who may fetch it.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { FastifyInstance } from 'fastify'
import {
  buildTestApp,
  createTestUser,
  loginAs,
  authed,
  clearRateLimits,
  cleanupUsers,
  uniqueSuffix,
  testPasswordHash,
  prisma
} from '../helpers.ts'
import { VatRate } from '../../src/lib/money.ts'
import { renderInvoicePdf } from '../../src/services/pdf.service.tsx'
import * as invoiceRepository from '../../src/repositories/invoice.repository.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `pdf-admin-${suffix}@fakturly.se`

let adminToken: string
let aliceToken: string
let alice: { id: string; userId: string }
let bob: { id: string; userId: string }
let aliceInvoiceId: string
let bobInvoiceId: string
const userIds: string[] = []

const asAdmin = () => authed(app, adminToken)

beforeAll(async () => {
  app = await buildTestApp()
  userIds.push((await createTestUser(ADMIN_EMAIL, 'ADMIN')).id)
  adminToken = (await loginAs(app, ADMIN_EMAIL, '198.51.100.130')).accessToken

  alice = (await asAdmin()('POST', '/clients', {
    email: `pdf-alice-${suffix}@kund.se`,
    name: 'Alice Design AB',
    address: 'Storgatan 1, 111 22 Stockholm'
  })).json().client
  bob = (await asAdmin()('POST', '/clients', {
    email: `pdf-bob-${suffix}@kund.se`,
    name: 'Bob Bygg AB'
  })).json().client
  userIds.push(alice.userId, bob.userId)

  await prisma.user.updateMany({
    where: { id: { in: [alice.userId, bob.userId] } },
    data: { password: await testPasswordHash() }
  })
  aliceToken = (await loginAs(app, `pdf-alice-${suffix}@kund.se`, '198.51.100.131')).accessToken

  const mixed = await asAdmin()('POST', '/invoices', {
    clientId: alice.id,
    dueDate: '2026-12-31T00:00:00.000Z',
    items: [
      { description: 'Konsulttimmar', quantity: 10, unitPriceOre: 100_000, vatRate: VatRate.STANDARD },
      { description: 'Handbok', quantity: 2, unitPriceOre: 24_900, vatRate: VatRate.REDUCED_6 }
    ]
  })
  aliceInvoiceId = mixed.json().invoice.id
  await asAdmin()('POST', `/invoices/${aliceInvoiceId}/send`)

  const other = await asAdmin()('POST', '/invoices', {
    clientId: bob.id,
    dueDate: '2026-12-31T00:00:00.000Z',
    items: [{ description: 'Arbete', quantity: 1, unitPriceOre: 50_000, vatRate: VatRate.STANDARD }]
  })
  bobInvoiceId = other.json().invoice.id
})

afterAll(async () => {
  await cleanupUsers(userIds)
  await clearRateLimits()
})

describe('GET /invoices/:id/pdf', () => {
  test('returns a real PDF with a filename', async () => {
    const res = await asAdmin()('GET', `/invoices/${aliceInvoiceId}/pdf`)

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toMatch(/inline; filename="faktura-\d{4}-\d{4}\.pdf"/)
    expect(res.headers['cache-control']).toBe('no-store')
    // Every PDF begins with this magic number.
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    expect(res.rawPayload.length).toBeGreaterThan(1_000)
  })

  test('the client can fetch their own', async () => {
    const res = await authed(app, aliceToken)('GET', `/invoices/${aliceInvoiceId}/pdf`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
  })

  test("🎯 someone else's invoice is 404 — same as one that never existed", async () => {
    const notMine = await authed(app, aliceToken)('GET', `/invoices/${bobInvoiceId}/pdf`)
    const nothing = await authed(app, aliceToken)('GET', '/invoices/clnotarealinvoice0/pdf')

    expect(notMine.statusCode).toBe(404)
    expect(nothing.statusCode).toBe(404)
    expect(notMine.json().error.message).toBe(nothing.json().error.message)
    // The renderer is only reachable through getInvoiceForCaller, so there
    // is no second ownership rule here that could drift.
  })

  test('no token is 401', async () => {
    const res = await app.inject({ method: 'GET', url: `/invoices/${aliceInvoiceId}/pdf` })
    expect(res.statusCode).toBe(401)
  })
})

describe('the document itself', () => {
  /**
   * PDF text is stored in content streams, often compressed, so grepping the
   * bytes for "Netto" does not work. Instead we assert on the metadata the
   * renderer writes uncompressed, and on structural facts.
   */
  test('carries the invoice number in its metadata', async () => {
    const invoice = await invoiceRepository.findInvoiceById(aliceInvoiceId)
    const pdf = await renderInvoicePdf(invoice!)

    expect(pdf.filename).toBe(`faktura-${invoice!.invoiceNumber}.pdf`)
    expect(pdf.bytes.toString('latin1')).toContain(`Faktura ${invoice!.invoiceNumber}`)
  })

  test('renders a paid invoice too', async () => {
    const created = await asAdmin()('POST', '/invoices', {
      clientId: alice.id,
      dueDate: '2026-12-31T00:00:00.000Z',
      items: [{ description: 'Rad', quantity: 1, unitPriceOre: 10_000, vatRate: VatRate.STANDARD }]
    })
    const id = created.json().invoice.id
    await asAdmin()('POST', `/invoices/${id}/send`)
    await invoiceRepository.markPaid(id, { stripePaymentId: `pi_pdf_${suffix}`, amountOre: 12_500 })

    const res = await asAdmin()('GET', `/invoices/${id}/pdf`)
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
  })

  test('renders a DRAFT — nothing stops previewing before sending', async () => {
    const res = await asAdmin()('GET', `/invoices/${bobInvoiceId}/pdf`)
    expect(res.statusCode).toBe(200)
  })
})
