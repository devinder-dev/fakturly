// invoices.test.ts — creation, totals, ownership, status transitions.

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

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `inv-admin-${suffix}@fakturly.se`

let adminId: string
let adminToken: string
let aliceToken: string
let alice: { id: string; userId: string }
let bob: { id: string; userId: string }
const userIds: string[] = []

const asAdmin = () => authed(app, adminToken)
const asAlice = () => authed(app, aliceToken)

/** A valid invoice body, overridable per test. */
const invoiceBody = (clientId: string, overrides: Record<string, unknown> = {}) => ({
  clientId,
  dueDate: '2026-12-31T00:00:00.000Z',
  items: [
    { description: 'Konsulttimmar', quantity: 10, unitPriceOre: 100_000, vatRate: VatRate.STANDARD }
  ],
  ...overrides
})

beforeAll(async () => {
  app = await buildTestApp()

  adminId = (await createTestUser(ADMIN_EMAIL, 'ADMIN')).id
  userIds.push(adminId)
  adminToken = (await loginAs(app, ADMIN_EMAIL, '198.51.100.60')).accessToken

  const a = await asAdmin()('POST', '/clients', {
    email: `inv-alice-${suffix}@kund.se`,
    name: 'Alice AB'
  })
  const b = await asAdmin()('POST', '/clients', {
    email: `inv-bob-${suffix}@kund.se`,
    name: 'Bob AB'
  })
  alice = a.json().client
  bob = b.json().client
  userIds.push(alice.userId, bob.userId)

  await prisma.user.updateMany({
    where: { id: { in: [alice.userId, bob.userId] } },
    data: { password: await testPasswordHash() }
  })
  aliceToken = (await loginAs(app, `inv-alice-${suffix}@kund.se`, '198.51.100.61')).accessToken
})

afterAll(async () => {
  await cleanupUsers(userIds)
  // NOTE: the invoice-number counter is deliberately NOT reset here.
  //
  // It is monotonic by design — rewinding it while invoices bearing those
  // numbers still exist re-creates exactly the collision the unbroken-series
  // requirement exists to prevent. That is not hypothetical: resetting it
  // here broke 20 tests the moment a manually-created invoice survived in
  // the dev database.
  //
  // Letting it advance costs nothing. The series is allowed to have gaps.
  await clearRateLimits()
})

