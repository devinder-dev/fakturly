// webhooks.routes.ts — inbound events from Stripe.
//
// This route is unlike every other one in the codebase, in three ways worth
// understanding before changing anything here.

import type { FastifyInstance } from 'fastify'
import { verifyWebhookSignature, WebhookSignatureError } from '../lib/stripe.ts'
import { handleStripeEvent } from '../services/payment.service.ts'

export default async function webhookRoutes(app: FastifyInstance) {
  /**
   * 1. IT NEEDS THE RAW BODY.
   *
   * Stripe signs the exact bytes it sent. Fastify's default JSON parser turns
   * the body into an object, and re-serialising it changes key order and
   * whitespace — so the signature fails, for reasons that look like a Stripe
   * bug rather than our own parser.
   *
   * addContentTypeParser here keeps the body as a string. It is scoped to
   * this plugin, so every other route keeps normal JSON parsing.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, body)
    }
  )

  /**
   * 2. IT IS UNAUTHENTICATED, AND THAT IS FINE.
   *
   * Stripe cannot hold one of our tokens. The signature IS the authentication:
   * only someone who knows the webhook secret can produce a valid one. Without
   * that check, "invoice 2026-0001 is paid" would be a message anyone on the
   * internet could send us.
   *
   * 3. IT ALMOST ALWAYS RETURNS 200.
   *
   * Stripe retries on any non-2xx, for days. So a 500 for something we are
   * never going to handle — an event type we do not care about, an invoice
   * that no longer exists — means being retried forever over nothing.
   *
   * We return 200 for "received and dealt with, including by deciding to
   * ignore it", and a non-2xx only for a bad signature (400, and it should
   * never retry) or a genuine failure on our side (500, where a retry is
   * exactly what we want).
   */
  app.post('/webhooks/stripe', async (request, reply) => {
    const signature = request.headers['stripe-signature']

    if (typeof signature !== 'string') {
      return reply.code(400).send({ error: 'Missing stripe-signature header' })
    }

    // parseAs: 'string' above means this really is the raw body.
    const rawBody = typeof request.body === 'string' ? request.body : ''

    let event
    try {
      event = verifyWebhookSignature(rawBody, signature)
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        // 400, not 500: the request is malformed and retrying it will not
        // help. A burst of these means someone is probing the endpoint, or
        // our secret is out of date.
        app.log.warn({ err: error }, 'Rejected webhook with invalid signature')
        return reply.code(400).send({ error: 'Invalid signature' })
      }
      throw error
    }

    try {
      const outcome = await handleStripeEvent(event)

      // 200 either way. `handled: false` covers duplicates and event types we
      // ignore — both are correct outcomes, not failures.
      return reply.code(200).send({
        received: true,
        ...(outcome.handled ? { handled: true } : { handled: false, reason: outcome.reason })
      })
    } catch (error) {
      // A real failure on our side: the database was down, something threw.
      // 500 so Stripe retries — this is the one case where we want that.
      app.log.error({ err: error, eventId: event.id }, 'Webhook processing failed')
      return reply.code(500).send({ error: 'Processing failed' })
    }
  })
}
