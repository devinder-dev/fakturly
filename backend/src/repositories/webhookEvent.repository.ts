// webhookEvent.repository.ts — records which webhook deliveries we handled.

import { prisma } from '../lib/prisma.ts'
import { Prisma } from '../generated/prisma/client.ts'
import type { PrismaClient } from '../generated/prisma/client.ts'

/** Either the global client or a transaction's client. */
export type DbClient = PrismaClient | Prisma.TransactionClient

/**
 * Claims an event id. Returns false if it was already handled.
 *
 * The whole check is a single INSERT. If the id already exists, Postgres
 * raises a unique violation and we know this delivery is a repeat — and that
 * answer is ATOMIC.
 *
 * A SELECT-then-INSERT would not be. Stripe retries aggressively, so two
 * deliveries of the same event genuinely can arrive at once; both would find
 * no row, both would proceed, and the invoice would be paid twice. This is
 * the same lost-update race as invoice numbering, with money attached.
 *
 * Claiming happens BEFORE the work, not after. If we processed first and
 * recorded afterwards, a crash in between would leave the event unrecorded
 * and the retry would apply it a second time.
 */
export async function claimEvent(
  eventId: string,
  type: string,
  provider = 'stripe',
  db: DbClient = prisma
): Promise<boolean> {
  try {
    await db.processedWebhookEvent.create({
      data: { id: eventId, type, provider }
    })
    return true
  } catch (error) {
    // P2002 = unique constraint violated = we have seen this event.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return false
    }
    throw error
  }
}

/**
 * Claims the event and applies the work in ONE transaction.
 *
 * Claiming before working stops a duplicate delivery. But a claim that
 * COMMITS before the work does is its own trap: if the work then fails — a
 * database blip, a pool exhausted, a cold start — the retry finds the claim,
 * says "duplicate", and the payment is never applied. The customer paid and
 * the invoice keeps accruing interest.
 *
 * Inside one transaction both properties hold: a concurrent duplicate still
 * hits the unique constraint, and a failure after the claim rolls the claim
 * back so Stripe's retry does the work.
 */
export async function claimEventAndRun<T>(
  eventId: string,
  type: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<{ claimed: false } | { claimed: true; result: T }> {
  return prisma.$transaction(async (tx) => {
    const claimed = await claimEvent(eventId, type, 'stripe', tx)
    if (!claimed) return { claimed: false as const }
    return { claimed: true as const, result: await work(tx) }
  })
}

export async function hasProcessed(eventId: string): Promise<boolean> {
  const row = await prisma.processedWebhookEvent.findUnique({
    where: { id: eventId },
    select: { id: true }
  })
  return row !== null
}
