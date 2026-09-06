// credit-notes.test.ts — cancelling a sent invoice the lawful way.

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
import { canTransition } from '../../src/services/invoice.service.ts'
import { runOverdueCheck } from '../../src/services/overdue.service.ts'
import * as invoiceRepository from '../../src/repositories/invoice.repository.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `cn-admin-${suffix}@fakturly.se`
const CLIENT_EMAIL = `cn-kund-${suffix}@kund.se`

let adminToken: string
let clientToken: string
let clientId: string
const userIds: string[] = []

const asAdmin = () => authed(app, adminToken)

const ITEMS = [
  { description: 'Konsult', quantity: 10, unitPriceOre: 100_000, vatRate: VatRate.STANDARD },
  { description: 'Handbok', quantity: 3, unitPriceOre: 24_900, vatRate: VatRate.REDUCED_6 }
]

beforeAll(async () => {
  app = await buildTestApp()
  userIds.push((await createTestUser(ADMIN_EMAIL, 'ADMIN')).id)
  adminToken = (await loginAs(app, ADMIN_EMAIL, '198.51.100.150')).accessToken

  const created = await asAdmin()('POST', '/clients', { email: CLIENT_EMAIL, name: 'Kredit AB' })
  clientId = created.json().client.id
  userIds.push(created.json().client.userId)
  await prisma.user.update({
    where: { id: created.json().client.userId },
    data: { password: await testPasswordHash() }
  })
  clientToken = (await loginAs(app, CLIENT_EMAIL, '198.51.100.151')).accessToken
})

afterAll(async () => {
  await cleanupUsers(userIds)
  await clearRateLimits()
})

async function issue(dueDate = '2099-01-01T00:00:00.000Z') {
  const created = await asAdmin()('POST', '/invoices', { clientId, dueDate, items: ITEMS })
  const sent = await asAdmin()('POST', `/invoices/${created.json().invoice.id}/send`)
  if (sent.statusCode !== 200) throw new Error(`send failed ${sent.body}`)
  return sent.json().invoice as { id: string; invoiceNumber: string; grossTotalOre: number; netTotalOre: number; vatTotalOre: number }
}

describe('the transition table', () => {
  test('allows crediting a SENT or OVERDUE invoice, never a PAID one', () => {
    expect(canTransition('SENT', 'CREDITED')).toBe(true)
    expect(canTransition('OVERDUE', 'CREDITED')).toBe(true)
    expect(canTransition('PAID', 'CREDITED')).toBe(false)
    expect(canTransition('DRAFT', 'CREDITED')).toBe(false)
    expect(canTransition('CREDITED', 'PAID')).toBe(false)
    expect(canTransition('CREDITED', 'SENT')).toBe(false)
  })
})

