// demoReset.worker.ts — rebuilds the demo dataset. Demo mode only.
//
// Constructed only when DEMO_MODE is on (see scheduler.ts). The worker is a
// thin shell around src/demo/seed.ts, which owns the wipe-and-reseed and the
// production guard.

import { Worker, type Job } from 'bullmq'
import { resetDemoData } from '../../demo/seed.ts'
import { QueueName, bullConnection, QUEUE_PREFIX, type DemoResetJobData } from '../queues.ts'

export async function processDemoResetJob(job: Job<DemoResetJobData>) {
  const summary = await resetDemoData(new Date(job.data.runAt))
  return summary
}

export function startDemoResetWorker(): Worker<DemoResetJobData> {
  const worker = new Worker<DemoResetJobData>(QueueName.DEMO_RESET, processDemoResetJob, {
    connection: bullConnection,
    prefix: QUEUE_PREFIX,
    // Two resets at once would each delete the other's half-built rows.
    concurrency: 1
  })

  worker.on('failed', (job, error) => {
    console.error('[demo-reset] job failed', { jobId: job?.id, error: error.message })
  })

  worker.on('completed', (job, result) => {
    console.log('[demo-reset] job completed', { jobId: job.id, ...result })
  })

  return worker
}
