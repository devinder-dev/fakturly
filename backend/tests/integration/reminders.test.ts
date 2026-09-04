// reminders.test.ts — the statutory reminder fee, charged once.

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
  prisma
} from '../helpers.ts'
import { VatRate, REMINDER_FEE_ORE, totalDueOre } from '../../src/lib/money.ts'
import { getEmailQueue, closeQueues } from '../../src/jobs/queues.ts'
import { processEmailJob } from '../../src/jobs/workers/email.worker.ts'
import * as invoiceRepository from '../../src/repositories/invoice.repository.ts'
import type { Job } from 'bullmq'
import type { EmailJobData } from '../../src/jobs/queues.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `rem-admin-${suffix}@fakturly.se`

let adminToken: string
let clientId: string
const userIds: string[] = []
const asAdmin = () => authed(app, adminToken)

beforeAll(async () => {
  app = await buildTestApp()
  userIds.push((await createTestUser(ADMIN_EMAIL, 'ADMIN')).id)
  adminToken = (await loginAs(app, ADMIN_EMAIL, '198.51.100.160')).accessToken

  const created = await asAdmin()('POST', '/clients', {
    email: `rem-kund-${suffix}@kund.se`,
    name: 'Påminnelse AB'
  })
  clientId = created.json().client.id
  userIds.push(created.json().client.userId)
})

afterAll(async () => {
  // Reminders enqueue email jobs. No worker runs in tests, so drain them
  // rather than leave them for the dev server to pick up later.
  await getEmailQueue().drain()
  await closeQueues()
  await cleanupUsers(userIds)
  await clearRateLimits()
})

async function issue() {
  const created = await asAdmin()('POST', '/invoices', {
    clientId,
    dueDate: '2026-01-01T00:00:00.000Z',
    items: [{ description: 'Arbete', quantity: 1, unitPriceOre: 100_000, vatRate: VatRate.STANDARD }]
  })
  const sent = await asAdmin()('POST', `/invoices/${created.json().invoice.id}/send`)
  return sent.json().invoice as { id: string; invoiceNumber: string; grossTotalOre: number }
}

describe('POST /invoices/:id/reminder', () => {
  test('🔑 the first reminder charges 60 kr, with a ledger row', async () => {
    const invoice = await issue()
    const res = await asAdmin()('POST', `/invoices/${invoice.id}/reminder`)

    expect(res.statusCode).toBe(200)
    expect(res.json().feeCharged).toBe(true)
    expect(res.json().invoice.reminderFeeOre).toBe(REMINDER_FEE_ORE)
    expect(res.json().invoice.reminderSentAt).not.toBeNull()
    expect(res.json().invoice.totalDueOre).toBe(invoice.grossTotalOre + REMINDER_FEE_ORE)

    const rows = await prisma.transaction.findMany({ where: { invoiceId: invoice.id, type: 'REMINDER_FEE_ADDED' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.amountOre).toBe(6_000)
  })

  test('🔑 a second reminder sends again but charges nothing more', async () => {
    const invoice = await issue()
    await asAdmin()('POST', `/invoices/${invoice.id}/reminder`)
    const again = await asAdmin()('POST', `/invoices/${invoice.id}/reminder`)

    expect(again.statusCode).toBe(200)
    expect(again.json().feeCharged).toBe(false)
    expect(again.json().invoice.reminderFeeOre).toBe(REMINDER_FEE_ORE)

    const rows = await prisma.transaction.count({ where: { invoiceId: invoice.id, type: 'REMINDER_FEE_ADDED' } })
    expect(rows).toBe(1)
    // Lag (1981:739): one fee per debt. The "once" lives in the WHERE clause,
    // so two simultaneous clicks cannot both charge.
  })

  test('the reminder email is queued, and states the fee', async () => {
    const invoice = await issue()
    await asAdmin()('POST', `/invoices/${invoice.id}/reminder`)

    const waiting = await getEmailQueue().getJobs(['waiting', 'delayed'])
    const mine = waiting.find((job) => job.data.invoiceId === invoice.id)
    expect(mine?.data.kind).toBe('payment-reminder')

    // Run the worker's function directly, as the worker would.
    const result = await processEmailJob({ data: mine!.data } as Job<EmailJobData>)
    expect(result).toEqual({ sent: 'payment-reminder', invoiceNumber: invoice.invoiceNumber })

    const log = await prisma.emailLog.findFirst({ where: { invoiceId: invoice.id, type: 'REMINDER' } })
    expect(log).not.toBeNull()
  })

  test('the payment link charges gross + fee', async () => {
    const invoice = await issue()
    await asAdmin()('POST', `/invoices/${invoice.id}/reminder`)

    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(totalDueOre(stored)).toBe(invoice.grossTotalOre + REMINDER_FEE_ORE)

    const link = await asAdmin()('POST', `/invoices/${invoice.id}/payment-link`)
    expect(link.statusCode).toBe(201)
  })

  test('a PAID invoice cannot be reminded', async () => {
    const invoice = await issue()
    await invoiceRepository.markPaid(invoice.id, { stripePaymentId: `pi_rem_${suffix}`, amountOre: invoice.grossTotalOre })
    const res = await asAdmin()('POST', `/invoices/${invoice.id}/reminder`)
    expect(res.statusCode).toBe(422)
  })

  test('a DRAFT cannot be reminded', async () => {
    const created = await asAdmin()('POST', '/invoices', {
      clientId,
      dueDate: '2026-01-01T00:00:00.000Z',
      items: [{ description: 'X', quantity: 1, unitPriceOre: 1_000, vatRate: VatRate.STANDARD }]
    })
    const res = await asAdmin()('POST', `/invoices/${created.json().invoice.id}/reminder`)
    expect(res.statusCode).toBe(422)
  })

  test('crediting a reminded invoice writes the fee off', async () => {
    const invoice = await issue()
    await asAdmin()('POST', `/invoices/${invoice.id}/reminder`)
    await asAdmin()('POST', `/invoices/${invoice.id}/credit-note`)

    const ledger = await prisma.transaction.findMany({ where: { invoiceId: invoice.id } })
    expect(ledger.map((r) => r.type)).toContain('REMINDER_FEE_WAIVED')
    expect(ledger.reduce((sum, r) => sum + r.amountOre, 0)).toBe(0)
  })

  test('sending an invoice emails the customer', async () => {
    const invoice = await issue()
    const log = await prisma.emailLog.findFirst({ where: { invoiceId: invoice.id, type: 'INVOICE_SENT' } })
    expect(log).not.toBeNull()
    // Wired up in this phase — before it, "send" changed the status and
    // nobody was told.
  })

  test('REMINDER_SENT is audited', async () => {
    const invoice = await issue()
    await asAdmin()('POST', `/invoices/${invoice.id}/reminder`)
    const entry = await prisma.auditLog.findFirst({ where: { action: 'REMINDER_SENT', resourceId: invoice.id } })
    expect(entry).not.toBeNull()
  })
})