describe('POST /invoices/:id/credit-note', () => {
  test('🔑 issues a mirror-image document in the same number series', async () => {
    const original = await issue()
    const res = await asAdmin()('POST', `/invoices/${original.id}/credit-note`)
    const { creditNote, original: after } = res.json()

    expect(res.statusCode).toBe(201)
    expect(creditNote.type).toBe('CREDIT_NOTE')
    expect(creditNote.status).toBe('SENT')
    expect(creditNote.creditsInvoice.invoiceNumber).toBe(original.invoiceNumber)

    // Exactly minus the original, on every figure.
    expect(creditNote.netTotalOre).toBe(-original.netTotalOre)
    expect(creditNote.vatTotalOre).toBe(-original.vatTotalOre)
    expect(creditNote.grossTotalOre).toBe(-original.grossTotalOre)
    expect(creditNote.items).toHaveLength(ITEMS.length)
    expect(creditNote.items[0].quantity).toBe(-10)
    expect(creditNote.items[0].unitPriceOre).toBe(100_000)

    // Next number in the ONE series — no separate credit-note numbering.
    const a = Number(original.invoiceNumber.split('-')[1])
    const b = Number(creditNote.invoiceNumber.split('-')[1])
    expect(b).toBeGreaterThan(a)

    // The original is cancelled, not edited: same totals, new status, link back.
    expect(after.status).toBe('CREDITED')
    expect(after.grossTotalOre).toBe(original.grossTotalOre)
    expect(after.creditNotes[0].invoiceNumber).toBe(creditNote.invoiceNumber)
  })

  test("🔑 the original's ledger now sums to zero", async () => {
    const original = await issue()
    await asAdmin()('POST', `/invoices/${original.id}/credit-note`)

    const ledger = await prisma.transaction.findMany({ where: { invoiceId: original.id } })
    expect(ledger.map((r) => r.type).sort()).toEqual(['CREDIT_NOTE_ISSUED', 'INVOICE_CREATED'])
    expect(ledger.reduce((sum, r) => sum + r.amountOre, 0)).toBe(0)
    // Nothing was updated or deleted. A new row cancelled the old one — the
    // history of "we invoiced, then we credited" is all still there.
  })

  test('the credit note itself carries no ledger row', async () => {
    const original = await issue()
    const res = await asAdmin()('POST', `/invoices/${original.id}/credit-note`)

    const rows = await prisma.transaction.count({ where: { invoiceId: res.json().creditNote.id } })
    expect(rows).toBe(0)
    // The ledger follows the receivable. The credit note is the document
    // that explains why the receivable is gone.
  })

  test('crediting an OVERDUE invoice writes off the interest too', async () => {
    const original = await issue('2026-01-01T00:00:00.000Z')
    await runOverdueCheck(new Date('2026-03-01T00:00:00.000Z'))

    const overdue = await prisma.invoice.findUniqueOrThrow({ where: { id: original.id } })
    expect(overdue.status).toBe('OVERDUE')
    expect(overdue.lateFeeOre).toBeGreaterThan(0)

    const res = await asAdmin()('POST', `/invoices/${original.id}/credit-note`)
    expect(res.statusCode).toBe(201)

    const ledger = await prisma.transaction.findMany({ where: { invoiceId: original.id } })
    const types = ledger.map((r) => r.type)
    expect(types).toContain('LATE_FEE_ADDED')
    expect(types).toContain('LATE_FEE_WAIVED')
    expect(ledger.reduce((sum, r) => sum + r.amountOre, 0)).toBe(0)
  })

  test('a PAID invoice cannot be credited — that would be a refund', async () => {
    const original = await issue()
    await invoiceRepository.markPaid(original.id, { stripePaymentId: `pi_cn_${suffix}`, amountOre: original.grossTotalOre })

    const res = await asAdmin()('POST', `/invoices/${original.id}/credit-note`)
    expect(res.statusCode).toBe(422)
    expect(res.json().error.message).toContain('återbetalning')
  })

  test('a DRAFT cannot be credited — it was never issued', async () => {
    const created = await asAdmin()('POST', '/invoices', { clientId, dueDate: '2099-01-01T00:00:00.000Z', items: ITEMS })
    const res = await asAdmin()('POST', `/invoices/${created.json().invoice.id}/credit-note`)
    expect(res.statusCode).toBe(422)
  })

  test('a credit note cannot be credited', async () => {
    const original = await issue()
    const first = await asAdmin()('POST', `/invoices/${original.id}/credit-note`)
    const res = await asAdmin()('POST', `/invoices/${first.json().creditNote.id}/credit-note`)
    expect(res.statusCode).toBe(422)
  })

  test('crediting twice is refused — the status guard is in the WHERE clause', async () => {
    const original = await issue()
    await asAdmin()('POST', `/invoices/${original.id}/credit-note`)
    const again = await asAdmin()('POST', `/invoices/${original.id}/credit-note`)

    expect(again.statusCode).toBe(422)
    expect(await prisma.invoice.count({ where: { creditsInvoiceId: original.id } })).toBe(1)
  })

  test('a credited invoice is refused a payment link', async () => {
    const original = await issue()
    await asAdmin()('POST', `/invoices/${original.id}/credit-note`)
    const res = await asAdmin()('POST', `/invoices/${original.id}/payment-link`)
    expect(res.statusCode).toBe(422)
  })

  test('a credit note is refused a payment link', async () => {
    const original = await issue()
    const cn = await asAdmin()('POST', `/invoices/${original.id}/credit-note`)
    const res = await asAdmin()('POST', `/invoices/${cn.json().creditNote.id}/payment-link`)
    expect(res.statusCode).toBe(422)
  })

  test('the nightly job ignores credit notes', async () => {
    const original = await issue()
    const cn = (await asAdmin()('POST', `/invoices/${original.id}/credit-note`)).json().creditNote

    // Two days from now, not a far-future date: the check is global, and a
    // year-2099 run against the shared dev database would pile decades of
    // interest onto every open invoice in it (it did, once).
    await runOverdueCheck(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))

    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: cn.id } })
    expect(stored.status).toBe('SENT')
    expect(stored.lateFeeOre).toBe(0)
    // Its due date is its issue date. Without the type filter it would go
    // OVERDUE the next night and accrue negative interest.
  })

  test('the client sees both documents, linked', async () => {
    const original = await issue()
    const cn = (await asAdmin()('POST', `/invoices/${original.id}/credit-note`)).json().creditNote

    const mine = await authed(app, clientToken)('GET', `/invoices/${cn.id}`)
    expect(mine.statusCode).toBe(200)
    expect(mine.json().invoice.creditsInvoice.id).toBe(original.id)

    const pdf = await authed(app, clientToken)('GET', `/invoices/${cn.id}/pdf`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-disposition']).toContain('kreditfaktura-')
  })

  test('a CLIENT cannot issue one', async () => {
    const original = await issue()
    const res = await authed(app, clientToken)('POST', `/invoices/${original.id}/credit-note`)
    expect(res.statusCode).toBe(403)
  })

  test('is audited against the acting admin, on the credit note', async () => {
    const original = await issue()
    const cn = (await asAdmin()('POST', `/invoices/${original.id}/credit-note`)).json().creditNote
    const entry = await prisma.auditLog.findFirst({ where: { action: 'CREDIT_NOTE_ISSUED', resourceId: cn.id } })
    expect(entry).not.toBeNull()
  })
})
