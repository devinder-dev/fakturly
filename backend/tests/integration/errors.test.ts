// errors.test.ts — the central error handler.
//
// Rebuilt after the original was lost to a temp-directory cleanup.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, uniqueSuffix, prisma } from '../helpers.ts'
import {
  InvalidCredentialsError,
  AccountLockedError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  BusinessRuleError
} from '../../src/lib/errors.ts'
import { loginSchema } from '../../src/validators/auth.validator.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()

beforeAll(async () => {
  // Test-only routes that throw each error type, so they pass through the
  // real error handler exactly as a production route would.
  app = await buildTestApp((instance) => {
    instance.get('/_t/creds', async () => {
      throw new InvalidCredentialsError()
    })
    instance.get('/_t/locked', async () => {
      throw new AccountLockedError(new Date(Date.now() + 900_000))
    })
    instance.get('/_t/forbidden', async () => {
      throw new ForbiddenError()
    })
    instance.get('/_t/notfound', async () => {
      throw new NotFoundError('Fakturan')
    })
    instance.get('/_t/ratelimit', async () => {
      throw new RateLimitError(42)
    })
    instance.get('/_t/business', async () => {
      throw new BusinessRuleError('En betald faktura kan inte krediteras')
    })
    instance.get('/_t/zod', async () => {
      loginSchema.parse({ email: 'trasig', password: '' })
    })
    instance.get('/_t/bug', async () => {
      const broken = undefined as unknown as { id: string }
      return { id: broken.id } // TypeError
    })
    instance.get('/_t/prisma', async () => {
      const email = `dubblett-${suffix}@test.se`
      await prisma.user.create({ data: { email, password: 'x' } })
      await prisma.user.create({ data: { email, password: 'x' } }) // P2002
    })
  })
})

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { contains: `dubblett-${suffix}` } } })
})

const get = (url: string) => app.inject({ method: 'GET', url })

describe('domain errors map to the right status', () => {
  test('401 INVALID_CREDENTIALS', async () => {
    const res = await get('/_t/creds')
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS')
  })

  test('403 FORBIDDEN', async () => {
    const res = await get('/_t/forbidden')
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('FORBIDDEN')
  })

  test('404 includes the resource name', async () => {
    const res = await get('/_t/notfound')
    expect(res.statusCode).toBe(404)
    expect(res.json().error.message).toContain('Fakturan')
  })

  test('422 BUSINESS_RULE', async () => {
    const res = await get('/_t/business')
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('BUSINESS_RULE')
  })
})

describe('a locked account is indistinguishable from a wrong password', () => {
  test('same status, code and message', async () => {
    const creds = await get('/_t/creds')
    const locked = await get('/_t/locked')

    expect(locked.statusCode).toBe(creds.statusCode)
    expect(locked.json().error.code).toBe(creds.json().error.code)
    expect(locked.json().error.message).toBe(creds.json().error.message)
    // Saying "account locked" would confirm the address exists, and let an
    // attacker lock customers out deliberately.
  })
})

describe('rate limit errors', () => {
  test('429 with a Retry-After header and a body field', async () => {
    const res = await get('/_t/ratelimit')
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBe('42')
    expect(res.json().error.details.retryAfterSeconds).toBe(42)
  })
})

describe('Zod errors', () => {
  test('400 with per-field detail — it is the caller’s own input', async () => {
    const res = await get('/_t/zod')
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    expect(Array.isArray(res.json().error.details)).toBe(true)
    expect(res.json().error.details.length).toBe(2)
  })
})

describe('Prisma errors never reach the client', () => {
  test('a unique-constraint violation becomes a vague 409', async () => {
    const res = await get('/_t/prisma')
    expect(res.statusCode).toBe(409)

    // Prisma would have said "Unique constraint failed on the fields:
    // (`email`)". Forwarding that confirms the address is registered.
    const body = JSON.stringify(res.json()).toLowerCase()
    expect(body).not.toContain('email')
    expect(body).not.toContain('constraint')
    expect(body).not.toContain('prisma')
  })
})

describe('unexpected errors', () => {
  test('become a 500 with no stack trace or file path', async () => {
    const res = await get('/_t/bug')
    expect(res.statusCode).toBe(500)
    expect(res.json().error.code).toBe('INTERNAL_ERROR')

    const body = JSON.stringify(res.json())
    expect(body).not.toContain('.ts:')
    expect(body).not.toContain('/Users/')
    expect(body).not.toContain('\\n    at ')
  })
})

describe('response shape', () => {
  test('every error carries a requestId', async () => {
    for (const url of ['/_t/creds', '/_t/forbidden', '/_t/zod', '/_t/bug']) {
      const res = await get(url)
      expect(typeof res.json().error.requestId).toBe('string')
    }
  })

  test('an unknown route uses the same shape', async () => {
    const res = await get('/finns-inte')
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('NOT_FOUND')
    expect(typeof res.json().error.requestId).toBe('string')
  })
})
