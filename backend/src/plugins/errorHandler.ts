// plugins/errorHandler.ts — ENDA stället där ett fel blir ett HTTP-svar.
//
// Allt som kastas någonstans i appen landar här. Uppgiften är dubbel:
//   1. Logga ALLT vi vet, på servern
//   2. Skicka MINIMALT till klienten
//
// Den asymmetrin är hela poängen. Ett Prisma-fel innehåller ofta
// "Unique constraint failed on the fields: (email)" — skickar vi det vidare
// har vi just bekräftat för en angripare att adressen finns registrerad.

import fp from 'fastify-plugin'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { Prisma } from '../generated/prisma/client.ts'
import { AppError, RateLimitError, isAppError } from '../lib/errors.ts'
import { isProduction } from '../lib/env.ts'

/** Svarsformen är densamma för ALLA fel — klienten slipper gissa. */
type ErrorResponse = {
  error: {
    code: string
    message: string
    /** requestId gör att användaren kan säga "fel req-42" och vi hittar raden. */
    requestId: string
    details?: unknown
  }
}

/**
 * Läser ut statusCode/code/message ur ett okänt fel.
 *
 * Fastify typar felet som `unknown` — vilket är korrekt: vem som helst kan
 * kasta vad som helst i JavaScript, även `throw 'sträng'`. Projektregeln
 * förbjuder `any`, så vi smalnar av med riktiga typkontroller istället för
 * att ljuga för kompilatorn med en cast.
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
    // ── 1. Våra egna domänfel — det förväntade fallet ──────────
    if (isAppError(error)) {
      // Låsta konton och felaktiga lösenord är inte buggar, men de är
      // säkerhetshändelser. warn gör dem sökbara utan att larma om allt.
      const level = error.statusCode >= 500 ? 'error' : 'warn'
      app.log[level](
        { err: error, code: error.code, statusCode: error.statusCode },
        'Domänfel'
      )

      // 429 ska tala om NÄR man får försöka igen.
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

    // ── 2. Zod — indatat höll inte formen ──────────────────────
    // Fältfel är säkra att visa: det är användarens EGET indata, och hen
    // behöver veta vad som var fel för att kunna rätta det.
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        field: issue.path.join('.') || '(rot)',
        message: issue.message
      }))
      app.log.warn({ details }, 'Valideringsfel')
      return send(reply, request, 400, 'VALIDATION_ERROR', 'Ogiltig indata', details)
    }

    // ── 3. Prisma — databasfel ─────────────────────────────────
    // Prismas meddelanden är utmärkta för utvecklare och farliga för
    // klienter. Vi översätter koden och kastar bort texten.
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      app.log.error({ err: error, prismaCode: error.code }, 'Prisma-fel')

      switch (error.code) {
        case 'P2002': // unik constraint bruten
          // Medvetet vag text. "E-postadressen är upptagen" bekräftar
          // att adressen finns — det är enumeration via en annan dörr.
          return send(reply, request, 409, 'CONFLICT', 'Resursen kunde inte skapas')
        case 'P2025': // raden fanns inte
          return send(reply, request, 404, 'NOT_FOUND', 'Resursen hittades inte')
        case 'P2003': // främmande nyckel bruten
          return send(reply, request, 409, 'CONFLICT', 'Åtgärden bryter mot en relation')
        default:
          return send(reply, request, 500, 'INTERNAL_ERROR', 'Ett internt fel uppstod')
      }
    }

    // ── 4. Fastifys egna fel (för stor body, trasig JSON, ...) ──
    // De bär redan en vettig statuskod. 4xx är användarens fel och
    // meddelandet är ofarligt; 5xx tystar vi.
    const fields = readErrorFields(error)
    if (fields.statusCode >= 400 && fields.statusCode < 500) {
      app.log.warn({ err: error }, 'Klientfel')
      return send(reply, request, fields.statusCode, fields.code, fields.message)
    }

    // ── 5. Allt annat = en bugg vi inte förutsett ──────────────
    // Full stacktrace i loggen, ingenting till klienten.
    app.log.error({ err: error }, 'Ohanterat fel')

    return send(
      reply,
      request,
      500,
      'INTERNAL_ERROR',
      // Bara i utveckling visar vi det riktiga felet — annars läcker vi
      // filnamn, radnummer och biblioteksversioner till vem som helst.
      isProduction ? 'Ett internt fel uppstod' : `Ohanterat fel: ${fields.message}`
    )
  })

  // 404 på en okänd URL ska ha SAMMA form som alla andra fel.
  // Utan detta returnerar Fastify sitt eget format och klienten måste
  // hantera två olika felstrukturer.
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

// Återexporteras så att resten av appen importerar fel från ett ställe.
export { AppError }
