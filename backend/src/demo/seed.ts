// demo/seed.ts — builds the showcase dataset, from nothing.
//
// THIS FILE BREAKS A RULE ON PURPOSE, AND IT IS THE ONLY FILE ALLOWED TO.
//
// Everywhere else, ledger and audit rows are never deleted. Here they are
// wiped wholesale, because the demo database is not a record of anything —
// it is a stage set, rebuilt every night so that strangers can click around,
// send invoices, and break things without consequence.
//
// Three properties keep that safe:
//
//   1. It refuses to run in production unless DEMO_MODE is explicitly on.
//   2. It deletes EVERYTHING or nothing. There is no "delete this invoice"
//      entry point here that a future feature could quietly reuse.
//   3. It lives in its own folder, not in services/ or repositories/, so
//      nothing in the layered architecture can import it by accident.
//
// The data itself is produced by the REAL code paths wherever one exists:
// invoices go through invoice.service, payments through the same repository
// function the Stripe webhook uses, and overdue interest comes from running
// the actual nightly job against a date. Only the timestamps are then moved
// into the past, because a dataset where everything happened today tells no
// story on a dashboard.

import { env, isProduction } from '../lib/env.ts'
import { prisma } from '../lib/prisma.ts'
import { redis } from '../lib/redis.ts'
import { VatRate } from '../lib/money.ts'
import { hashPassword, generateTemporaryPassword } from '../services/password.service.ts'
import * as invoiceService from '../services/invoice.service.ts'
import * as invoiceRepository from '../repositories/invoice.repository.ts'
import * as clientRepository from '../repositories/client.repository.ts'
import { runOverdueCheck } from '../services/overdue.service.ts'

// ─────────────────────────────────────────────────────────────
// The accounts a visitor may log in with
// ─────────────────────────────────────────────────────────────

/**
 * Public by design. These are printed on the landing page.
 *
 * They still satisfy the real password policy (12+ characters) because the
 * login path does not know it is a demo — the same Argon2id verify and the
 * same rate limiter run. A weaker policy for demo accounts would mean a
 * special case in code that is meant to have none.
 */
export const DEMO_ACCOUNTS = {
  admin: {
    email: 'admin@demo.fakturly.se',
    password: 'demo-admin-fakturly-2026',
    label: 'Administratör'
  },
  client: {
    email: 'kund@demo.fakturly.se',
    password: 'demo-kund-fakturly-2026',
    label: 'Kund — Nordström Bygg AB'
  }
} as const

// ─────────────────────────────────────────────────────────────
// The script
// ─────────────────────────────────────────────────────────────

type DemoClient = {
  name: string
  email: string
  phone: string
  address: string
  /** Only the showcase client gets a known password; the rest are scenery. */
  password?: string
}

const CLIENTS: DemoClient[] = [
  {
    name: 'Nordström Bygg AB',
    email: DEMO_ACCOUNTS.client.email,
    password: DEMO_ACCOUNTS.client.password,
    phone: '08-123 456 78',
    address: 'Industrivägen 14, 141 45 Huddinge'
  },
  {
    name: 'Café Linnéa',
    email: 'linnea@cafe-linnea.se',
    phone: '031-98 76 54',
    address: 'Linnégatan 22, 413 04 Göteborg'
  },
  {
    name: 'Advokatbyrån Ek & Partner',
    email: 'ekonomi@ekpartner.se',
    phone: '08-555 010 20',
    address: 'Birger Jarlsgatan 6, 114 34 Stockholm'
  },
  {
    name: 'Solkraft Installationer AB',
    email: 'faktura@solkraft.se',
    phone: '040-12 34 56',
    address: 'Solgatan 3, 211 22 Malmö'
  },
  {
    name: 'Lund Design Studio',
    email: 'hej@lunddesign.se',
    phone: '046-22 33 44',
    address: 'Stora Gråbrödersgatan 9, 222 22 Lund'
  }
]

type Line = { description: string; quantity: number; unitPriceOre: number; vatRate: number }

/**
 * One invoice's life, described rather than scripted.
 *
 * `daysAgo` is when it was issued. `outcome` decides what happened next; the
 * seed turns each into the same calls a real admin and the real scheduler
 * would have made.
 */