describe('POST /invoices', () => {
  test('creates a DRAFT with a server-allocated number', async () => {
    const res = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const invoice = res.json().invoice

    expect(res.statusCode).toBe(201)
    expect(invoice.status).toBe('DRAFT')
    expect(invoice.invoiceNumber).toMatch(/^\d{4}-\d{4}$/)
    expect(invoice.sentAt).toBeNull()
    expect(invoice.paidAt).toBeNull()
  })

  test('🔑 computes every total from the items', async () => {
    const res = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const invoice = res.json().invoice

    // 10 x 1000,00 SEK = 10 000,00 net; 25% VAT = 2 500,00; gross 12 500,00
    expect(invoice.netTotalOre).toBe(1_000_000)
    expect(invoice.vatTotalOre).toBe(250_000)
    expect(invoice.grossTotalOre).toBe(1_250_000)
    expect(invoice.items[0].netOre).toBe(1_000_000)
    expect(invoice.items[0].vatOre).toBe(250_000)
  })

  test('🔒 IGNORES totals sent by the caller', async () => {
    const res = await asAdmin()('POST', '/invoices', {
      ...invoiceBody(alice.id),
      grossTotalOre: 1, // "please charge 1 öre"
      netTotalOre: 1,
      vatTotalOre: 0,
      invoiceNumber: '1999-0001'
    })
    const invoice = res.json().invoice

    expect(invoice.grossTotalOre).toBe(1_250_000)
    expect(invoice.invoiceNumber).not.toBe('1999-0001')
    // Totals are a consequence of the items, never input.
  })

  test('handles mixed VAT rates on one invoice', async () => {
    const res = await asAdmin()('POST', '/invoices', invoiceBody(alice.id, {
      items: [
        { description: 'Konsult', quantity: 1, unitPriceOre: 100_000, vatRate: VatRate.STANDARD },
        { description: 'Bok', quantity: 3, unitPriceOre: 24_900, vatRate: VatRate.REDUCED_6 },
        { description: 'Utbildning', quantity: 1, unitPriceOre: 50_000, vatRate: VatRate.ZERO }
      ]
    }))
    const invoice = res.json().invoice

    expect(invoice.netTotalOre).toBe(100_000 + 74_700 + 50_000)
    expect(invoice.vatTotalOre).toBe(25_000 + 4_482 + 0)
    expect(invoice.items).toHaveLength(3)
  })

  test('returns formatted amounts alongside the exact öre', async () => {
    const res = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const invoice = res.json().invoice

    expect(invoice.formatted.grossTotal).toContain('12')
    expect(invoice.formatted.grossTotal).toContain('SEK')
    expect(typeof invoice.grossTotalOre).toBe('number')
  })

  test('numbers increase across invoices', async () => {
    const first = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const second = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))

    const a = Number(first.json().invoice.invoiceNumber.split('-')[1])
    const b = Number(second.json().invoice.invoiceNumber.split('-')[1])
    expect(b).toBe(a + 1)
  })

  test('a DRAFT writes NO ledger row — it is not a financial event yet', async () => {
    const res = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const invoiceId = res.json().invoice.id

    const ledger = await prisma.transaction.findMany({ where: { invoiceId } })
    expect(ledger).toHaveLength(0)
    // Nobody has been invoiced, nothing is owed, and the draft can still be
    // deleted. Writing the ledger entry here would either leave orphan rows
    // or force us to make the ledger deletable.
  })

  test('audits against the acting admin', async () => {
    const res = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'INVOICE_CREATED', resourceId: res.json().invoice.id }
    })

    expect(entry).not.toBeNull()
    expect(entry!.userId).toBe(adminId)
  })
})

describe('POST /invoices — validation', () => {
  test('rejects an unknown client', async () => {
    const res = await asAdmin()('POST', '/invoices', invoiceBody('clnotarealclient00'))
    expect(res.statusCode).toBe(404)
  })

  test('rejects an invoice with no lines', async () => {
    const res = await asAdmin()('POST', '/invoices', invoiceBody(alice.id, { items: [] }))
    expect(res.statusCode).toBe(400)
  })

  test('rejects a VAT rate Sweden does not use', async () => {
    const res = await asAdmin()('POST', '/invoices', invoiceBody(alice.id, {
      items: [{ description: 'X', quantity: 1, unitPriceOre: 1000, vatRate: 300 }]
    }))
    expect(res.statusCode).toBe(400)
    // 3% would never match a VAT return, and an accountant would find it long
    // after the invoice was sent.
  })

  test('rejects a non-integer price — öre are whole numbers', async () => {
    const res = await asAdmin()('POST', '/invoices', invoiceBody(alice.id, {
      items: [{ description: 'X', quantity: 1, unitPriceOre: 99.99, vatRate: VatRate.STANDARD }]
    }))
    expect(res.statusCode).toBe(400)
  })

  test('rejects a zero quantity', async () => {
    const res = await asAdmin()('POST', '/invoices', invoiceBody(alice.id, {
      items: [{ description: 'X', quantity: 0, unitPriceOre: 1000, vatRate: VatRate.STANDARD }]
    }))
    expect(res.statusCode).toBe(400)
  })

  test('rejects an invoice whose lines cancel to zero', async () => {
    const res = await asAdmin()('POST', '/invoices', invoiceBody(alice.id, {
      items: [
        { description: 'A', quantity: 5, unitPriceOre: 1000, vatRate: VatRate.STANDARD },
        { description: 'A', quantity: -5, unitPriceOre: 1000, vatRate: VatRate.STANDARD }
      ]
    }))

    expect(res.statusCode).toBe(422)
    // It would consume a number in the legally-required series to say nothing.
  })

  test('allows a negative quantity for a credit line', async () => {
    const res = await asAdmin()('POST', '/invoices', invoiceBody(alice.id, {
      items: [
        { description: 'Arbete', quantity: 10, unitPriceOre: 100_000, vatRate: VatRate.STANDARD },
        { description: 'Rabatt', quantity: -1, unitPriceOre: 50_000, vatRate: VatRate.STANDARD }
      ]
    }))

    expect(res.statusCode).toBe(201)
    expect(res.json().invoice.netTotalOre).toBe(1_000_000 - 50_000)
  })

  test('a CLIENT cannot create an invoice', async () => {
    const res = await asAlice()('POST', '/invoices', invoiceBody(alice.id))
    expect(res.statusCode).toBe(403)
  })
})

