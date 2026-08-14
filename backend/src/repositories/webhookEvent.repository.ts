// webhookEvent.repository.ts — records which webhook deliveries we handled.

import { prisma } from '../lib/prisma.ts'
import { Prisma } from '../generated/prisma/client.ts'

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
  provider = 'stripe'
): Promise<boolean> {
  try {
    await prisma.processedWebhookEvent.create({
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

export async function hasProcessed(eventId: string): Promise<boolean> {
  const row = await prisma.processedWebhookEvent.findUnique({
    where: { id: eventId },
    select: { id: true }
  })
  return row !== null
}
