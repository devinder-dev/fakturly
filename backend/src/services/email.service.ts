// email.service.ts — composes the emails Fakturly sends, and records them.
//
// The transport lives in lib/mailer.ts. This file decides what a message says
// and makes sure the attempt is written to EmailLog either way.
//
// Every send is recorded, INCLUDING failures. A reminder we failed to send is
// precisely the thing you need to know about — "we emailed them" is a claim
// that gets made in disputes, and it should be backed by a row.

import { sendEmail } from '../lib/mailer.ts'
import { prisma } from '../lib/prisma.ts'
import { formatOre } from '../lib/money.ts'
import type { EmailType } from '../generated/prisma/client.ts'

type LoggedSend = {
  to: string
  subject: string
  text: string
  type: EmailType
  userId?: string | undefined
  invoiceId?: string | undefined
}

/**
 * Sends and records. Never throws.
 *
 * A mail server being unreachable must not roll back the operation that
 * triggered the email — provisioning a client should not fail because Resend
 * was briefly down. The client exists; the invite can be resent.
 */
async function sendAndLog(message: LoggedSend): Promise<boolean> {
  const result = await sendEmail({
    to: message.to,
    subject: message.subject,
    text: message.text
  })

  try {
    await prisma.emailLog.create({
      data: {
        recipient: message.to,
        type: message.type,
        providerMessageId: result.messageId,
        userId: message.userId ?? null,
        invoiceId: message.invoiceId ?? null
      }
    })
  } catch (error) {
    // Losing the log row is bad, but not a reason to fail the request.
    console.error('[email] failed to write EmailLog', {
      type: message.type,
      error: error instanceof Error ? error.message : String(error)
    })
  }

  if (result.error) {
    console.error('[email] send failed', { type: message.type, error: result.error })
  }

  return result.messageId !== null
}

// ─────────────────────────────────────────────────────────────

/**
 * The invite a newly provisioned client receives.
 *
 * Note what is NOT in it: a password. The account has a random one nobody
 * knows, and this link is how the client chooses their own. Emailing a
 * temporary password would put a working credential in an inbox, a mail
 * server's logs, and every backup of both — for as long as the mailbox exists.
 */
export async function sendInviteEmail(params: {
  to: string
  clientName: string
  setPasswordUrl: string
  expiresAt: Date
  userId: string
}): Promise<boolean> {
  const expires = params.expiresAt.toLocaleDateString('sv-SE')

  return sendAndLog({
    to: params.to,
    type: 'INVITE',
    userId: params.userId,
    subject: 'Välkommen till Fakturly — välj ditt lösenord',
    text: [
      `Hej ${params.clientName},`,
      '',
      'Ett konto har skapats åt dig i Fakturly, där du kan se dina fakturor',
      'och betalningsstatus.',
      '',
      'Välj ditt lösenord här:',
      params.setPasswordUrl,
      '',
      `Länken fungerar till och med ${expires} och kan bara användas en gång.`,
      '',
      'Om du inte väntade dig det här mejlet kan du ignorera det.',
      '',
      'Vänliga hälsningar,',
      'Fakturly'
    ].join('\n')
  })
}

/** Password reset, for a user who asked for one. */
export async function sendPasswordResetEmail(params: {
  to: string
  setPasswordUrl: string
  expiresAt: Date
  userId: string
}): Promise<boolean> {
  const expires = params.expiresAt.toLocaleString('sv-SE')

  return sendAndLog({
    to: params.to,
    type: 'PASSWORD_RESET',
    userId: params.userId,
    subject: 'Återställ ditt lösenord',
    text: [
      'Hej,',
      '',
      'Du har begärt att återställa ditt lösenord. Välj ett nytt här:',
      params.setPasswordUrl,
      '',
      `Länken gäller till ${expires} och kan bara användas en gång.`,
      '',
      'Har du inte begärt detta behöver du inte göra något — ditt nuvarande',
      'lösenord fortsätter att gälla.',
      '',
      'Vänliga hälsningar,',
      'Fakturly'
    ].join('\n')
  })
}

/**
 * A gentle nudge before or around the due date.
 *
 * Deliberately does not mention consequences. This is the "you may have
 * missed this" email, and treating a customer as delinquent before they
 * actually are is how you lose one.
 */
