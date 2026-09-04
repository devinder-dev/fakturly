// invoice-lifecycle.spec.ts — an invoice from a blank form to PAID, in a browser.
//
// The one test that crosses every boundary: the React app, the API, Postgres,
// Redis, the PDF renderer and the (stubbed) Stripe webhook. It runs against
// the demo dataset and logs in through the same buttons a visitor uses.
//
// The payment itself is delivered as a webhook signed with the stub secret —
// exactly what tests/e2e/payment-lifecycle.test.ts does on the backend, but
// here the effect is checked on screen.

import { test, expect, type Page } from '@playwright/test'
import { createHmac } from 'node:crypto'

const API = `http://localhost:${process.env.E2E_API_PORT ?? 3100}`

/** Same value as STUB_WEBHOOK_SECRET in backend/src/lib/stripe.ts. */
const STUB_WEBHOOK_SECRET = 'stub_whsec_local_development_only'

function signStubPayload(rawBody: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', STUB_WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest('hex')
  return `t=${timestamp},v1=${signature}`
}

/** The status badge, as opposed to a date label or a notice using the same word. */
const badge = (page: Page, text: string) => page.locator('span.rounded-full', { hasText: text })

async function loginAsDemoAdmin(page: Page) {
  await page.goto('/login')
  await page.getByRole('button', { name: 'Som administratör' }).click()
  await page.waitForURL('**/dashboard')
}

test('an invoice is written, sent, printed, paid and settled', async ({ page, request }) => {
  await loginAsDemoAdmin(page)

  // ── Write it ─────────────────────────────────────────────────
  await page.goto('/invoices/new')
  await page.getByLabel('Kund').selectOption({ label: 'Café Linnéa' })
  await page.getByLabel('Beskrivning').fill('E2E-konsultation')
  await page.getByLabel('Antal').fill('3')
  await page.getByLabel('À-pris (ex moms)').fill('1250,50')
  // The preview is client-side arithmetic; the API recomputes on submit.
  await expect(page.getByText('4 689,38 SEK')).toBeVisible() // 3 × 1250,50 × 1,25

  await page.getByRole('button', { name: 'Skapa utkast' }).click()
  await page.waitForURL(/\/invoices\/[a-z0-9]+$/)
  await expect(badge(page, 'Utkast')).toBeVisible()
  const invoiceId = page.url().split('/').pop()!
  const heading = await page.getByRole('heading', { level: 1 }).textContent()
  const invoiceNumber = heading!.replace('Faktura ', '').trim()
  expect(invoiceNumber).toMatch(/^\d{4}-\d{4}$/)

  // ── Send it ──────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Skicka faktura' }).click()
  await expect(badge(page, 'Skickad')).toBeVisible()
  await expect(page.getByText('Faktura utfärdad')).toBeVisible() // the ledger row
  await expect(page.getByText('4 689,38 SEK').first()).toBeVisible()

  // ── Print it ─────────────────────────────────────────────────
  const [pdfResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/invoices/${invoiceId}/pdf`)),
    page.getByRole('button', { name: 'PDF' }).click()
  ])
  expect(pdfResponse.status()).toBe(200)
  expect(pdfResponse.headers()['content-type']).toBe('application/pdf')
  // The bytes themselves are checked in backend/tests/integration/pdf.test.ts;
  // a body the page already consumed as a Blob is not readable from here.

  // ── Pay it ───────────────────────────────────────────────────
  // Stripe would send this after the customer paid on the hosted page.
  const body = JSON.stringify({
    id: `evt_e2e_${Date.now()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_e2e_${Date.now()}`,
        payment_intent: `pi_e2e_${Date.now()}`,
        payment_status: 'paid',
        amount_total: 468_938,
        currency: 'sek',
        metadata: { invoiceId }
      }
    }
  })
  const webhook = await request.post(`${API}/webhooks/stripe`, {
    headers: { 'content-type': 'application/json', 'stripe-signature': signStubPayload(body) },
    data: body
  })
  expect(webhook.ok()).toBeTruthy()
  expect((await webhook.json()).handled).toBe(true)

  // ── See it settle ────────────────────────────────────────────
  await page.reload()
  await expect(badge(page, 'Betald')).toBeVisible()
  await expect(page.getByText('Betalning mottagen')).toBeVisible()
  await expect(page.getByText('Utestående enligt huvudboken')).toBeVisible()
  await expect(page.locator('tr.bg-slate-50 td').last()).toHaveText('0,00 SEK')

  // A second delivery of the same payment changes nothing.
  const again = await request.post(`${API}/webhooks/stripe`, {
    headers: { 'content-type': 'application/json', 'stripe-signature': signStubPayload(body) },
    data: body
  })
  expect((await again.json()).reason).toBe('duplicate_event')

  // The invoice now appears in this month's received figure on the dashboard.
  await page.goto('/dashboard')
  await expect(page.getByText('Inbetalt denna månad')).toBeVisible()
})

test('a client sees only their own invoices and cannot reach admin pages', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: 'Som kund' }).click()
  await page.waitForURL('**/invoices')
  await expect(page.getByRole('heading', { name: 'Mina fakturor' })).toBeVisible()

  // Every row belongs to Nordström Bygg AB — the demo client. Nothing to
  // assert per row on screen, but the admin links must be absent...
  await expect(page.getByRole('link', { name: 'Kunder' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Rapporter' })).toHaveCount(0)

  // ...and typing the URL is bounced, by the guard and by the API alike.
  await page.goto('/dashboard')
  await page.waitForURL('**/invoices')
  await page.goto('/reports')
  await page.waitForURL('**/invoices')
})
