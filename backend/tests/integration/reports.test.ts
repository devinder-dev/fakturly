// reports.test.ts — aging, VAT and SIE.
//
// The database is shared, so the aging and VAT reports are checked through
// the client this file creates, and through invariants (rows sum to totals),
// not through absolute figures.

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
import { VatRate } from '../../src/lib/money.ts'
import { agingBucket, agingReport, vatReport } from '../../src/services/report.service.ts'
import { runOverdueCheck } from '../../src/services/overdue.service.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()
const ADMIN_EMAIL = `rep-admin-${suffix}@fakturly.se`

let adminToken: string
let clientToken: string
let clientId: string
const userIds: string[] = []
const asAdmin = () => authed(app, adminToken)

const AS_OF = new Date('2026-09-04T12:00:00Z')

beforeAll(async () => {
  app = await buildTestApp()
  userIds.push((await createTestUser(ADMIN_EMAIL, 'ADMIN')).id)
  adminToken = (await loginAs(app, ADMIN_EMAIL, '198.51.100.170')).accessToken

  const created = await asAdmin()('POST', '/clients', {
    email: `rep-kund-${suffix}@kund.se`,
    name: `Rapport AB ${suffix}`
  })
  clientId = created.json().client.id
  userIds.push(created.json().client.userId)
  const clientUser = await createTestUser(`rep-kund2-${suffix}@kund.se`, 'CLIENT')
  userIds.push(clientUser.id)
  clientToken = (await loginAs(app, clientUser.email, '198.51.100.171')).accessToken

  // Three invoices at different ages: 10 days late, 45 days late, not due.
  for (const due of ['2026-08-25', '2026-07-21', '2026-12-01']) {
    const res = await asAdmin()('POST', '/invoices', {
      clientId,
      dueDate: `${due}T00:00:00.000Z`,
      items: [
        { description: 'Tjänst', quantity: 1, unitPriceOre: 100_000, vatRate: VatRate.STANDARD },
        { description: 'Bok', quantity: 1, unitPriceOre: 10_000, vatRate: VatRate.REDUCED_6 }
      ]
    })
    await asAdmin()('POST', `/invoices/${res.json().invoice.id}/send`)
  }
  await runOverdueCheck(AS_OF)
})

afterAll(async () => {
  await cleanupUsers(userIds)
  await clearRateLimits()
})

describe('aging buckets', () => {
  test('edges are inclusive at the top', () => {
    expect(agingBucket(0)).toBe('current')
    expect(agingBucket(1)).toBe('days1to30')
    expect(agingBucket(30)).toBe('days1to30')
    expect(agingBucket(31)).toBe('days31to60')
    expect(agingBucket(60)).toBe('days31to60')
    expect(agingBucket(61)).toBe('days61to90')
    expect(agingBucket(90)).toBe('days61to90')
    expect(agingBucket(91)).toBe('over90')
    expect(agingBucket(400)).toBe('over90')
  })
})

