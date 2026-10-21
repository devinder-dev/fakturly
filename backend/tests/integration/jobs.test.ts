// jobs.test.ts — the queue and worker wiring itself.
//
// WHY THIS FILE EXISTS: the whole suite passed while the server could not
// boot. BullMQ rejects a colon in a queue name, at construction, at runtime —
// and our queues are created lazily, so nothing in the tests ever constructed
// one. Only a manual smoke test caught it.
//
// These tests construct the real queues and workers. They are less about
// business logic than about the class of bug that only appears when an object
// is actually built.

import { describe, test, expect, afterAll } from 'bun:test'
import { Queue, Worker } from 'bullmq'
import {
  QueueName,
  QUEUE_PREFIX,
  bullConnection,
  getOverdueQueue,
  getEmailQueue,
  closeQueues,
  defaultJobOptions
} from '../../src/jobs/queues.ts'
import { processEmailJob, startEmailWorker } from '../../src/jobs/workers/email.worker.ts'
import { redis, uniqueSuffix } from '../helpers.ts'
import type { Job } from 'bullmq'
import type { EmailJobData } from '../../src/jobs/queues.ts'

const openedWorkers: Worker[] = []

afterAll(async () => {
  await Promise.all(openedWorkers.map((worker) => worker.close()))
  await closeQueues()

  // Remove the keys these tests created, so a later run starts clean.
  const keys = await redis.keys(`${QUEUE_PREFIX}:${QueueName.OVERDUE}*`)
  const emailKeys = await redis.keys(`${QUEUE_PREFIX}:${QueueName.EMAIL}*`)
  const all = [...keys, ...emailKeys]
  if (all.length > 0) await redis.del(...all)
})

describe('queue names', () => {
  test('🔑 contain no colon — BullMQ rejects them at construction', () => {
    for (const name of Object.values(QueueName)) {
      expect(name).not.toContain(':')
    }
    // BullMQ builds its Redis keys as `prefix:queueName:...`, so a colon in
    // the name corrupts that structure. The failure is at runtime, when a
    // queue or worker is constructed — which lazy creation had hidden.
  })

  test('constructing a Queue with a colon in the name really does throw', () => {
    expect(() => new Queue('bad:name', { connection: bullConnection })).toThrow(
      /cannot contain/i
    )
    // The bug this file exists for, pinned so it cannot come back.
  })
})

describe('queues can actually be constructed', () => {
  test('the overdue queue opens', () => {
    const queue = getOverdueQueue()
    expect(queue.name).toBe(QueueName.OVERDUE)
  })

  test('the email queue opens', () => {
    const queue = getEmailQueue()
    expect(queue.name).toBe(QueueName.EMAIL)
  })

  test('both are the same instance on a second call', () => {
    expect(getOverdueQueue()).toBe(getOverdueQueue())
    expect(getEmailQueue()).toBe(getEmailQueue())
    // One connection per queue, not one per call site.
  })
})

describe('workers can actually be constructed', () => {
  test('a worker opens on the same prefix the queue writes to', async () => {
    const worker = new Worker(QueueName.EMAIL, async () => ({ ok: true }), {
      connection: bullConnection,
      prefix: QUEUE_PREFIX,
      concurrency: 1,
      // Built, never started: a running worker here would be a competing
      // consumer and steal jobs from the real-worker test below.
      autorun: false
    })
    openedWorkers.push(worker)

    expect(worker.name).toBe(QueueName.EMAIL)
    // A worker on a DIFFERENT prefix would open fine and then sit there
    // processing nothing, silently, forever.
  })
})

describe('the real email worker receives what the real email queue sends', () => {
  // The test above builds its OWN worker with the right prefix — so it stayed
  // green while startEmailWorker() itself had no prefix at all and listened on
  // BullMQ's default 'bull:' keys. Every overdue notice and reminder went into
  // 'fakturly:email:*' and was never read. This test uses the production
  // functions on both ends, so the two can never drift apart unnoticed again.
  test('🔑 a job added via getEmailQueue() is processed by startEmailWorker()', async () => {
    // Leftover jobs from other test files would otherwise be processed by
    // this worker too, and could send real emails for real test invoices.
    await getEmailQueue().drain()

    const invoiceId = `clnotarealinvoice${uniqueSuffix()}`
    const worker = startEmailWorker()
    openedWorkers.push(worker)

    // Listen BEFORE adding, so a fast worker cannot finish first.
    const completed = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('startEmailWorker() never picked up the job — prefix mismatch?')),
        10_000
      )
      worker.on('completed', (job, result) => {
        if (job.data.invoiceId !== invoiceId) return
        clearTimeout(timer)
        resolve(result)
      })
    })

    await getEmailQueue().add('prefix-regression', { kind: 'overdue-notice', invoiceId })

    // The invoice does not exist, so the job completes as "skipped" — no
    // email is sent, but it proves the job travelled queue → Redis → worker.
    expect(await completed).toEqual({ skipped: 'invoice_missing' })
  }, 15_000)
})

describe('job options', () => {
  test('retry with exponential backoff', () => {
    expect(defaultJobOptions.attempts).toBe(3)
    expect(defaultJobOptions.backoff.type).toBe('exponential')
    // A database blip resolves itself; hammering it does not.
  })

  test('failed jobs are kept far longer than completed ones', () => {
    expect(defaultJobOptions.removeOnFail.count).toBeGreaterThan(
      defaultJobOptions.removeOnComplete.count
    )
    // A failed job is evidence, and being able to see it is the whole point
    // of using a queue rather than a bare cron.
  })
})

describe('the email worker skips work that is no longer needed', () => {
  const fakeJob = (data: EmailJobData) => ({ data }) as Job<EmailJobData>

  test('an invoice deleted between enqueue and processing is skipped, not retried', async () => {
    const result = await processEmailJob(fakeJob({
      kind: 'overdue-notice',
      invoiceId: 'clnotarealinvoice0'
    }))

    expect(result).toEqual({ skipped: 'invoice_missing' })
    // Returning normally lets the job complete. Throwing would burn three
    // attempts on something that can never succeed.
  })
})
