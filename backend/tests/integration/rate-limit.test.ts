// rate-limit.test.ts — both limiting layers.
//
// Rebuilt after the original was lost to a temp-directory cleanup.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, clearRateLimits, uniqueSuffix, redis } from '../helpers.ts'
import { LOGIN_RATE_LIMIT } from '../../src/plugins/rateLimit.ts'
import {
  progressiveDelayMs,
  recordFailedAttempt,
  getFailedAttempts,
  clearFailedAttempts,
  assertAccountNotLocked,
  applyProgressiveDelay,
  MAX_ATTEMPTS
} from '../../src/services/loginAttempts.service.ts'
import { RateLimitError } from '../../src/lib/errors.ts'

let app: FastifyInstance
const suffix = uniqueSuffix()

beforeAll(async () => {
  app = await buildTestApp((instance) => {
    instance.post('/_t/limited', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async () => ({
      ok: true
    }))
  })
})

afterAll(async () => {
  await clearRateLimits()
})

beforeEach(async () => {
  await clearRateLimits()
})

describe('layer 1 — per IP', () => {
  test('allows 5 then blocks, using our error shape', async () => {
    const responses = []
    for (let i = 0; i < 7; i++) {
      responses.push(
        await app.inject({
          method: 'POST',
          url: '/_t/limited',
          payload: {},
          remoteAddress: '203.0.113.10'
        })
      )
    }

    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(5)
    expect(responses.filter((r) => r.statusCode === 429)).toHaveLength(2)

    const blocked = responses[6]!
    expect(blocked.json().error.code).toBe('RATE_LIMITED')
    expect(typeof blocked.json().error.requestId).toBe('string')
    expect(blocked.headers['retry-after']).toBeDefined()
    expect(typeof blocked.json().error.details.retryAfterSeconds).toBe('number')
  })

  test('counts per IP, so a different address is unaffected', async () => {
    for (let i = 0; i < 6; i++) {
      await app.inject({ method: 'POST', url: '/_t/limited', payload: {}, remoteAddress: '203.0.113.20' })
    }

    const other = await app.inject({
      method: 'POST',
      url: '/_t/limited',
      payload: {},
      remoteAddress: '203.0.113.21'
    })
    expect(other.statusCode).toBe(200)
  })

  test('the counter lives in Redis, so it survives a restart', async () => {
    await app.inject({ method: 'POST', url: '/_t/limited', payload: {}, remoteAddress: '203.0.113.30' })

    const keys = await redis.keys('fakturly:rl:*')
    expect(keys.length).toBeGreaterThan(0)
    // In-memory counters reset on deploy, and three instances would each keep
    // their own — silently tripling the limit.
  })
})

describe('layer 2 — progressive delay', () => {
  test('the first two attempts are free, then it grows by 4x', () => {
    expect(progressiveDelayMs(1)).toBe(0)
    expect(progressiveDelayMs(2)).toBe(0)
    expect(progressiveDelayMs(3)).toBe(100)
    expect(progressiveDelayMs(4)).toBe(400)
    expect(progressiveDelayMs(5)).toBe(1600)
  })

  test('is capped, so we do not tie up our own connections', () => {
    expect(progressiveDelayMs(6)).toBe(5000)
    expect(progressiveDelayMs(20)).toBe(5000)
  })

  test('actually waits', async () => {
    const start = Date.now()
    await applyProgressiveDelay(4) // 400 ms
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(390)
    expect(elapsed).toBeLessThan(1500) // generous for CI
  })
})

describe('layer 2 — per account', () => {
  test('counts failures and locks out at the limit', async () => {
    const email = `spray-${suffix}@exempel.se`
    await clearFailedAttempts(email)

    expect(await getFailedAttempts(email)).toBe(0)

    for (let i = 1; i <= 4; i++) {
      expect(await recordFailedAttempt(email)).toBe(i)
    }

    // Four is still allowed.
    await assertAccountNotLocked(email)

    await recordFailedAttempt(email) // the fifth

    let thrown: unknown = null
    try {
      await assertAccountNotLocked(email)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(RateLimitError)
    expect((thrown as RateLimitError).retryAfterSeconds).toBeGreaterThan(0)

    await clearFailedAttempts(email)
  })

  test('a successful login clears the counter', async () => {
    const email = `clear-${suffix}@exempel.se`
    await recordFailedAttempt(email)
    await recordFailedAttempt(email)
    expect(await getFailedAttempts(email)).toBe(2)

    await clearFailedAttempts(email)
    expect(await getFailedAttempts(email)).toBe(0)
    // Otherwise old failures would lock out a user who then types it correctly.
  })

  test('🔑 an address that never existed is counted identically', async () => {
    // If only real accounts were counted, a known address would get
    // progressively slower while an unknown one stayed instant — and that
    // difference is the enumeration oracle we removed elsewhere.
    const ghost = `finns-inte-${suffix}@ingenstans.se`
    await clearFailedAttempts(ghost)

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await recordFailedAttempt(ghost)
    }

    let thrown: unknown = null
    try {
      await assertAccountNotLocked(ghost)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(RateLimitError)
    await clearFailedAttempts(ghost)
  })

  test('🔒 email addresses are not stored in plain text in Redis', async () => {
    const email = `pii-${suffix}@exempel.se`
    await recordFailedAttempt(email)

    const keys = await redis.keys('fakturly:login:fail:*')
    expect(keys.some((key) => key.includes('exempel.se'))).toBe(false)
    expect(keys.some((key) => key.includes(`pii-${suffix}`))).toBe(false)

    await clearFailedAttempts(email)
  })
})
