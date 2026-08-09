// errors.ts — typed domain errors.
//
// The rule: SERVICES THROW, ONE PLACE TRANSLATES.
// A service layer knows nothing about HTTP. It throws "invalid credentials",
// not "401". Translation to a status code happens in exactly one place
// (plugins/errorHandler.ts).
//
// Why? The overdue-invoice job runs from a BullMQ worker where no `reply`
// exists at all. A service that calls reply.code(401) simply cannot be
// reused from there.
//
// Note: the message strings are Swedish because they are shown to Swedish
// customers. Everything a developer reads is English.

/** Machine-readable error code. Clients match on this; the text may change. */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'BUSINESS_RULE'
  | 'INTERNAL_ERROR'

export class AppError extends Error {
  readonly statusCode: number
  readonly code: ErrorCode
  /** Extra information that is SAFE to show the client (e.g. which fields failed). */
  readonly details?: unknown

  /**
   * Separates expected errors from bugs.
   *
   * true  = normal business event (wrong password, invoice not found).
   *         The client is told what happened.
   * false = a defect in our code (undefined.id, broken SQL).
   *         The client gets "internal error" and nothing more — otherwise
   *         we leak details about the system's internals to an attacker.
   */
  readonly isOperational: boolean

  constructor(
    message: string,
    statusCode: number,
    code: ErrorCode,
    options: { details?: unknown; isOperational?: boolean; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = this.constructor.name
    this.statusCode = statusCode
    this.code = code
    this.details = options.details
    this.isOperational = options.isOperational ?? true
  }
}

// ─────────────────────────────────────────────────────────────
// 400 — the input did not match the expected shape
// ─────────────────────────────────────────────────────────────

export class ValidationError extends AppError {
  constructor(message = 'Ogiltig indata', details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', { details })
  }
}

// ─────────────────────────────────────────────────────────────
// 401 — authentication
// ─────────────────────────────────────────────────────────────

/**
 * ONE error for ALL failed logins.
 *
 * This is deliberately a single class, not three. With separate errors for
 * "no such user", "wrong password" and "account locked", someone would
 * eventually return different messages — and then anyone could work out
 * which email addresses are registered with us (user enumeration). The
 * customer list is a trade secret.
 *
 * Making it structurally impossible beats relying on discipline.
 */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super('Ogiltig e-postadress eller lösenord', 401, 'INVALID_CREDENTIALS')
  }
}

/**
 * The account is locked after too many attempts.
 *
 * NOTE: externally this is IDENTICAL to InvalidCredentialsError — same status
 * code, same message. The distinction exists only internally, so we can log
 * lockouts separately. Saying "account locked" confirms the address exists,
 * and lets an attacker lock customers out on purpose.
 *
 * The trade-off: worse UX (you are not told why) against no enumeration.
 * Real banks solve it with unlock-by-email.
 */
export class AccountLockedError extends AppError {
  readonly lockedUntil: Date

  constructor(lockedUntil: Date) {
    super('Ogiltig e-postadress eller lösenord', 401, 'INVALID_CREDENTIALS')
    this.lockedUntil = lockedUntil
  }
}

/** Missing, expired or denylisted token on a protected route. */
export class UnauthenticatedError extends AppError {
  constructor(message = 'Autentisering krävs') {
    super(message, 401, 'UNAUTHENTICATED')
  }
}

// ─────────────────────────────────────────────────────────────
// 403 / 404 / 409
// ─────────────────────────────────────────────────────────────

/** Logged in, but wrong role. Unlike 401: we KNOW who you are. */
export class ForbiddenError extends AppError {
  constructor(message = 'Du har inte behörighet till denna resurs') {
    super(message, 403, 'FORBIDDEN')
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resursen') {
    super(`${resource} hittades inte`, 404, 'NOT_FOUND')
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resursen finns redan') {
    super(message, 409, 'CONFLICT')
  }
}

// ─────────────────────────────────────────────────────────────
// 429 — too many requests
// ─────────────────────────────────────────────────────────────

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    // retryAfterSeconds goes BOTH in the Retry-After header (the standard,
    // which HTTP clients understand automatically) and in the body (so a
    // frontend can render "try again in 42 seconds" without reading headers).
    super('För många försök. Försök igen senare.', 429, 'RATE_LIMITED', {
      details: { retryAfterSeconds }
    })
    this.retryAfterSeconds = retryAfterSeconds
  }
}

// ─────────────────────────────────────────────────────────────
// 422 — the shape is valid, but a business rule says no
// ─────────────────────────────────────────────────────────────

/**
 * Examples: "a paid invoice cannot be credited", "the amount must be greater
 * than zero". Different from 400: the data IS well-formed, but the action is
 * not allowed in the current state.
 */
export class BusinessRuleError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 422, 'BUSINESS_RULE', { details })
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