describe('🎯 IDOR — reading invoices', () => {
  let aliceInvoiceId: string
  let bobInvoiceId: string

  beforeAll(async () => {
    aliceInvoiceId = (await asAdmin()('POST', '/invoices', invoiceBody(alice.id))).json().invoice.id
    bobInvoiceId = (await asAdmin()('POST', '/invoices', invoiceBody(bob.id))).json().invoice.id
  })

  test('Alice can read her own invoice', async () => {
    const res = await asAlice()('GET', `/invoices/${aliceInvoiceId}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().invoice.clientId).toBe(alice.id)
  })

  test("Alice reading Bob's invoice gets 404, not 403", async () => {
    const res = await asAlice()('GET', `/invoices/${bobInvoiceId}`)
    expect(res.statusCode).toBe(404)
  })

  test('🔑 identical to an invoice that never existed', async () => {
    const notYours = await asAlice()('GET', `/invoices/${bobInvoiceId}`)
    const neverExisted = await asAlice()('GET', '/invoices/clnotarealinvoice0')

    expect(neverExisted.statusCode).toBe(notYours.statusCode)
    expect(neverExisted.json().error.message).toBe(notYours.json().error.message)
    // Invoice numbers are sequential by law, so confirming 2026-0007 exists
    // would reveal how many invoices the business has issued this year.
  })

  test('the list is scoped in the QUERY, not filtered afterwards', async () => {
    const res = await asAlice()('GET', '/invoices')
    const clientIds = new Set(res.json().invoices.map((i: { clientId: string }) => i.clientId))

    expect(res.statusCode).toBe(200)
    expect([...clientIds]).toEqual([alice.id])
  })

  test("a client asking for another client's invoices is silently scoped back", async () => {
    const res = await asAlice()('GET', `/invoices?clientId=${bob.id}`)
    const clientIds = new Set(res.json().invoices.map((i: { clientId: string }) => i.clientId))

    expect(res.statusCode).toBe(200)
    expect(clientIds.has(bob.id)).toBe(false)
    // Refusing would confirm Bob's client id is real.
  })

  test('an admin sees every invoice and can filter by client', async () => {
    const all = await asAdmin()('GET', '/invoices')
    expect(all.json().pagination.total).toBeGreaterThan(1)

    const bobOnly = await asAdmin()('GET', `/invoices?clientId=${bob.id}`)
    const clientIds = new Set(bobOnly.json().invoices.map((i: { clientId: string }) => i.clientId))
    expect([...clientIds]).toEqual([bob.id])
  })
})

describe('status transitions', () => {
  test('the transition table allows only legal moves', () => {
    expect(canTransition('DRAFT', 'SENT')).toBe(true)
    expect(canTransition('SENT', 'PAID')).toBe(true)
    expect(canTransition('SENT', 'OVERDUE')).toBe(true)
    expect(canTransition('OVERDUE', 'PAID')).toBe(true)

    expect(canTransition('DRAFT', 'PAID')).toBe(false)
    expect(canTransition('SENT', 'DRAFT')).toBe(false)
    expect(canTransition('PAID', 'SENT')).toBe(false)
    expect(canTransition('PAID', 'OVERDUE')).toBe(false)
  })

  test('sending moves DRAFT to SENT and stamps sentAt', async () => {
    const created = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const id = created.json().invoice.id

    const sent = await asAdmin()('POST', `/invoices/${id}/send`)

    expect(sent.statusCode).toBe(200)
    expect(sent.json().invoice.status).toBe('SENT')
    expect(sent.json().invoice.sentAt).not.toBeNull()
  })

  test('🔑 sending writes the immutable ledger row, atomically', async () => {
    const created = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const id = created.json().invoice.id

    expect(await prisma.transaction.count({ where: { invoiceId: id } })).toBe(0)

    await asAdmin()('POST', `/invoices/${id}/send`)

    const ledger = await prisma.transaction.findMany({ where: { invoiceId: id } })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.type).toBe('INVOICE_CREATED')
    expect(ledger[0]!.amountOre).toBe(1_250_000) // gross — what is actually owed
  })

  test('a refused second send writes no second ledger row', async () => {
    const created = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const id = created.json().invoice.id

    await asAdmin()('POST', `/invoices/${id}/send`)
    await asAdmin()('POST', `/invoices/${id}/send`)

    expect(await prisma.transaction.count({ where: { invoiceId: id } })).toBe(1)
  })

  test('sending twice is refused', async () => {
    const created = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const id = created.json().invoice.id

    await asAdmin()('POST', `/invoices/${id}/send`)
    const again = await asAdmin()('POST', `/invoices/${id}/send`)

    expect(again.statusCode).toBe(422)
  })

  test('a CLIENT cannot send', async () => {
    const created = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const res = await asAlice()('POST', `/invoices/${created.json().invoice.id}/send`)
    expect(res.statusCode).toBe(403)
  })

  test('INVOICE_SENT is audited', async () => {
    const created = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const id = created.json().invoice.id
    await asAdmin()('POST', `/invoices/${id}/send`)

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'INVOICE_SENT', resourceId: id }
    })
    expect(entry).not.toBeNull()
  })
})

describe('🔒 a sent invoice is frozen', () => {
  test('a DRAFT can be deleted', async () => {
    const created = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const id = created.json().invoice.id

    const res = await asAdmin()('DELETE', `/invoices/${id}`)

    expect(res.statusCode).toBe(204)
    expect(await prisma.invoice.findUnique({ where: { id } })).toBeNull()
  })

  test('deleting a draft removes its lines too', async () => {
    const created = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const id = created.json().invoice.id

    await asAdmin()('DELETE', `/invoices/${id}`)

    expect(await prisma.invoiceItem.count({ where: { invoiceId: id } })).toBe(0)
  })

  test('a SENT invoice cannot be deleted', async () => {
    const created = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const id = created.json().invoice.id
    await asAdmin()('POST', `/invoices/${id}/send`)

    const res = await asAdmin()('DELETE', `/invoices/${id}`)

    expect(res.statusCode).toBe(422)
    expect(await prisma.invoice.findUnique({ where: { id } })).not.toBeNull()
    // It belongs to the numbered series; its absence would be a hole someone
    // has to account for. Corrections are credit notes.
  })

  test('a CLIENT cannot delete anything', async () => {
    const created = await asAdmin()('POST', '/invoices', invoiceBody(alice.id))
    const res = await asAlice()('DELETE', `/invoices/${created.json().invoice.id}`)
    expect(res.statusCode).toBe(403)
  })
})

describe('without a token', () => {
  test('every invoice route is 401', async () => {
    const routes: Array<['GET' | 'POST' | 'DELETE', string]> = [
      ['GET', '/invoices'],
      ['GET', '/invoices/someid'],
      ['POST', '/invoices'],
      ['POST', '/invoices/someid/send'],
      ['DELETE', '/invoices/someid']
    ]

    for (const [method, url] of routes) {
      const res = await app.inject({
        method,
        url,
        ...(method === 'POST' && url === '/invoices' ? { payload: invoiceBody(alice.id) } : {})
      })
      expect(res.statusCode).toBe(401)
    }
  })
})
