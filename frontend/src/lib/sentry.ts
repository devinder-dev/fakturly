// sentry.ts — error tracking in the browser, behind one switch.
//
// Mirrors the backend: nothing happens without VITE_SENTRY_DSN. With it,
// uncaught errors and unhandled promise rejections are reported with the
// release and environment, and nothing else — no session replay, no
// performance tracing, no user identity. A frontend error report exists to
// find a broken screen, not to watch a user.

import * as Sentry from '@sentry/react'

export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined
  if (!dsn) return

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    sendDefaultPii: false,
    tracesSampleRate: 0
  })
}
