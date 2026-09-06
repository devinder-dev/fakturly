// stripe-signature.test.ts — the REAL Stripe SDK verifies a header it signed.
//
// Every other payment test goes through the stub. This one exists because of
// ADR 48: under Bun the SDK's synchronous constructEvent throws before it
// compares anything, and only the real library could show that.

import { describe, test, expect } from 'bun:test'
import Stripe from 'stripe'
import { verifyWithStripe } from '../../src/lib/stripe.ts'
import { WebhookSignatureError } from '../../src/lib/stripe.ts'

const client = new Stripe('sk_test_dummy_key_for_signature_tests')
const SECRET = 'whsec_test_secret_for_unit_tests'

const payload = JSON.stringify({
  id: 'evt_unit',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_unit', payment_status: 'paid', amount_total: 100, metadata: { invoiceId: 'x' } } }
})

describe('verifyWithStripe', () => {
  test('🔑 accepts a header the SDK signed with the same secret', async () => {
    const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: SECRET })
    const event = await verifyWithStripe(client, payload, header, SECRET)
    expect(event.id).toBe('evt_unit')
    expect(event.data.object.metadata?.invoiceId).toBe('x')
  })

  test('rejects a header signed with a different secret', async () => {
    const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: 'whsec_other' })
    await expect(verifyWithStripe(client, payload, header, SECRET)).rejects.toBeInstanceOf(WebhookSignatureError)
  })

  test('rejects a body altered after signing', async () => {
    const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: SECRET })
    await expect(verifyWithStripe(client, payload.replace('100', '999'), header, SECRET)).rejects.toBeInstanceOf(WebhookSignatureError)
  })

  test('the synchronous SDK call really does throw under Bun — the bug this file pins', async () => {
    const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: SECRET })
    expect(() => client.webhooks.constructEvent(payload, header, SECRET)).toThrow(/synchronous/)
  })
})