export async function sendReminderEmail(params: {
  to: string
  clientName: string
  invoiceNumber: string
  amountOre: number
  currency: string
  dueDate: Date
  invoiceId: string
}): Promise<boolean> {
  return sendAndLog({
    to: params.to,
    type: 'REMINDER',
    invoiceId: params.invoiceId,
    subject: `Påminnelse: faktura ${params.invoiceNumber}`,
    text: [
      `Hej ${params.clientName},`,
      '',
      `En vänlig påminnelse om faktura ${params.invoiceNumber}.`,
      '',
      `Belopp: ${formatOre(params.amountOre, params.currency)}`,
      `Förfallodatum: ${params.dueDate.toLocaleDateString('sv-SE')}`,
      '',
      'Har du redan betalat kan du bortse från det här mejlet.',
      '',
      'Vänliga hälsningar,',
      'Fakturly'
    ].join('\n')
  })
}

/**
 * Sent once, when an invoice first becomes overdue.
 *
 * States the interest explicitly rather than just the new total. A customer
 * who sees a number that changed without explanation disputes it; one who can
 * read where it came from usually pays it.
 */
export async function sendOverdueNoticeEmail(params: {
  to: string
  clientName: string
  invoiceNumber: string
  amountOre: number
  lateFeeOre: number
  currency: string
  dueDate: Date
  invoiceId: string
}): Promise<boolean> {
  return sendAndLog({
    to: params.to,
    type: 'OVERDUE_NOTICE',
    invoiceId: params.invoiceId,
    subject: `Förfallen faktura ${params.invoiceNumber}`,
    text: [
      `Hej ${params.clientName},`,
      '',
      `Faktura ${params.invoiceNumber} förföll ${params.dueDate.toLocaleDateString('sv-SE')}`,
      'och är ännu inte betald.',
      '',
      `Att betala: ${formatOre(params.amountOre, params.currency)}`,
      ...(params.lateFeeOre > 0
        ? [`varav dröjsmålsränta: ${formatOre(params.lateFeeOre, params.currency)}`]
        : []),
      '',
      'Dröjsmålsränta utgår enligt räntelagen med referensräntan plus åtta',
      'procentenheter och löper per dag tills betalning sker.',
      '',
      'Har du redan betalat, eller stämmer något inte, hör gärna av dig.',
      '',
      'Vänliga hälsningar,',
      'Fakturly'
    ].join('\n')
  })
}

/**
 * Confirms a payment we received.
 *
 * Sent from the webhook handler, so it fires when the money actually arrives
 * rather than when the client clicks "pay" — those are different moments, and
 * only the second one is true.
 */
export async function sendPaymentConfirmationEmail(params: {
  to: string
  clientName: string
  invoiceNumber: string
  amountOre: number
  currency: string
  invoiceId: string
}): Promise<boolean> {
  return sendAndLog({
    to: params.to,
    type: 'PAYMENT_CONFIRMED',
    invoiceId: params.invoiceId,
    subject: `Betalning mottagen — faktura ${params.invoiceNumber}`,
    text: [
      `Hej ${params.clientName},`,
      '',
      `Tack! Vi har tagit emot din betalning för faktura ${params.invoiceNumber}.`,
      '',
      `Belopp: ${formatOre(params.amountOre, params.currency)}`,
      '',
      'Fakturan är nu markerad som betald. Du behöver inte göra något mer.',
      '',
      'Vänliga hälsningar,',
      'Fakturly'
    ].join('\n')
  })
}

/** Sent when an invoice is issued. */
export async function sendInvoiceEmail(params: {
  to: string
  clientName: string
  invoiceNumber: string
  grossTotalOre: number
  currency: string
  dueDate: Date
  invoiceId: string
}): Promise<boolean> {
  return sendAndLog({
    to: params.to,
    type: 'INVOICE_SENT',
    invoiceId: params.invoiceId,
    subject: `Faktura ${params.invoiceNumber} från Fakturly`,
    text: [
      `Hej ${params.clientName},`,
      '',
      `Här kommer faktura ${params.invoiceNumber}.`,
      '',
      `Att betala: ${formatOre(params.grossTotalOre, params.currency)}`,
      `Förfallodatum: ${params.dueDate.toLocaleDateString('sv-SE')}`,
      '',
      'Du kan se fakturan när du loggar in i Fakturly.',
      '',
      'Vänliga hälsningar,',
      'Fakturly'
    ].join('\n')
  })
}
