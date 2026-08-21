// cors.test.ts — which origins the browser is told it may call us from.

import { describe, test, expect, beforeAll } from 'bun:test'
import type { FastifyInstance } from 'fastify'
import { buildTestApp } from '../helpers.ts'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})

const withOrigin = (origin: string) =>
  app.inject({ method: 'GET', url: '/health', headers: { origin } })

describe('allowed origins', () => {
  test('the configured frontend origin is allowed', async () => {
    const res = await withOrigin('http://localhost:5173')
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })

  test('127.0.0.1 is allowed too — a different origin to a browser', async () => {
    const res = await withOrigin('http://127.0.0.1:5173')
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173')
  })

  test('credentials are allowed, or the refresh cookie would never be sent', async () => {
    const res = await withOrigin('http://localhost:5173')
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })
})

describe('🔒 rejected origins', () => {
  test('an unknown site gets no allow-origin header', async () => {
    const res = await withOrigin('https://evil.example.com')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    // Without that header the browser blocks the response from reaching the
    // page, even though the request itself was served.
  })

  test('a lookalike origin is not allowed', async () => {
    const res = await withOrigin('http://localhost:5173.evil.com')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  test('🔑 the origin is never simply reflected', async () => {
    const res = await withOrigin('https://attacker.test')

    expect(res.headers['access-control-allow-origin']).not.toBe('https://attacker.test')
    // Reflecting the Origin header alongside credentials: true is the most
    // common serious CORS mistake — it lets ANY site call this API using a
    // logged-in visitor's cookies. Browsers reject origin '*' with
    // credentials, but happily accept a reflected one.
  })
})

describe('requests with no Origin header', () => {
  test('are allowed — curl, server-to-server and health checks send none', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    // Rejecting these would break every test that uses app.inject().
  })
})

describe('preflight', () => {
  test('an OPTIONS preflight is answered for an allowed origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization'
      }
    })

    expect(res.statusCode).toBeLessThan(300)
    expect(res.headers['access-control-allow-methods']).toContain('POST')
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'authorization'
    )
  })

  test('the preflight is cacheable, so every call is not two round trips', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST'
      }
    })

    expect(Number(res.headers['access-control-max-age'])).toBeGreaterThan(0)
    // Every request carrying an Authorization header triggers a preflight.
    // Uncached, that doubles the request count for the whole app.
  })
})
