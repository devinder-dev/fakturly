// errors.ts — typade domänfel (domain errors).
//
// Regeln: SERVICES KASTAR, EN PLATS ÖVERSÄTTER.
// Ett service-lager vet ingenting om HTTP. Det kastar "ogiltiga
// inloggningsuppgifter", inte "401". Översättningen till statuskod sker
// på exakt ett ställe (plugins/errorHandler.ts).
//
// Varför? Overdue-jobbet körs från en BullMQ-worker där det inte finns
// någon `reply` alls. En service som anropar reply.code(401) går helt
// enkelt inte att återanvända därifrån.

/** Maskinläsbar felkod. Klienten kan matcha på den; texten kan ändras. */
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
  /** Extra info som är SÄKER att visa klienten (t.ex. vilka fält som var fel). */
  readonly details?: unknown

  /**
   * Skiljer förväntade fel från buggar.
   *
   * true  = normal affärshändelse (fel lösenord, faktura saknas).
   *         Klienten får veta vad som hände.
   * false = defekt i koden (undefined.id, trasig SQL).
   *         Klienten får "internt fel" och inget mer — annars läcker vi
   *         detaljer om systemets insida till en angripare.
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
// 400 — indatat höll inte formen
// ─────────────────────────────────────────────────────────────

export class ValidationError extends AppError {
  constructor(message = 'Ogiltig indata', details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', { details })
  }
}

// ─────────────────────────────────────────────────────────────
// 401 — autentisering
// ─────────────────────────────────────────────────────────────

/**
 * ETT fel för ALLA misslyckade inloggningar.
 *
 * Detta är avsiktligt en enda klass, inte tre. Skulle vi ha separata fel
 * för "användaren finns inte", "fel lösenord" och "kontot är låst" skulle
 * någon förr eller senare returnera olika meddelanden — och då kan vem som
 * helst räkna ut vilka e-postadresser som är registrerade hos oss
 * (user enumeration). Kundlistan är affärshemlighet.
 *
 * Genom att göra det strukturellt omöjligt slipper vi förlita oss på disciplin.
 */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super('Ogiltig e-postadress eller lösenord', 401, 'INVALID_CREDENTIALS')
  }
}

/**
 * Kontot är låst efter för många försök.
 *
 * OBS: utåt är detta IDENTISKT med InvalidCredentialsError — samma
 * statuskod, samma text. Skillnaden finns bara internt så att vi kan
 * logga låsningen separat. Berättar vi "kontot är låst" har vi bekräftat
 * att adressen finns, och en angripare kan låsa ut kunder med flit.
 *
 * Avvägningen: sämre användarupplevelse (du får inte veta varför) mot
 * ingen enumeration. Riktiga banker löser det med upplåsning via e-post.
 */
export class AccountLockedError extends AppError {
  readonly lockedUntil: Date

  constructor(lockedUntil: Date) {
    super('Ogiltig e-postadress eller lösenord', 401, 'INVALID_CREDENTIALS')
    this.lockedUntil = lockedUntil
  }
}

/** Saknad, utgången eller spärrad token på en skyddad route. */
export class UnauthenticatedError extends AppError {
  constructor(message = 'Autentisering krävs') {
    super(message, 401, 'UNAUTHENTICATED')
  }
}

// ─────────────────────────────────────────────────────────────
// 403 / 404 / 409
// ─────────────────────────────────────────────────────────────

/** Inloggad, men fel roll. Skillnad mot 401: vi VET vem du är. */
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
// 429 — för många requests
// ─────────────────────────────────────────────────────────────

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    // retryAfterSeconds ligger BÅDE i Retry-After-headern (standarden, som
    // HTTP-klienter förstår automatiskt) och i body:n (så att en frontend
    // kan visa "försök igen om 42 sekunder" utan att läsa headers).
    super('För många försök. Försök igen senare.', 429, 'RATE_LIMITED', {
      details: { retryAfterSeconds }
    })
    this.retryAfterSeconds = retryAfterSeconds
  }
}

// ─────────────────────────────────────────────────────────────
// 422 — formen är rätt, men affärsregeln säger nej
// ─────────────────────────────────────────────────────────────

/**
 * Exempel: "en betald faktura kan inte krediteras", "beloppet måste vara
 * större än noll". Skiljer sig från 400: datan ÄR välformad, men handlingen
 * är otillåten i nuvarande tillstånd.
 */
export class BusinessRuleError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 422, 'BUSINESS_RULE', { details })
  }
}

// ─────────────────────────────────────────────────────────────
// Hjälpare
// ─────────────────────────────────────────────────────────────

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