type Scenario = {
  client: number
  daysAgo: number
  /** Payment terms. 30 is the Swedish default. */
  termsDays?: number
  items: Line[]
  outcome:
    | { kind: 'draft' }
    | { kind: 'unpaid' }
    | { kind: 'paid'; daysAfterIssue: number }
}

const kr = (kronor: number) => kronor * 100

const SCENARIOS: Scenario[] = [
  // ── Eight months of history, oldest first ───────────────────
  { client: 2, daysAgo: 235, items: [{ description: 'Juridisk rådgivning, avtal', quantity: 6, unitPriceOre: kr(2_400), vatRate: VatRate.STANDARD }], outcome: { kind: 'paid', daysAfterIssue: 18 } },
  { client: 0, daysAgo: 228, items: [{ description: 'Projektledning, etapp 1', quantity: 40, unitPriceOre: kr(950), vatRate: VatRate.STANDARD }, { description: 'Resekostnader', quantity: 1, unitPriceOre: kr(3_200), vatRate: VatRate.STANDARD }], outcome: { kind: 'paid', daysAfterIssue: 29 } },
  { client: 1, daysAgo: 210, items: [{ description: 'Catering personalfest', quantity: 45, unitPriceOre: kr(285), vatRate: VatRate.REDUCED_12 }], outcome: { kind: 'paid', daysAfterIssue: 12 } },
  { client: 3, daysAgo: 198, items: [{ description: 'Systemdesign solcellsanläggning', quantity: 1, unitPriceOre: kr(28_500), vatRate: VatRate.STANDARD }], outcome: { kind: 'paid', daysAfterIssue: 41 } },
  { client: 4, daysAgo: 184, items: [{ description: 'Grafisk profil', quantity: 1, unitPriceOre: kr(42_000), vatRate: VatRate.STANDARD }, { description: 'Tryckt broschyr', quantity: 500, unitPriceOre: kr(18), vatRate: VatRate.REDUCED_6 }], outcome: { kind: 'paid', daysAfterIssue: 25 } },
  { client: 0, daysAgo: 170, items: [{ description: 'Projektledning, etapp 2', quantity: 52, unitPriceOre: kr(950), vatRate: VatRate.STANDARD }], outcome: { kind: 'paid', daysAfterIssue: 33 } },
  { client: 2, daysAgo: 155, items: [{ description: 'Bolagsrättslig utredning', quantity: 14, unitPriceOre: kr(2_400), vatRate: VatRate.STANDARD }], outcome: { kind: 'paid', daysAfterIssue: 22 } },
  { client: 1, daysAgo: 140, items: [{ description: 'Konferenslunch', quantity: 30, unitPriceOre: kr(195), vatRate: VatRate.REDUCED_12 }, { description: 'Lokalhyra', quantity: 1, unitPriceOre: kr(4_500), vatRate: VatRate.STANDARD }], outcome: { kind: 'paid', daysAfterIssue: 9 } },
  { client: 3, daysAgo: 126, items: [{ description: 'Installation, 24 paneler', quantity: 24, unitPriceOre: kr(3_100), vatRate: VatRate.STANDARD }, { description: 'Växelriktare', quantity: 2, unitPriceOre: kr(14_900), vatRate: VatRate.STANDARD }], outcome: { kind: 'paid', daysAfterIssue: 58 } },
  { client: 4, daysAgo: 112, items: [{ description: 'Webbdesign, landningssida', quantity: 1, unitPriceOre: kr(31_000), vatRate: VatRate.STANDARD }], outcome: { kind: 'paid', daysAfterIssue: 27 } },
  { client: 0, daysAgo: 98, items: [{ description: 'Projektledning, etapp 3', quantity: 48, unitPriceOre: kr(950), vatRate: VatRate.STANDARD }], outcome: { kind: 'paid', daysAfterIssue: 30 } },
  { client: 2, daysAgo: 84, items: [{ description: 'Tvistelösning, förberedelse', quantity: 9, unitPriceOre: kr(2_600), vatRate: VatRate.STANDARD }], outcome: { kind: 'paid', daysAfterIssue: 45 } },
  { client: 1, daysAgo: 70, items: [{ description: 'Frukostleverans, kvartal', quantity: 60, unitPriceOre: kr(89), vatRate: VatRate.REDUCED_12 }], outcome: { kind: 'paid', daysAfterIssue: 14 } },
  // ── Recent: the interesting ones ────────────────────────────
  { client: 3, daysAgo: 71, items: [{ description: 'Serviceavtal, år 1', quantity: 1, unitPriceOre: kr(12_000), vatRate: VatRate.STANDARD }], outcome: { kind: 'unpaid' } },      // 41 days overdue
  { client: 4, daysAgo: 55, items: [{ description: 'Illustrationer, 12 st', quantity: 12, unitPriceOre: kr(1_800), vatRate: VatRate.STANDARD }], outcome: { kind: 'unpaid' } },  // 25 days overdue
  { client: 0, daysAgo: 42, items: [{ description: 'Projektledning, etapp 4', quantity: 36, unitPriceOre: kr(950), vatRate: VatRate.STANDARD }, { description: 'Utbildning arbetsmiljö', quantity: 1, unitPriceOre: kr(8_000), vatRate: VatRate.ZERO }], outcome: { kind: 'unpaid' } }, // 12 days overdue
  { client: 2, daysAgo: 20, items: [{ description: 'Löpande rådgivning', quantity: 4, unitPriceOre: kr(2_600), vatRate: VatRate.STANDARD }], outcome: { kind: 'unpaid' } },       // due in 10 days
  { client: 1, daysAgo: 8, items: [{ description: 'Catering styrelsemöte', quantity: 12, unitPriceOre: kr(240), vatRate: VatRate.REDUCED_12 }], outcome: { kind: 'unpaid' } },
  { client: 0, daysAgo: 3, items: [{ description: 'Slutbesiktning', quantity: 1, unitPriceOre: kr(15_000), vatRate: VatRate.STANDARD }], outcome: { kind: 'unpaid' } },
  { client: 4, daysAgo: 1, items: [{ description: 'Sociala medier, september', quantity: 1, unitPriceOre: kr(9_500), vatRate: VatRate.STANDARD }], outcome: { kind: 'draft' } }
]

