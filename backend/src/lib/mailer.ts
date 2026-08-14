// mailer.ts — the transport layer for email. Knows nothing about invoices.
//
// Two implementations behind one interface:
//
//   Resend   — used when RESEND_API_KEY is set
//   Console  — used when it is not
//
// The console transport is not a stub that quietly does nothing. It prints
// the full message, including any link, so the invite flow can be developed
// and tested end to end without an account. That distinction matters: a
// mailer that silently discards messages lets you ship a broken flow and
// find out from a customer.

import { Resend } from 'resend'
import { env, isTest } from './env.ts'

export type EmailMessage = {
  to: string
  subject: string
  /** Plain text. Every email we send has a text part — see the note below. */
  text: string
  html?: string | undefined
}

export type SendResult = {
  /** The provider's id when accepted; null when the send failed. */
  messageId: string | null
  error?: string | undefined
}

/**
 * Every message carries a plain-text part, and the text is written to stand
 * on its own rather than being a stripped-down copy of the HTML.
 *
 * Not for nostalgia: a link that only exists inside an HTML body is invisible
 * to a text-only client, some corporate mail filters, and screen readers that
 * fall back to text. An invite email whose link cannot be reached is a
 * customer who cannot log in.
 */

const resendClient = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null

async function sendViaResend(message: EmailMessage): Promise<SendResult> {
  if (!resendClient) {
    return { messageId: null, error: 'Resend is not configured' }
  }

  try {
    const result = await resendClient.emails.send({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {})
    })

    if (result.error) {
      return { messageId: null, error: result.error.message }
    }

    return { messageId: result.data?.id ?? null }
  } catch (error) {
    // Never rethrow. A failed send must not fail the operation that triggered
    // it — provisioning a client should not roll back because a mail server
    // was briefly unreachable. The caller records the failure instead.
    return {
      messageId: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function sendViaConsole(message: EmailMessage): SendResult {
  if (!isTest) {
    console.log(
      [
        '',
        '┌─ EMAIL (no RESEND_API_KEY — not actually sent) ─────────────',
        `│ To:      ${message.to}`,
        `│ Subject: ${message.subject}`,
        '├─────────────────────────────────────────────────────────────',
        message.text
          .split('\n')
          .map((line) => `│ ${line}`)
          .join('\n'),
        '└─────────────────────────────────────────────────────────────',
        ''
      ].join('\n')
    )
  }

  // A synthetic id, prefixed so it can never be mistaken for a real one when
  // it turns up in an EmailLog row months later.
  return { messageId: `console-${Date.now()}` }
}

/**
 * Sends an email. Never throws.
 *
 * Returns the provider's message id, or null with an error. The caller
 * decides what to do — which in practice is always "record it and carry on",
 * because there is nothing useful to do about a mail server being down in the
 * middle of a request.
 */
export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  return resendClient ? sendViaResend(message) : sendViaConsole(message)
}

/** True when a real provider is configured. Used by the readiness endpoint. */
export function isMailerConfigured(): boolean {
  return resendClient !== null
}
