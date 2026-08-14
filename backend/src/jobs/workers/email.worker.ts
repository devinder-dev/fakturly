// email.worker.ts — sends the emails the system generates itself.
//
// Separate from the overdue worker on purpose. Email is slow and depends on a
// third party; the overdue calculation is fast and depends only on us. Mixing
// them would mean a mail outage stops late fees being applied.

import { Worker, type Job } from 'bullmq'
import { prisma } from '../../lib/prisma.ts'
import { sendOverdueNoticeEmail, sendReminderEmail } from '../../services/email.service.ts'
import { QueueName, bullConnection, type EmailJobData } from '../queues.ts'

export async function processEmailJob(job: Job<EmailJobData>) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: job.data.invoiceId },
    select: {
      id: true,
      invoiceNumber: true,
      status: true,
      grossTotalOre: true,
      lateFeeOre: true,
      currency: true,
      dueDate: true,
      client: { select: { name: true, email: true } }
    }
  })

  if (!invoice) {
    // The invoice was deleted between enqueueing and processing. Nothing to
    // do, and nothing to retry — returning normally lets the job complete
    // rather than burning three attempts on something that cannot succeed.
    return { skipped: 'invoice_missing' }
  }

  // Re-check the status at SEND time, not at enqueue time. A customer who
  // paid in the minutes between the two must not receive a demand for money
  // they have already sent — which is the kind of mistake that costs trust
  // rather than money.
  if (invoice.status === 'PAID') {
    return { skipped: 'already_paid' }
  }

  const common = {
    to: invoice.client.email,
    clientName: invoice.client.name,
    invoiceNumber: invoice.invoiceNumber,
    amountOre: invoice.grossTotalOre + invoice.lateFeeOre,
    currency: invoice.currency,
    dueDate: invoice.dueDate,
    invoiceId: invoice.id
  }

  const sent =
    job.data.kind === 'overdue-notice'
      ? await sendOverdueNoticeEmail({ ...common, lateFeeOre: invoice.lateFeeOre })
      : await sendReminderEmail(common)

  // Throwing on failure is what makes BullMQ retry. The email service already
  // recorded the attempt in EmailLog, so a retry adds a second row — which is
  // correct: two attempts really were made.
  if (!sent) {
    throw new Error(`Failed to send ${job.data.kind} for invoice ${invoice.invoiceNumber}`)
  }

  return { sent: job.data.kind, invoiceNumber: invoice.invoiceNumber }
}

export function startEmailWorker(): Worker<EmailJobData> {
  const worker = new Worker<EmailJobData>(QueueName.EMAIL, processEmailJob, {
    connection: bullConnection,
    // Higher than the overdue worker: sending is IO-bound and independent per
    // invoice, so several at once is fine. Still bounded, because a provider
    // will rate-limit us long before our own machine struggles.
    concurrency: 5
  })

  worker.on('failed', (job, error) => {
    console.error('[email] job failed', { jobId: job?.id, error: error.message })
  })

  return worker
}