export type DemoSummary = {
  users: number
  clients: number
  invoices: number
  paid: number
  overdue: number
  drafts: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Wipes the database and rebuilds the demo dataset.
 *
 * `now` is a parameter for the same reason it is in the overdue job: a seed
 * whose output depends on a hidden clock cannot be tested, and "what does the
 * dashboard look like on the 1st of a month" is a question worth answering.
 */
export async function resetDemoData(now: Date = new Date()): Promise<DemoSummary> {
  if (isProduction && !env.DEMO_MODE) {
    throw new Error(
      'Refusing to wipe a production database. Set DEMO_MODE=true if this really is the demo.'
    )
  }

  await wipeEverything()

  // ── People ───────────────────────────────────────────────────
  const admin = await prisma.user.create({
    data: {
      email: DEMO_ACCOUNTS.admin.email,
      password: await hashPassword(DEMO_ACCOUNTS.admin.password),
      role: 'ADMIN'
    },
    select: { id: true }
  })

  const clientIds: string[] = []
  for (const client of CLIENTS) {
    const created = await clientRepository.createClientWithUser({
      email: client.email,
      passwordHash: await hashPassword(client.password ?? generateTemporaryPassword()),
      name: client.name,
      phone: client.phone,
      address: client.address
    })
    clientIds.push(created.clientId)
  }

  // ── Invoices, in the order they happened ─────────────────────
  const counts = { paid: 0, overdue: 0, drafts: 0 }

  // Oldest first, so invoice numbers increase with the dates. The series
  // would be legal either way, but a dashboard where 2026-0003 predates
  // 2026-0001 raises a question nobody should have to answer.
  const ordered = [...SCENARIOS].sort((a, b) => b.daysAgo - a.daysAgo)

  for (const scenario of ordered) {
    const issuedAt = new Date(now.getTime() - scenario.daysAgo * DAY_MS)
    const dueAt = new Date(issuedAt.getTime() + (scenario.termsDays ?? 30) * DAY_MS)
    const clientId = clientIds[scenario.client]
    if (!clientId) throw new Error(`Scenario references unknown client ${scenario.client}`)

    // The real service: totals, VAT, numbering, audit row.
    const invoice = await invoiceService.createInvoice(
      { clientId, dueDate: dueAt, items: scenario.items },
      admin.id
    )

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { issueDate: issuedAt, createdAt: issuedAt }
    })

    if (scenario.outcome.kind === 'draft') {
      counts.drafts += 1
      continue
    }

    // The real send: DRAFT -> SENT plus the ledger row, then moved in time.
    await invoiceService.sendInvoice(invoice.id, admin.id)
    await prisma.invoice.update({ where: { id: invoice.id }, data: { sentAt: issuedAt } })
    await prisma.transaction.updateMany({
      where: { invoiceId: invoice.id, type: 'INVOICE_CREATED' },
      data: { createdAt: issuedAt }
    })

    if (scenario.outcome.kind === 'paid') {
      const paidAt = new Date(issuedAt.getTime() + scenario.outcome.daysAfterIssue * DAY_MS)

      // Paid after the due date? Then interest had accrued by the time the
      // money arrived. Running the real overdue job as of that day produces
      // exactly the rows the scheduler would have written.
      if (paidAt > dueAt) {
        await runOverdueCheck(paidAt)
      }

      const current = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      const paid = await invoiceRepository.markPaid(invoice.id, {
        stripePaymentId: `pi_demo_${invoice.invoiceNumber.replace('-', '')}`,
        amountOre: current.grossTotalOre + current.lateFeeOre
      })
      if (!paid) throw new Error(`Demo: could not mark ${invoice.invoiceNumber} paid`)

      await prisma.invoice.update({ where: { id: invoice.id }, data: { paidAt } })
      await prisma.transaction.updateMany({
        where: { invoiceId: invoice.id, type: 'PAYMENT_RECEIVED' },
        data: { createdAt: paidAt }
      })
      counts.paid += 1
    }
  }

  // The nightly job, as of today: everything still unpaid and past due
  // becomes OVERDUE with interest calculated to the day.
  const overdueRun = await runOverdueCheck(now)
  counts.overdue = overdueRun.results.filter((r) => r.newlyOverdue).length

  // Interest rows written just now describe accruals that "happened" over
  // the past weeks. Spread them to the due date so the ledger reads in order.
  for (const result of overdueRun.results) {
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: result.invoiceId } })
    await prisma.transaction.updateMany({
      where: { invoiceId: result.invoiceId, type: 'LATE_FEE_ADDED' },
      data: { createdAt: new Date(invoice.dueDate.getTime() + DAY_MS) }
    })
  }

  // Audit rows were written by the services with today's timestamp. Left as
  // they are: the audit log records when the seed ran, which is the truth.

  return {
    users: 1 + CLIENTS.length,
    clients: CLIENTS.length,
    invoices: SCENARIOS.length,
    ...counts
  }
}

/**
 * Deletes every row in every table, in foreign-key order.
 *
 * Also clears the Redis keys that hold login state — rate-limit counters,
 * failed-attempt counts, revoked tokens — so a demo account that a visitor
 * locked out yesterday works again this morning. BullMQ's own keys are NOT
 * touched: the queue that is running this very job lives there.
 */
async function wipeEverything(): Promise<void> {
  await prisma.$transaction([
    prisma.transaction.deleteMany(),
    prisma.invoiceItem.deleteMany(),
    prisma.emailLog.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.processedWebhookEvent.deleteMany(),
    prisma.passwordToken.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.client.deleteMany(),
    prisma.user.deleteMany(),
    prisma.invoiceNumberSeries.deleteMany()
  ])

  for (const pattern of ['fakturly:rl:*', 'fakturly:login:fail:*', 'fakturly:denylist:*']) {
    const keys = await redis.keys(pattern)
    if (keys.length > 0) await redis.del(...keys)
  }
}
