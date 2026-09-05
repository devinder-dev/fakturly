// plugins/errorHandler.ts — the ONLY place where an error becomes an HTTP response.
//
// Everything thrown anywhere in the app lands here. The job is two-sided:
//   1. Log EVERYTHING we know, on the server
//   2. Send the MINIMUM to the client
//
// That asymmetry is the whole point. A Prisma error often contains
// "Unique constraint failed on the fields: (email)" — forward that and we
// have just confirmed to an attacker that the address is registered.
//
// User-facing messages stay in Swedish: they are shown to Swedish customers.
// Comments and log messages are English, for whoever maintains this.

import fp from 'fastify-plugin'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { Prisma } from '../generated/prisma/client.ts'
import { AppError, RateLimitError, isAppError } from '../lib/errors.ts'
import { isProduction } from '../lib/env.ts'
import { captureException } from '../lib/sentry.ts'

/** One response shape for EVERY error, so the client never has to guess. */
type ErrorResponse = {
  error: {
    code: string
    message: string
    /** Lets a user say "error req-42" and we find the exact log line. */
    requestId: string
    details?: unknown
  }
}

/**
 * Extracts statusCode/code/message from an unknown error.
 *
 * Fastify types the error as `unknown` — which is correct: JavaScript lets
 * anyone throw anything, including `throw 'a string'`. The project rules ban
 * `any`, so we narrow with real type checks rather than lying to the compiler
 * with a cast.
 */
function readErrorFields(error: unknown): {
  statusCode: number
  code: string
  message: string
} {
  const source: Record<string, unknown> =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)
      : {}

  return {
    statusCode: typeof source.statusCode === 'number' ? source.statusCode : 500,
    code: typeof source.code === 'string' ? source.code : 'INTERNAL_ERROR',
    message: typeof source.message === 'string' ? source.message : 'Okänt fel'
  }
}

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  message: string,
  details?: unknown
) {
  const body: ErrorResponse = {
    error: { code, message, requestId: request.id }
  }
  if (details !== undefined) body.error.details = details
  return reply.code(status).send(body)
}

async function errorHandlerPlugin(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    // ── 1. Our own domain errors — the expected case ────────────
    if (isAppError(error)) {
      // Locked accounts and wrong passwords are not bugs, but they are
      // security events. warn keeps them searchable without alerting on
      // every single one.
      const level = error.statusCode >= 500 ? 'error' : 'warn'
      app.log[level](
        { err: error, code: error.code, statusCode: error.statusCode },
        'Domain error'
      )

      // A 429 must say WHEN the caller may try again.
      if (error instanceof RateLimitError) {
        reply.header('Retry-After', String(error.retryAfterSeconds))
      }

      return send(
        reply,
        request,
        error.statusCode,
        error.code,
        error.message,
        error.details
      )
    }

    // ── 2. Zod — the input did not match the schema ─────────────
    // Field errors are safe to return: this is the caller's OWN input, and
    // they need to know what was wrong in order to fix it.
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        field: issue.path.join('.') || '(rot)',
        message: issue.message
      }))
      app.log.warn({ details }, 'Validation error')
      return send(reply, request, 400, 'VALIDATION_ERROR', 'Ogiltig indata', details)
    }

    // ── 3. Prisma — database errors ─────────────────────────────
    // Prisma's messages are excellent for developers and dangerous for
    // clients. We translate the code and throw the text away.
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      app.log.error({ err: error, prismaCode: error.code }, 'Prisma error')

      switch (error.code) {
        case 'P2002': // unique constraint violated
          // Deliberately vague. "That email is taken" would confirm the
          // address exists — enumeration through a different door.
          return send(reply, request, 409, 'CONFLICT', 'Resursen kunde inte skapas')
        case 'P2025': // record not found
          return send(reply, request, 404, 'NOT_FOUND', 'Resursen hittades inte')
        case 'P2003': // foreign key constraint violated
          return send(reply, request, 409, 'CONFLICT', 'Åtgärden bryter mot en relation')
        default:
          return send(reply, request, 500, 'INTERNAL_ERROR', 'Ett internt fel uppstod')
      }
    }

    // ── 4. Fastify's own errors (body too large, malformed JSON, ...) ──
    // These already carry a sensible status code. A 4xx is the caller's
    // fault and its message is harmless; a 5xx we silence.
    const fields = readErrorFields(error)
    if (fields.statusCode >= 400 && fields.statusCode < 500) {
      app.log.warn({ err: error }, 'Client error')
      return send(reply, request, fields.statusCode, fields.code, fields.message)
    }

    // ── 5. Anything else = a bug we did not anticipate ──────────
    // Full stack trace in the log, nothing at all to the client.
    app.log.error({ err: error }, 'Unhandled error')

    // And to Sentry, tagged with the request id the client was given, so a
    // report of "error req-42" leads straight to the stack trace. Only this
    // branch: a wrong password or a 404 is not an error to track.
    captureException(error, { requestId: request.id, method: request.method, url: request.url })

    return send(
      reply,
      request,
      500,
      'INTERNAL_ERROR',
      // Only in development do we show the real error — otherwise we leak
      // file names, line numbers and library versions to anyone who asks.
      isProduction ? 'Ett internt fel uppstod' : `Ohanterat fel: ${fields.message}`
    )
  })

  // A 404 on an unknown URL must use the SAME shape as every other error.
  // Without this, Fastify returns its own format and the client has to
  // handle two different error structures.
  app.setNotFoundHandler((request, reply) =>
    send(
      reply,
      request,
      404,
      'NOT_FOUND',
      `Ingen route matchar ${request.method} ${request.url}`
    )
  )
}

export default fp(errorHandlerPlugin, { name: 'errorHandler' })

// Re-exported so the rest of the app imports errors from one place.
export { AppError }
