// scheduler.ts — decides WHEN work is enqueued. Never does the work itself.
//
// The split matters. cron's only job is to put a message on a queue; if the
// process dies mid-tick, nothing is lost because nothing was being done here.
// BullMQ owns execution and guarantees it eventually happens.

import cron, { type ScheduledTask } from 'node-cron'
import { getOverdueQueue } from './queues.ts'
import { startOverdueWorker } from './workers/overdue.worker.ts'
import { startEmailWorker } from './workers/email.worker.ts'
import type { Worker } from 'bullmq'

/**
 * 02:00 every day, Stockholm time.
 *
 * Not midnight: around a DST change, 02:00–03:00 either happens twice or not
 * at all in many zones, and midnight sits close enough to date-rollover
 * effects to be worth avoiding. 02:00 with an explicit timezone is a quiet
 * hour that behaves predictably.
 *
 * The date matters here — interest is calculated in whole days from the due
 * date, so a run that lands on the wrong side of midnight charges a day too
 * many or too few.
 */
const OVERDUE_CRON = '0 2 * * *'
const TIMEZONE = 'Europe/Stockholm'

export type BackgroundJobs = {
  workers: Worker[]
  tasks: ScheduledTask[]
}

/**
 * Starts the workers and the schedule.
 *
 * Returns handles so the server can shut them down cleanly. A worker killed
 * mid-job leaves that job locked until its timeout expires; closing properly
 * returns it to the queue immediately.
 */
export function startBackgroundJobs(): BackgroundJobs {
  const workers = [startOverdueWorker(), startEmailWorker()]

  const overdueTask = cron.schedule(
    OVERDUE_CRON,
    () => {
      // Enqueue and return. Anything slow or failure-prone belongs in the
      // worker, where it gets retries and a record.
      void getOverdueQueue()
        .add('daily-overdue-check', { runAt: new Date().toISOString() })
        .catch((error: unknown) => {
          console.error('[scheduler] failed to enqueue overdue check', {
            error: error instanceof Error ? error.message : String(error)
          })
        })
    },
    { timezone: TIMEZONE }
  )

  console.log(`[scheduler] overdue check scheduled: ${OVERDUE_CRON} (${TIMEZONE})`)

  return { workers, tasks: [overdueTask] }
}

export async function stopBackgroundJobs(jobs: BackgroundJobs): Promise<void> {
  for (const task of jobs.tasks) {
    await task.stop()
  }
  // Waits for in-flight jobs rather than killing them mid-write.
  await Promise.all(jobs.workers.map((worker) => worker.close()))
}
