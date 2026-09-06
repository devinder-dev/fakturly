// stripe.ts — the Stripe boundary. Everything that talks to Stripe goes here.
//
// Two implementations behind one interface, exactly like the mailer:
//
//   Real  — used when STRIPE_SECRET_KEY is set
//   Stub  — used when it is not
//
// The stub is not a mock in the testing sense. It behaves like Stripe from
// our side: it returns a session with an id and a URL, and it verifies
// signatures using the same HMAC scheme. That means the whole payment flow —
// creating a session, receiving a webhook, checking the signature, applying
// the payment — runs and is tested without an account.
//
// The point of keeping the seam here is that swapping in real keys later is a
// configuration change, not a rewrite. Nothing above this file knows which
// mode it is in.
//
// PRODUCTION SAFETY: lib/env.ts refuses to boot in production without the
// real keys. Stub mode is a development convenience and can never ship.

import Stripe from 'stripe'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env, isProduction } from './env.ts'

const stripeClient = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY, {
      // Pinning the API version matters: Stripe evolves its API, and an
      // unpinned client silently changes behaviour the day they ship a new
      // one. For payments, a silent behaviour change is the worst kind.
      //
      // This must match the version the installed SDK was built against —
      // TypeScript enforces it, which is a genuinely good constraint: the
      // pin and the library cannot drift apart without a compile error.
      // Bumping the SDK will fail the build here until this is updated
      // deliberately, which is exactly when to re-read Stripe's changelog.
      apiVersion: '2026-07-29.dahlia',
      // Attach our own retry policy rather than failing on a blip.
      maxNetworkRetries: 2
    })
  : null

export function isStripeConfigured(): boolean {
  return stripeClient !== null
}

/** What we need back from a checkout session, in our own terms. */
export type CheckoutSession = {
  /** Stripe's session id, stored on the invoice. */
  id: string
  /** The hosted page we send the client to. */
  url: string
}

export type CreateCheckoutParams = {
  invoiceId: string
  invoiceNumber: string
  /** Total in öre, VAT included — what the client actually pays. */
  amountOre: number
  currency: string
  clientEmail: string
  successUrl: string
  cancelUrl: string
}

/**
 * Creates a hosted payment page for one invoice.
 *
 * Two details that matter:
 *
 * `metadata.invoiceId` is how the webhook knows what was paid. Without it we
 * would have to match on amount, which breaks the moment two invoices happen
 * to be for the same sum.
 *
 * The amount is sent in öre, which is what Stripe expects for SEK — its
 * `unit_amount` is always the smallest currency unit. Our internal
 * representation and Stripe's happen to agree, so no conversion happens
 * anywhere, and no rounding can creep in.
 */
export async function createCheckoutSession(
  params: CreateCheckoutParams
): Promise<CheckoutSession> {
  if (!stripeClient) {
    return createStubCheckoutSession(params)
  }

  const session = await stripeClient.checkout.sessions.create({
    mode: 'payment',
    customer_email: params.clientEmail,
    line_items: [
      {
        price_data: {
          currency: params.currency.toLowerCase(),
          unit_amount: params.amountOre,
          product_data: { name: `Faktura ${params.invoiceNumber}` }
        },
        quantity: 1
      }
    ],
    // Read back by the webhook. This is the link between their world and ours.
    metadata: {
      invoiceId: params.invoiceId,
      invoiceNumber: params.invoiceNumber
    },
    success_url: params.successUrl,
    cancel_url: params.cancelUrl
  })

  if (!session.url) {
    throw new Error('Stripe returned a session without a URL')
  }

  return { id: session.id, url: session.url }
}

// ─────────────────────────────────────────────────────────────
// Webhook verification
// ─────────────────────────────────────────────────────────────

/** The parts of a Stripe event our code actually uses. */
export type StripeEvent = {
  id: string
  type: string
  data: {
    object: {
      id: string
      metadata?: Record<string, string> | undefined
      amount_total?: number | undefined
      currency?: string | undefined
      payment_intent?: string | undefined
      payment_status?: string | undefined
    }
  }
}

export class WebhookSignatureError extends Error {}

