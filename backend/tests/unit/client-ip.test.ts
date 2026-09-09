// client-ip.test.ts — the address used for rate limits and audit rows.

import { describe, test, expect } from 'bun:test'
import { clientIp } from '../../src/lib/clientIp.ts'
import type { FastifyRequest } from 'fastify'

const fake = (headers: Record<string, string>, ip = '203.0.113.9') =>
  ({ headers, ip }) as unknown as FastifyRequest

describe('clientIp', () => {
  test('falls back to request.ip when no trusted header is configured', () => {
    expect(clientIp(fake({ 'x-forwarded-for': '10.0.0.1' }), undefined)).toBe('203.0.113.9')
  })

  test('🔑 reads the configured header, not X-Forwarded-For', () => {
    const request = fake({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '10.0.0.1, 198.51.100.7, 172.16.0.2' })
    expect(clientIp(request, 'cf-connecting-ip')).toBe('198.51.100.7')
    // A forged X-Forwarded-For changes nothing.
  })

  test('is case-insensitive about the header name and takes the first value', () => {
    expect(clientIp(fake({ 'cf-connecting-ip': '198.51.100.7, 1.1.1.1' }), 'CF-Connecting-IP')).toBe('198.51.100.7')
  })

  test('falls back when the configured header is absent', () => {
    expect(clientIp(fake({}), 'cf-connecting-ip')).toBe('203.0.113.9')
  })
})
