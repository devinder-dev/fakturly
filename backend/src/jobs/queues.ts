// queues.ts — BullMQ queue definitions and their Redis connection.
//
// WHY BULLMQ AND NOT JUST node-cron:
//
//   node-cron alone      a job that throws is gone. No retry, no record, no
//                        way to know it failed. For "add late fees to every
//                        overdue invoice", silently not running is a business
//                        problem nobody notices for a month.
//
//   node-cron + BullMQ   cron only ENQUEUES. BullMQ owns execution: retries
//                        with backoff, a record of every attempt, and jobs
//                        that survive a restart because they live in Redis.
//
// The division is deliberate: cron decides WHEN, BullMQ decides WHAT HAPPENS
// and guarantees it eventually does.

import { Queue, type ConnectionOptions } from 'bullmq'
import { env } from '../lib/env.ts'

/**
 * BullMQ gets its OWN Redis connection, not the shared app one.
 *
 * Two reasons, both of which bite in production:
 *
 * 1. Workers BLOCK. BullMQ uses blocking commands (BRPOPLPUSH) to wait for
 *    jobs, which occupy the connection entirely. Sharing would stall every
 *    rate-limit check and denylist lookup behind an idle worker.
 *
 * 2. BullMQ requires maxRetriesPerRequest: null. Our app connection sets it
 *    to 3, because a request should fail fast rather than hang. A worker has
 *    the opposite need — it should wait through a blip rather than drop a job.
 *
 * This was flagged in lib/redis.ts back in week 1 and is now the payoff.
 */
export const bullConnection: ConnectionOptions = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null
}

/**
 * Queue names, in one place so a typo cannot silently create a second queue.
 *
 * NO COLONS. BullMQ rejects them at construction — it builds its own Redis
 * keys as `prefix:queueName:...`, so a colon in the name would corrupt that
 * structure. Namespacing goes in `prefix` below instead.
 *
 * Worth knowing because the failure is at RUNTIME, not compile time, and only
 * when a worker or queue is actually constructed. Our queues are created
 * lazily, so the whole test suite passed while the server could not boot.
 */
export const QueueName = {
  OVERDUE: 'overdue',
  EMAIL: 'email'
} as const

/**
 * Keeps BullMQ's keys under one namespace in Redis, alongside
 * `fakturly:rl:*`, `fakturly:denylist:*` and the rest.
 */
export const QUEUE_PREFIX = 'fakturly'

export type OverdueJobData = {
  /** ISO date. Passed in so a run can be replayed for a specific day. */
  runAt: string
}

export type EmailJobData =
  | { kind: 'overdue-notice'; invoiceId: string }
  | { kind: 'payment-reminder'; invoiceId: string }

/**
 * Shared job options.
 *
 * `attempts: 3` with exponential backoff: a failed job waits 5s, then 10s,
 * then 20s. A database blip resolves itself; hammering it does not.
 *
 * `removeOnComplete` keeps the last 100 rather than everything, so Redis does
 * not grow without bound. `removeOnFail` keeps far more, because a failed job
 * is evidence and the whole point of using a queue is being able to see it.
 */
export const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 1_000 }
}

let overdueQueue: Queue<OverdueJobData> | null = null
let emailQueue: Queue<EmailJobData> | null = null

/**
 * Queues are created lazily.
 *
 * Creating one opens a Redis connection immediately, and the test suite
 * imports these modules without ever running a worker. Lazy creation means
 * tests that never enqueue anything never open a connection to leak.
 */
export function getOverdueQueue(): Queue<OverdueJobData> {
  overdueQueue ??= new Queue<OverdueJobData>(QueueName.OVERDUE, {
    connection: bullConnection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions
  })
  return overdueQueue
}

export function getEmailQueue(): Queue<EmailJobData> {
  emailQueue ??= new Queue<EmailJobData>(QueueName.EMAIL, {
    connection: bullConnection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions
  })
  return emailQueue
}

/** Closes any queue that was opened. Called on shutdown and after tests. */
export async function closeQueues(): Promise<void> {
  await Promise.all([overdueQueue?.close(), emailQueue?.close()])
  overdueQueue = null
  emailQueue = null
}