/**
 * Verifies a webhook signature and parses the event.
 *
 * THE RAW BODY IS REQUIRED. The signature covers the exact bytes Stripe sent;
 * parsing to JSON and re-serialising changes key order and whitespace, and
 * the signature then fails for reasons that look like a Stripe bug. This is
 * why the webhook route registers its own content-type parser.
 *
 * WHY VERIFY AT ALL: the endpoint is public and anyone can POST to it. Without
 * a signature check, "invoice 2026-0001 is paid" is a message anyone on the
 * internet can send us.
 */
export async function verifyWebhookSignature(rawBody: string, signature: string): Promise<StripeEvent> {
  if (stripeClient && env.STRIPE_WEBHOOK_SECRET) {
    return verifyWithStripe(stripeClient, rawBody, signature, env.STRIPE_WEBHOOK_SECRET)
  }

  // Stub mode. env.ts guarantees this branch is unreachable in production.
  if (isProduction) {
    throw new WebhookSignatureError('Stripe is not configured')
  }

  return verifyStubSignature(rawBody, signature)
}

/**
 * The real verification, through Stripe's SDK.
 *
 * MUST be the async variant. Under Bun the SDK picks a WebCrypto-based
 * provider whose HMAC is async-only, and the synchronous `constructEvent`
 * throws "SubtleCryptoProvider cannot be used in a synchronous context"
 * BEFORE it compares anything. Our catch block then reported every genuine
 * Stripe delivery as "Invalid signature" — which is exactly what the first
 * production deploy did, for an hour, while the secret was correct all
 * along. Node's default provider is synchronous, so nothing ever showed it.
 *
 * Takes the client as an argument so a test can run this path with a dummy
 * key and a header the SDK itself signed. The stub path is exercised by the
 * rest of the suite; this one needs the real SDK.
 */
export async function verifyWithStripe(
  client: Stripe,
  rawBody: string,
  signature: string,
  secret: string
): Promise<StripeEvent> {
  try {
    const event = await client.webhooks.constructEventAsync(rawBody, signature, secret)
    return event as unknown as StripeEvent
  } catch (error) {
    throw new WebhookSignatureError(error instanceof Error ? error.message : 'Invalid signature')
  }
}

// ─────────────────────────────────────────────────────────────
// Stub implementation
// ─────────────────────────────────────────────────────────────
//
// Deliberately not "accept anything". The stub still signs and verifies with
// HMAC-SHA256, so the verification path is exercised by tests rather than
// skipped — including the case where a signature is wrong. A stub that waves
// everything through would leave the single most important check in the
// payment flow untested until production.

/** The shared secret used in stub mode. Fixed, so tests can sign with it. */
export const STUB_WEBHOOK_SECRET = 'stub_whsec_local_development_only'

function createStubCheckoutSession(params: CreateCheckoutParams): CheckoutSession {
  const id = `cs_stub_${randomBytes(12).toString('hex')}`

  if (!isProduction) {
    console.log(
      [
        '',
        '┌─ STRIPE (stub — no STRIPE_SECRET_KEY) ──────────────────────',
        `│ Invoice:  ${params.invoiceNumber}`,
        `│ Amount:   ${params.amountOre} öre ${params.currency}`,
        `│ Session:  ${id}`,
        '└─────────────────────────────────────────────────────────────',
        ''
      ].join('\n')
    )
  }

  return {
    id,
    // A URL that clearly is not Stripe, so nobody mistakes it for a real one.
    url: `${env.FRONTEND_URL}/stub-checkout?session=${id}&invoice=${params.invoiceId}`
  }
}

/** Signs a payload the way Stripe does. Used by tests and the stub. */
export function signStubPayload(rawBody: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', STUB_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')

  return `t=${timestamp},v1=${signature}`
}

function verifyStubSignature(rawBody: string, header: string): StripeEvent {
  const parts = new Map(
    header.split(',').map((part) => {
      const [key, value] = part.split('=')
      return [key ?? '', value ?? '']
    })
  )

  const timestamp = parts.get('t')
  const provided = parts.get('v1')

  if (!timestamp || !provided) {
    throw new WebhookSignatureError('Malformed signature header')
  }

  const expected = createHmac('sha256', STUB_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')

  const providedBuffer = Buffer.from(provided, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')

  // Constant-time comparison. A byte-by-byte === leaks how much of the
  // signature was correct through timing, which is enough to forge one.
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new WebhookSignatureError('Signature mismatch')
  }

  try {
    return JSON.parse(rawBody) as StripeEvent
  } catch {
    throw new WebhookSignatureError('Body is not valid JSON')
  }
}
