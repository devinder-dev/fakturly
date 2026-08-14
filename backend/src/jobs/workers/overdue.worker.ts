// overdue.worker.ts — processes the daily overdue check.
//
// The worker is a thin shell: it unwraps the job, calls the service, and
// enqueues follow-up work. All the business logic lives in
// services/overdue.service.ts, which knows nothing about queues and can be
// tested by calling it directly.

import { Worker, type Job } from 'bullmq'
import { runOverdueCheck } from '../../services/overdue.service.ts'
import {
  QueueName,
  bullConnection,
  getEmailQueue,
  type OverdueJobData
} from '../queues.ts'

export async function processOverdueJob(job: Job<OverdueJobData>) {
  const runAt = new Date(job.data.runAt)
  const summary = await runOverdueCheck(runAt)

  // Notify only invoices that JUST became overdue. Without this the customer
  // would receive an identical email every single day the invoice stays
  // unpaid, which is how a reminder system becomes a spam filter entry.
  const emailQueue = getEmailQueue()

  for (const result of summary.results) {
    if (result.newlyOverdue) {
      await emailQueue.add('overdue-notice', {
        kind: 'overdue-notice',
        invoiceId: result.invoiceId
      })
    }
  }

  return {
    checked: summary.checked,
    markedOverdue: summary.markedOverdue,
    interestAccruedOre: summary.interestAccruedOre
  }
}

/**
 * Starts the worker.
 *
 * `concurrency: 1` on purpose. Two overdue runs at once would both read the
 * same invoice's lateFeeOre before either wrote, and the increment would be
 * calculated twice from the same starting point — charging the customer
 * double. The service guards against this with a status condition in the
 * WHERE clause, but a job that must not run twice in parallel should also
 * simply not be run twice in parallel.
 */
export function startOverdueWorker(): Worker<OverdueJobData> {
  const worker = new Worker<OverdueJobData>(QueueName.OVERDUE, processOverdueJob, {
    connection: bullConnection,
    concurrency: 1
  })

  worker.on('failed', (job, error) => {
    // After all attempts are exhausted. This is the line that must reach an
    // alert in production: late fees silently not being applied is a revenue
    // problem nobody notices for a month.
    console.error('[overdue] job failed', { jobId: job?.id, error: error.message })
  })

  worker.on('completed', (job, result) => {
    console.log('[overdue] job completed', { jobId: job.id, ...result })
  })

  return worker
}
