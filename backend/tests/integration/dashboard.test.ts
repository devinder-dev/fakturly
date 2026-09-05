// dashboard.test.ts — the admin overview reads the ledger correctly.
//
// The database is shared with every other test file and with local
// development, so absolute totals cannot be asserted. Every money check here
// is a DIFFERENCE: read the dashboard, do something, read it again.

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
import { getAdminDashboard } from '../../src/services/dashboard.service.ts'
import * as invoiceRepository from '../../src/repositories/invoice.repository.ts'
import { topClientsByOutstanding } from '../../src/repositories/dashboard.repository.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `dash-admin-${suffix}@fakturly.se`
const CLIENT_EMAIL = `dash-kund-${suffix}@kund.se`

let adminToken: string
let clientToken: string
let clientId: string
const userIds: string[] = []

const asAdmin = () => authed(app, adminToken)

type Snapshot = Awaited<ReturnType<typeof getAdminDashboard>>

beforeAll(async () => {
  app = await buildTestApp()
  userIds.push((await createTestUser(ADMIN_EMAIL, 'ADMIN')).id)
  adminToken = (await loginAs(app, ADMIN_EMAIL, '198.51.100.120')).accessToken

  const created = await asAdmin()('POST', '/clients', {
    email: CLIENT_EMAIL,
    name: `Dashboard AB ${suffix}`
  })
  clientId = created.json().client.id
  userIds.push(created.json().client.userId)

  await prisma.user.update({
    where: { id: created.json().client.userId },
    data: { password: await testPasswordHash() }
  })
  clientToken = (await loginAs(app, CLIENT_EMAIL, '198.51.100.121')).accessToken
})

afterAll(async () => {
  await cleanupUsers(userIds)
  await clearRateLimits()
})

async function issue(grossExpectedOre: number, dueDate = '2099-01-01T00:00:00.000Z') {
  const created = await asAdmin()('POST', '/invoices', {
    clientId,
    dueDate,
    items: [
      { description: 'Rad', quantity: 1, unitPriceOre: grossExpectedOre * 0.8, vatRate: VatRate.STANDARD }
    ]
  })
  const sent = await asAdmin()('POST', `/invoices/${created.json().invoice.id}/send`)
  if (sent.statusCode !== 200) throw new Error(`send failed: ${sent.body}`)
  return sent.json().invoice as { id: string; grossTotalOre: number }
}

describe('GET /dashboard — access', () => {
  test('a CLIENT is refused with 403', async () => {
    const res = await authed(app, clientToken)('GET', '/dashboard')
    expect(res.statusCode).toBe(403)
  })

  test('no token is 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' })
    expect(res.statusCode).toBe(401)
  })

  test('an ADMIN gets the full shape, öre and formatted', async () => {
    const res = await asAdmin()('GET', '/dashboard')
    const body = res.json().dashboard

    expect(res.statusCode).toBe(200)
    expect(typeof body.outstanding.amountOre).toBe('number')
    expect(typeof body.overdue.count).toBe('number')
    expect(body.months).toHaveLength(12)
    expect(body.formatted.outstanding).toContain('SEK')
  })
})

describe('the figures move with the ledger', () => {
  let before: Snapshot

  beforeAll(async () => {
    before = await getAdminDashboard()
  })

  test('🔑 sending an invoice raises outstanding and this month\'s invoiced', async () => {
    const invoice = await issue(100_000) // 800,00 net -> 1 000,00 gross

    const after = await getAdminDashboard()

    expect(after.outstanding.amountOre - before.outstanding.amountOre).toBe(invoice.grossTotalOre)
    expect(after.outstanding.count - before.outstanding.count).toBe(1)
    expect(after.thisMonth.invoicedOre - before.thisMonth.invoicedOre).toBe(invoice.grossTotalOre)
    // Nothing was received.
    expect(after.thisMonth.receivedOre).toBe(before.thisMonth.receivedOre)
  })

  test('a DRAFT counts for nothing — it is not a financial event', async () => {
    const snapshot = await getAdminDashboard()

    await asAdmin()('POST', '/invoices', {
      clientId,
      dueDate: '2099-01-01T00:00:00.000Z',
      items: [{ description: 'Utkast', quantity: 1, unitPriceOre: 999_999, vatRate: VatRate.STANDARD }]
    })

    const after = await getAdminDashboard()
    expect(after.outstanding.amountOre).toBe(snapshot.outstanding.amountOre)
    expect(after.thisMonth.invoicedOre).toBe(snapshot.thisMonth.invoicedOre)
  })

  test('a payment moves the amount from outstanding to received', async () => {
    const invoice = await issue(50_000)
    const mid = await getAdminDashboard()

    const paid = await invoiceRepository.markPaid(invoice.id, {
      stripePaymentId: `pi_dash_${suffix}`,
      amountOre: invoice.grossTotalOre
    })
    expect(paid).not.toBeNull()

    const after = await getAdminDashboard()
    expect(mid.outstanding.amountOre - after.outstanding.amountOre).toBe(invoice.grossTotalOre)
    expect(after.thisMonth.receivedOre - mid.thisMonth.receivedOre).toBe(invoice.grossTotalOre)
    // The figure comes from the PAYMENT_RECEIVED ledger row, not from
    // Invoice.paidAt — the ledger is the record of what happened.
  })

  test('top debtors are ranked by what they owe, with names attached', async () => {
    // The shared database holds other suites' clients and the demo data, so
    // this client is not guaranteed a place in the top five. Ask the
    // repository for a long list and check the ranking rule instead.
    const ranked = await topClientsByOutstanding(1_000)
    const mine = ranked.find((c) => c.clientId === clientId)

    expect(mine).toBeDefined()
    expect(mine!.name).toContain('Dashboard AB')
    expect(mine!.outstandingOre).toBeGreaterThan(0)

    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i - 1]!.outstandingOre).toBeGreaterThanOrEqual(ranked[i]!.outstandingOre)
    }

    const dashboard = await getAdminDashboard()
    expect(dashboard.topClients.length).toBeLessThanOrEqual(5)
  })
})

describe('months', () => {
  test('are exactly twelve, oldest first, ending with the current month', async () => {
    const dashboard = await getAdminDashboard(new Date('2026-09-04T10:00:00Z'))
    const keys = dashboard.months.map((m) => m.month)

    expect(keys).toHaveLength(12)
    expect(keys[0]).toBe('2025-10')
    expect(keys[11]).toBe('2026-09')
    expect([...keys].sort()).toEqual(keys)
  })

  test('a month with no activity is present as zero, not missing', async () => {
    // Far in the future: every bucket is empty, and all twelve still exist.
    const dashboard = await getAdminDashboard(new Date('2090-06-15T10:00:00Z'))
    expect(dashboard.months).toHaveLength(12)
    expect(dashboard.months.every((m) => m.invoicedOre === 0 && m.receivedOre === 0)).toBe(true)
    // Without zero-filling, the bars on the chart would silently shift and
    // February's figure would sit under March's label.
  })

  test('🔑 the month boundary is Stockholm time, not UTC', async () => {
    // 23:30 UTC on 31 August is 01:30 on 1 September in Stockholm.
    const dashboard = await getAdminDashboard(new Date('2026-08-31T23:30:00Z'))
    expect(dashboard.months[11]!.month).toBe('2026-09')
  })
})