describe('GET /reports/aging', () => {
  test('🔑 places each invoice in the right bucket, as of a date', async () => {
    const report = await agingReport(AS_OF)
    const mine = report.rows.find((r) => r.clientId === clientId)

    expect(mine).toBeDefined()
    expect(mine!.invoiceCount).toBe(3)
    expect(mine!.current).toBeGreaterThan(0) // due in December
    expect(mine!.days1to30).toBeGreaterThan(0) // 10 days late
    expect(mine!.days31to60).toBeGreaterThan(0) // 45 days late
    expect(mine!.days61to90).toBe(0)
    expect(mine!.over90).toBe(0)
    expect(mine!.oldestDueDate.toISOString().slice(0, 10)).toBe('2026-07-21')
  })

  test('the late buckets include accrued interest — what is actually owed', async () => {
    const report = await agingReport(AS_OF)
    const mine = report.rows.find((r) => r.clientId === clientId)!
    const gross = 100_000 + 25_000 + 10_000 + 600

    expect(mine.current).toBe(gross)
    expect(mine.days1to30).toBeGreaterThan(gross)
    expect(mine.days31to60).toBeGreaterThan(mine.days1to30) // more days, more interest
  })

  test('rows sum to totals, bucket by bucket', async () => {
    const report = await agingReport(AS_OF)
    for (const key of ['current', 'days1to30', 'days31to60', 'days61to90', 'over90', 'totalOre'] as const) {
      const summed = report.rows.reduce((n, r) => n + r[key], 0)
      expect(summed).toBe(report.totals[key])
    }
  })

  test('the same report a year later has everything over 90', async () => {
    const report = await agingReport(new Date('2027-09-04T12:00:00Z'))
    const mine = report.rows.find((r) => r.clientId === clientId)!
    expect(mine.over90).toBe(mine.totalOre)
    // "As of" is an argument, so an auditor's "how did it look at year end"
    // is a normal call rather than a database restore.
  })

  test('answers JSON with bucket labels, and CSV on request', async () => {
    const json = await asAdmin()('GET', `/reports/aging?asOf=${AS_OF.toISOString()}`)
    expect(json.statusCode).toBe(200)
    expect(json.json().report.buckets.map((b: { key: string }) => b.key)).toEqual([
      'current', 'days1to30', 'days31to60', 'days61to90', 'over90'
    ])

    const csv = await asAdmin()('GET', `/reports/aging?asOf=${AS_OF.toISOString()}&format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.headers['content-disposition']).toContain('kundreskontra-2026-09-04.csv')
    expect(csv.body.startsWith('﻿')).toBe(true) // BOM, for Excel
    expect(csv.body.slice(1).split('\r\n')[0]).toBe('Kund;Antal fakturor;Äldsta förfallodatum;Ej förfallet;1–30 dagar;31–60 dagar;61–90 dagar;> 90 dagar;Totalt')
    expect(csv.body).toContain(`Rapport AB ${suffix};3;2026-07-21;`)
  })

  test('a CLIENT is refused', async () => {
    const res = await authed(app, clientToken)('GET', '/reports/aging')
    expect(res.statusCode).toBe(403)
  })
})

describe('GET /reports/vat', () => {
  test('🔑 splits net and VAT per rate over the period', async () => {
    // The three invoices were sent "now" — sentAt is the real clock.
    const from = new Date(Date.now() - 60_000)
    const to = new Date(Date.now() + 60_000)
    const before = await vatReport(new Date(from.getTime() - 1), from)
    const report = await vatReport(from, to)

    const r25 = report.rows.find((r) => r.vatRate === 2500)!
    const r6 = report.rows.find((r) => r.vatRate === 600)!
    expect(r25.netOre - (before.rows.find((r) => r.vatRate === 2500)?.netOre ?? 0)).toBeGreaterThanOrEqual(3 * 100_000)
    expect(r25.vatOre).toBe(Math.round(r25.netOre * 0.25)) // consistent per rate
    expect(r6.vatOre).toBeGreaterThan(0)
    expect(report.totals.netOre).toBe(report.rows.reduce((n, r) => n + r.netOre, 0))
    expect(report.totals.vatOre).toBe(report.rows.reduce((n, r) => n + r.vatOre, 0))
    expect(report.documentCount).toBeGreaterThanOrEqual(3)
  })

  test('a credit note reduces the period by exactly what it cancels', async () => {
    const created = await asAdmin()('POST', '/invoices', {
      clientId,
      dueDate: '2099-01-01T00:00:00.000Z',
      items: [{ description: 'Extra', quantity: 1, unitPriceOre: 40_000, vatRate: VatRate.STANDARD }]
    })
    const id = created.json().invoice.id
    await asAdmin()('POST', `/invoices/${id}/send`)

    const from = new Date(Date.now() - 60_000)
    const mid = await vatReport(from, new Date(Date.now() + 60_000))
    await asAdmin()('POST', `/invoices/${id}/credit-note`)
    const after = await vatReport(from, new Date(Date.now() + 60_000))

    const net25 = (r: typeof mid) => r.rows.find((x) => x.vatRate === 2500)?.netOre ?? 0
    const vat25 = (r: typeof mid) => r.rows.find((x) => x.vatRate === 2500)?.vatOre ?? 0
    expect(net25(mid) - net25(after)).toBe(40_000)
    expect(vat25(mid) - vat25(after)).toBe(10_000)
  })

  test('rejects an inverted or over-long period', async () => {
    const bad = await asAdmin()('GET', '/reports/vat?from=2026-04-01&to=2026-01-01')
    expect(bad.statusCode).toBe(400)
    const long = await asAdmin()('GET', '/reports/vat?from=2024-01-01&to=2026-01-01')
    expect(long.statusCode).toBe(400)
  })

  test('CSV uses semicolons and Swedish decimals', async () => {
    const res = await asAdmin()('GET', '/reports/vat?from=2026-01-01&to=2027-01-01&format=csv')
    expect(res.statusCode).toBe(200)
    const lines = res.body.replace('﻿', '').split('\r\n')
    expect(lines[0]).toBe('Momssats;Beskattningsunderlag;Utgående moms;Antal rader')
    expect(lines[1]).toMatch(/^25 %;-?\d+,\d{2};-?\d+,\d{2};\d+$/)
  })
})

describe('GET /reports/sie', () => {
  test('🔑 exports balanced verifications in CP437', async () => {
    const res = await asAdmin()('GET', '/reports/sie?year=2026')

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('fakturly-2026.se')

    const bytes = res.rawPayload
    // "Kundfordringar" is ASCII; "Påminnelseavgifter" is not — its å must
    // be the CP437 byte 0x86, not UTF-8's two bytes C3 A5.
    const text = bytes.toString('latin1')
    expect(text).toContain('#FLAGGA 0')
    expect(text).toContain('#SIETYP 4')
    expect(text).toContain('#FORMAT PC8')
    expect(text).toContain('#RAR 0 20260101 20261231')
    expect(text).toContain('#KONTO 1510 "Kundfordringar"')
    expect(bytes.includes(Buffer.from([0x50, 0x86, 0x6d]))).toBe(true) // "Påm" in CP437
    expect(bytes.includes(Buffer.from([0xc3, 0xa5]))).toBe(false) // no UTF-8 å

    // Every verification balances.
    const blocks = text.split('#VER ').slice(1)
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      const amounts = [...block.matchAll(/#TRANS \d+ \{\} (-?\d+\.\d{2})/g)].map((m) => Math.round(Number(m[1]) * 100))
      expect(amounts.length).toBeGreaterThanOrEqual(2)
      expect(amounts.reduce((a, b) => a + b, 0)).toBe(0)
    }
  })

  test('an invoice becomes 1510 against revenue and VAT per rate', async () => {
    const res = await asAdmin()('GET', '/reports/sie?year=2026')
    const text = res.rawPayload.toString('latin1')

    // One of this file's invoices: 1 100,00 net + 256,00 VAT = 1 356,00 gross.
    // SIE amounts are in kronor with a dot — the öre become a decimal here
    // and nowhere else.
    const block = text.split('#VER ').find((b) => b.includes('#TRANS 1510 {} 1356.00'))
    expect(block).toBeDefined()
    expect(block).toContain('#TRANS 3001 {} -1000.00')
    expect(block).toContain('#TRANS 2611 {} -250.00')
    expect(block).toContain('#TRANS 3003 {} -100.00')
    expect(block).toContain('#TRANS 2631 {} -6.00')
  })

  test('the export is audited', async () => {
    await asAdmin()('GET', '/reports/sie?year=2026')
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'REPORT_EXPORTED', resourceId: 'sie:2026' },
      orderBy: { createdAt: 'desc' }
    })
    expect(entry).not.toBeNull()
  })

  test('a CLIENT is refused', async () => {
    const res = await authed(app, clientToken)('GET', '/reports/sie?year=2026')
    expect(res.statusCode).toBe(403)
  })
})
