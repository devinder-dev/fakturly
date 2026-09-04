// demo-seed.test.ts — the showcase dataset is built by the real code paths.
//
// GATED. This test WIPES THE DATABASE, which is what the demo reset is for
// and exactly what nobody wants from `bun test` against their local data.
// It runs only when ALLOW_DB_WIPE=1 — set in CI, where the database is
// created for the run and thrown away after it.
//
// Run locally, deliberately:  ALLOW_DB_WIPE=1 bun test tests/integration/demo-seed

import { describe, test, expect, beforeAll } from 'bun:test'
import { resetDemoData, DEMO_ACCOUNTS } from '../../src/demo/seed.ts'
import { prisma } from '../helpers.ts'
import { buildTestApp } from '../helpers.ts'

const allowed = process.env.ALLOW_DB_WIPE === '1'
const NOW = new Date('2026-09-04T10:00:00Z')

describe.skipIf(!allowed)('resetDemoData', () => {
  let summary: Awaited<ReturnType<typeof resetDemoData>>

  beforeAll(async () => {
    summary = await resetDemoData(NOW)
  })

  test('creates the advertised accounts, both able to log in', async () => {
    const app = await buildTestApp()

    for (const account of [DEMO_ACCOUNTS.admin, DEMO_ACCOUNTS.client]) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: account.email, password: account.password },
        remoteAddress: '198.51.100.140'
      })
      expect(res.statusCode).toBe(200)
    }
  })

  test('the numbers form an unbroken series starting at 0001', async () => {
    const invoices = await prisma.invoice.findMany({
      orderBy: { invoiceNumber: 'asc' },
      select: { invoiceNumber: true }
    })

    expect(invoices).toHaveLength(summary.invoices)
    invoices.forEach((invoice, index) => {
      expect(invoice.invoiceNumber).toBe(`${NOW.getUTCFullYear()}-${String(index + 1).padStart(4, '0')}`)
    })
  })

  test('numbers increase with issue dates', async () => {
    const invoices = await prisma.invoice.findMany({
      orderBy: { invoiceNumber: 'asc' },
      select: { issueDate: true }
    })
    for (let i = 1; i < invoices.length; i += 1) {
      expect(invoices[i]!.issueDate >= invoices[i - 1]!.issueDate).toBe(true)
    }
  })

  test('🔑 every sent invoice has a ledger row; drafts have none', async () => {
    const invoices = await prisma.invoice.findMany({
      select: { status: true, type: true, transactions: { select: { type: true } } }
    })

    for (const invoice of invoices) {
      const types = invoice.transactions.map((t) => t.type)
      // A credit note carries no ledger rows of its own: the rows that
      // cancel the debt sit on the invoice it credits (ADR 40).
      if (invoice.status === 'DRAFT' || invoice.type === 'CREDIT_NOTE') {
        expect(types).toHaveLength(0)
      } else {
        expect(types).toContain('INVOICE_CREATED')
      }
      if (invoice.status === 'PAID') expect(types).toContain('PAYMENT_RECEIVED')
      if (invoice.status === 'OVERDUE') expect(types).toContain('LATE_FEE_ADDED')
    }
  })

  test('overdue invoices carry interest that the ledger explains to the öre', async () => {
    const overdue = await prisma.invoice.findMany({
      where: { status: 'OVERDUE' },
      select: { lateFeeOre: true, transactions: { where: { type: 'LATE_FEE_ADDED' } } }
    })

    expect(overdue.length).toBeGreaterThan(0)
    for (const invoice of overdue) {
      const summed = invoice.transactions.reduce((total, row) => total + row.amountOre, 0)
      expect(summed).toBe(invoice.lateFeeOre)
    }
  })

  test('paid-late invoices settled for gross plus the interest owed that day', async () => {
    const paid = await prisma.invoice.findMany({
      where: { status: 'PAID' },
      select: { grossTotalOre: true, lateFeeOre: true, transactions: true }
    })

    expect(paid.length).toBeGreaterThan(0)
    for (const invoice of paid) {
      const received = invoice.transactions
        .filter((t) => t.type === 'PAYMENT_RECEIVED')
        .reduce((total, row) => total + row.amountOre, 0)
      expect(received).toBe(invoice.grossTotalOre + invoice.lateFeeOre)
    }
  })

  test('a credited invoice balances to zero and links to its credit note', async () => {
    const credited = await prisma.invoice.findMany({
      where: { status: 'CREDITED' },
      select: { transactions: true, creditNotes: { select: { type: true } } }
    })
    expect(credited.length).toBeGreaterThan(0)
    for (const invoice of credited) {
      expect(invoice.transactions.reduce((sum, row) => sum + row.amountOre, 0)).toBe(0)
      expect(invoice.creditNotes[0]?.type).toBe('CREDIT_NOTE')
    }
  })

  test('is idempotent — running twice gives the same dataset', async () => {
    const again = await resetDemoData(NOW)
    expect(again).toEqual(summary)
    expect(await prisma.invoice.count()).toBe(summary.invoices)
    expect(await prisma.user.count()).toBe(summary.users)
  })
})
