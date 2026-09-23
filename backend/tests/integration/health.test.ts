// health.test.ts — liveness vs readiness.
//
// The outage of 2026-09-23 came from pointing the health check at a probe
// that queries the database. These tests pin down the two properties that
// keep it from happening again: /health depends on nothing, and
// /health/ready says "no" quickly instead of hanging.

import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, clearRateLimits } from '../helpers.ts'
import { redis } from '../../src/lib/redis.ts'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})

afterAll(async () => {
  await clearRateLimits()
})

afterEach(async () => {
  await clearRateLimits()
})

describe('/health — liveness', () => {
  test('is not rate limited, so it does not depend on Redis', async () => {
    // One more than the global limit of 100 per minute from the same IP.
    for (let i = 0; i < 101; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        remoteAddress: '203.0.113.50'
      })
      expect(response.statusCode).toBe(200)
      expect(response.headers['x-ratelimit-limit']).toBeUndefined()
    }
  })

  // Checked through Redis rather than Prisma: the Prisma client is a Proxy,
  // and spyOn cannot replace its methods — a spy on $queryRaw silently
  // records nothing, which would make this test pass for the wrong reason.
  test('never touches its dependencies', async () => {
    const spy = spyOn(redis, 'ping')
    try {
      const response = await app.inject({ method: 'GET', url: '/health' })
      expect(response.statusCode).toBe(200)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('/health/ready — readiness', () => {
  test('is ready when the database and Redis answer', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ready', database: 'up', redis: 'up' })
  })

  test('answers 503 within its 3 s budget when a dependency hangs', async () => {
    // Simulate a dependency that accepts the request and never answers — the
    // shape of today's outage. Redis stands in for the database here (see
    // the note above on why Prisma cannot be spied on); the 3 s guard wraps
    // both checks the same way.
    const spy = spyOn(redis, 'ping').mockImplementation(
      (() => new Promise<never>(() => {})) as unknown as typeof redis.ping
    )
    try {
      const started = Date.now()
      const response = await app.inject({ method: 'GET', url: '/health/ready' })
      const elapsed = Date.now() - started

      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({ status: 'not_ready' })
      expect(elapsed).toBeGreaterThanOrEqual(2_900)
      expect(elapsed).toBeLessThan(4_500)
    } finally {
      spy.mockRestore()
    }
  }, 10_000)
})
