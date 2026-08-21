// invoicing.test.ts — the whole business flow, start to finish.
//
// Not a unit test and not really an integration test either: this is the
// story the software exists to support, told once, in order. If this passes,
// a business can actually invoice a customer.

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
import { VatRate, formatOre } from '../../src/lib/money.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `e2e-admin-${suffix}@fakturly.se`
const CLIENT_EMAIL = `e2e-kund-${suffix}@kund.se`
const OTHER_EMAIL = `e2e-annan-${suffix}@kund.se`

const userIds: string[] = []
let adminId: string
let adminToken: string
let clientToken: string
let client: { id: string; userId: string }
let otherClient: { id: string; userId: string }
let invoiceId: string
let invoiceNumber: string

beforeAll(async () => {
  app = await buildTestApp()
  adminId = (await createTestUser(ADMIN_EMAIL, 'ADMIN')).id
  userIds.push(adminId)
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

describe('1. the admin signs in', () => {
  test('receives an access token and a refresh cookie', async () => {
    const session = await loginAs(app, ADMIN_EMAIL, '198.51.100.90')
    adminToken = session.accessToken

    expect(adminToken).toBeTruthy()
    expect(session.refreshCookie).toBeTruthy()
  })

  test('the login is recorded in the audit log', async () => {
    const entry = await prisma.auditLog.findFirst({
      where: { userId: adminId, action: 'LOGIN_SUCCESS' }
    })
    expect(entry).not.toBeNull()
  })
})

describe('2. the admin takes on a customer', () => {
  test('provisioning creates the login and the customer record together', async () => {
    const res = await authed(app, adminToken)('POST', '/clients', {
      email: CLIENT_EMAIL,
      name: 'Nordic Design AB',
      phone: '070-1234567',
      address: 'Storgatan 1, 111 22 Stockholm'
    })

    expect(res.statusCode).toBe(201)
    client = res.json().client
    userIds.push(client.userId)

    const user = await prisma.user.findUnique({ where: { id: client.userId } })
    const record = await prisma.client.findUnique({ where: { id: client.id } })

    expect(user?.role).toBe('CLIENT')
    expect(record?.name).toBe('Nordic Design AB')
  })

  test('no temporary password is ever returned', async () => {
    const res = await authed(app, adminToken)('POST', '/clients', {
      email: OTHER_EMAIL,
      name: 'Annan Kund AB'
    })
    otherClient = res.json().client
    userIds.push(otherClient.userId)

    expect(JSON.stringify(res.json()).toLowerCase()).not.toContain('password')
    // It would end up in browser history, proxy logs and screen recordings.
  })
})

describe('3. the admin writes an invoice', () => {
  test('with mixed VAT rates, and every figure is computed server-side', async () => {
    const res = await authed(app, adminToken)('POST', '/invoices', {
      clientId: client.id,
      dueDate: '2026-12-31T00:00:00.000Z',
      items: [
        // 40 hours at 950,00 SEK, standard VAT
        { description: 'Designarbete', quantity: 40, unitPriceOre: 95_000, vatRate: VatRate.STANDARD },
        // A book at 6%
        { description: 'Tryckt manual', quantity: 2, unitPriceOre: 24_900, vatRate: VatRate.REDUCED_6 },
        // A discount line — negative quantity
        { description: 'Introduktionsrabatt', quantity: -1, unitPriceOre: 50_000, vatRate: VatRate.STANDARD }
      ]
    })

    expect(res.statusCode).toBe(201)
    const invoice = res.json().invoice
    invoiceId = invoice.id
    invoiceNumber = invoice.invoiceNumber

    // net: 40 x 95000 = 3 800 000, + 2 x 24900 = 49 800, - 50 000
    const expectedNet = 3_800_000 + 49_800 - 50_000
    // VAT: 950 000 + 2 988 - 12 500
    const expectedVat = 950_000 + 2_988 - 12_500

    expect(invoice.netTotalOre).toBe(expectedNet)
    expect(invoice.vatTotalOre).toBe(expectedVat)
    expect(invoice.grossTotalOre).toBe(expectedNet + expectedVat)
    expect(invoice.status).toBe('DRAFT')
  })

  test('the number belongs to this year’s series', async () => {
    expect(invoiceNumber).toMatch(new RegExp(`^${new Date().getFullYear()}-\\d{4}$`))
  })

  test('the displayed total matches the exact öre', async () => {
    const res = await authed(app, adminToken)('GET', `/invoices/${invoiceId}`)
    const invoice = res.json().invoice

    expect(invoice.formatted.grossTotal).toBe(formatOre(invoice.grossTotalOre, 'SEK'))
  })

  test('each line’s VAT sums to the invoice VAT — the printed document adds up', async () => {
    const res = await authed(app, adminToken)('GET', `/invoices/${invoiceId}`)
    const invoice = res.json().invoice

    const lineVat = invoice.items.reduce((sum: number, i: { vatOre: number }) => sum + i.vatOre, 0)
    const lineNet = invoice.items.reduce((sum: number, i: { netOre: number }) => sum + i.netOre, 0)

    expect(lineVat).toBe(invoice.vatTotalOre)
    expect(lineNet).toBe(invoice.netTotalOre)
  })

  test('while it is a draft, no money has moved', async () => {
    expect(await prisma.transaction.count({ where: { invoiceId } })).toBe(0)
  })
})

describe('4. the customer signs in and sees their invoice', () => {
  beforeAll(async () => {
    // Stand in for the invite email, which arrives in week 3.
    await prisma.user.update({
      where: { id: client.userId },
      data: { password: await testPasswordHash() }
    })
    clientToken = (await loginAs(app, CLIENT_EMAIL, '198.51.100.91')).accessToken
  })

  test('their own profile, without needing to know its id', async () => {
    const res = await authed(app, clientToken)('GET', '/clients/me')

    expect(res.statusCode).toBe(200)
    expect(res.json().client.name).toBe('Nordic Design AB')
  })

  test('their invoice list contains only their own', async () => {
    await authed(app, adminToken)('POST', '/invoices', {
      clientId: otherClient.id,
      dueDate: '2026-12-31T00:00:00.000Z',
      items: [{ description: 'X', quantity: 1, unitPriceOre: 10_000, vatRate: VatRate.STANDARD }]
    })

    const res = await authed(app, clientToken)('GET', '/invoices')
    const clientIds = new Set(res.json().invoices.map((i: { clientId: string }) => i.clientId))

    expect([...clientIds]).toEqual([client.id])
  })

  test('🔒 another customer’s invoice is invisible, not merely forbidden', async () => {
    const others = await authed(app, adminToken)('GET', `/invoices?clientId=${otherClient.id}`)
    const otherInvoiceId = others.json().invoices[0].id

    const notYours = await authed(app, clientToken)('GET', `/invoices/${otherInvoiceId}`)
    const neverExisted = await authed(app, clientToken)('GET', '/invoices/clfakeinvoiceid00')

    expect(notYours.statusCode).toBe(404)
    expect(notYours.json().error.message).toBe(neverExisted.json().error.message)
  })

  test('a customer cannot issue invoices', async () => {
    const res = await authed(app, clientToken)('POST', '/invoices', {
      clientId: client.id,
      dueDate: '2026-12-31T00:00:00.000Z',
      items: [{ description: 'Gratis', quantity: 1, unitPriceOre: 1, vatRate: VatRate.STANDARD }]
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('5. the admin sends the invoice', () => {
  test('the status becomes SENT and the ledger records it', async () => {
    const res = await authed(app, adminToken)('POST', `/invoices/${invoiceId}/send`)

    expect(res.statusCode).toBe(200)
    expect(res.json().invoice.status).toBe('SENT')
    expect(res.json().invoice.sentAt).not.toBeNull()

    const ledger = await prisma.transaction.findMany({ where: { invoiceId } })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.type).toBe('INVOICE_CREATED')
    expect(ledger[0]!.amountOre).toBe(res.json().invoice.grossTotalOre)
  })

  test('🔒 and from now on it cannot be deleted', async () => {
    const res = await authed(app, adminToken)('DELETE', `/invoices/${invoiceId}`)

    expect(res.statusCode).toBe(422)
    expect(await prisma.invoice.findUnique({ where: { id: invoiceId } })).not.toBeNull()
    // It belongs to the numbered series now. A correction is a credit note.
  })

  test('it cannot be sent a second time, and no second ledger row appears', async () => {
    const res = await authed(app, adminToken)('POST', `/invoices/${invoiceId}/send`)

    expect(res.statusCode).toBe(422)
    expect(await prisma.transaction.count({ where: { invoiceId } })).toBe(1)
  })

  test('the customer can see it is now sent', async () => {
    const res = await authed(app, clientToken)('GET', `/invoices/${invoiceId}`)

    expect(res.statusCode).toBe(200)
    expect(res.json().invoice.status).toBe('SENT')
  })
})

describe('6. a draft is still disposable', () => {
  test('an unsent invoice can be deleted, lines and all', async () => {
    const created = await authed(app, adminToken)('POST', '/invoices', {
      clientId: client.id,
      dueDate: '2026-12-31T00:00:00.000Z',
      items: [{ description: 'Misstag', quantity: 1, unitPriceOre: 100, vatRate: VatRate.STANDARD }]
    })
    const draftId = created.json().invoice.id

    const res = await authed(app, adminToken)('DELETE', `/invoices/${draftId}`)

    expect(res.statusCode).toBe(204)
    expect(await prisma.invoice.findUnique({ where: { id: draftId } })).toBeNull()
    expect(await prisma.invoiceItem.count({ where: { invoiceId: draftId } })).toBe(0)
  })
})

describe('7. the audit trail tells the whole story', () => {
  test('every action was recorded against the person who took it', async () => {
    const entries = await prisma.auditLog.findMany({
      where: { userId: { in: userIds } },
      select: { action: true, userId: true }
    })
    const actions = new Set(entries.map((e) => e.action))

    for (const expected of [
      'LOGIN_SUCCESS',
      'CLIENT_CREATED',
      'INVOICE_CREATED',
      'INVOICE_SENT',
      'INVOICE_DELETED'
    ]) {
      expect(actions.has(expected)).toBe(true)
    }
  })

  test('invoice actions are attributed to the ADMIN, not the customer', async () => {
    const entries = await prisma.auditLog.findMany({
      where: { action: { in: ['INVOICE_CREATED', 'INVOICE_SENT'] } }
    })
    const forThisRun = entries.filter((e) => userIds.includes(e.userId ?? ''))

    expect(forThisRun.length).toBeGreaterThan(0)
    expect(forThisRun.every((e) => e.userId === adminId)).toBe(true)
    // An audit log answers "who performed this action", not "who was affected".
  })

  test('🔒 the ledger was never updated or deleted', async () => {
    const ledger = await prisma.transaction.findMany({ where: { invoiceId } })

    expect(ledger).toHaveLength(1)
    // Transaction has no updatedAt column by design — there is no way to
    // record a modification, because modification is not permitted.
    expect('updatedAt' in ledger[0]!).toBe(false)
  })
})
