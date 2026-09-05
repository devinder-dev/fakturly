// sentry.ts — error tracking, behind one switch.
//
// Same shape as the mailer and Stripe: a real path when SENTRY_DSN is set,
// nothing at all when it is not. The rest of the code calls captureException
// and never knows whether anything happened.
//
// WHAT IS SENT: the error, its stack trace, and the tags passed in (request
// id, method, URL). WHAT IS NOT: request bodies, headers, cookies or user
// data. `sendDefaultPii: false` keeps the SDK from attaching IP addresses,
// and no beforeSend is needed because nothing sensitive is handed to it.

import * as Sentry from '@sentry/bun'
import { env } from './env.ts'

let enabled = false

export function initSentry(): void {
  if (!env.SENTRY_DSN) return

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    sendDefaultPii: false,
    // Errors only. Performance tracing would sample every request and is a
    // separate decision with its own cost.
    tracesSampleRate: 0
  })

  enabled = true
  console.log('[sentry] error tracking enabled')
}

export function captureException(error: unknown, tags: Record<string, string> = {}): void {
  if (!enabled) return
  Sentry.captureException(error, { tags })
}

/** True when a DSN was configured. Used by the readiness endpoint. */
export function isSentryEnabled(): boolean {
  return enabled
}
