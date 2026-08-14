// audit.service.ts — records security-relevant events.
//
// Two rules govern everything in this file:
//
//   1. The audit write NEVER shares a transaction with the operation it
//      records. A rollback must not erase the evidence.
//   2. A failed audit write NEVER fails the user's operation. If Postgres
//      hiccups while logging a successful login, the user still logs in.
//
// Rule 2 is a genuine trade-off and worth stating plainly. Some regulated
// systems do the opposite — if it cannot be logged, it must not happen. That
// is defensible for money movement. For authentication it would mean a
// logging glitch locks every customer out, which is a worse outcome than a
// gap in the log. We choose availability here and shout loudly in the
// application log instead.

import { createAuditEntry, type AuditEntry } from '../repositories/auditLog.repository.ts'

/**
 * Every action we record. A closed set rather than free strings, so a typo
 * cannot silently create a new category that no alert is watching.
 */
export const AuditAction = {
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGIN_BLOCKED_RATE_LIMIT: 'LOGIN_BLOCKED_RATE_LIMIT',
  LOGOUT: 'LOGOUT',
  TOKEN_REFRESHED: 'TOKEN_REFRESHED',
  TOKEN_THEFT_DETECTED: 'TOKEN_THEFT_DETECTED',
  PASSWORD_REHASHED: 'PASSWORD_REHASHED',
  /** An invited user set their first password. */
  PASSWORD_SET: 'PASSWORD_SET',
  /** An existing user changed their password via a reset link. */
  PASSWORD_RESET: 'PASSWORD_RESET',
  INVITE_SENT: 'INVITE_SENT',
  CLIENT_CREATED: 'CLIENT_CREATED',
  CLIENT_UPDATED: 'CLIENT_UPDATED',
  INVOICE_CREATED: 'INVOICE_CREATED',
  INVOICE_SENT: 'INVOICE_SENT',
  INVOICE_DELETED: 'INVOICE_DELETED',
  PAYMENT_LINK_CREATED: 'PAYMENT_LINK_CREATED',
  /** No acting user — Stripe told us, not a person. */
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED'
} as const

export type AuditActionType = (typeof AuditAction)[keyof typeof AuditAction]

export const AuditResource = {
  USER: 'User',
  CLIENT: 'Client',
  REFRESH_TOKEN: 'RefreshToken',
  INVOICE: 'Invoice'
} as const

export type AuditInput = Omit<AuditEntry, 'action' | 'resource'> & {
  action: AuditActionType
  resource: string
}

/**
 * Records an event. Never throws.
 *
 * Callers do not await this for correctness — they await it so the row is
 * written before the response goes out, but a failure here is swallowed.
 *
 * The console.error is deliberate rather than a silent catch: losing audit
 * rows is a serious operational problem, and it must be visible in the
 * application log even though it does not fail the request.
 */
export async function record(input: AuditInput): Promise<void> {
  try {
    await createAuditEntry(input)
  } catch (error) {
    // Never rethrow. See rule 2 above.
    console.error('[audit] failed to write audit entry', {
      action: input.action,
      resource: input.resource,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
