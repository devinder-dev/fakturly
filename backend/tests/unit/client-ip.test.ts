// client-ip.test.ts — the address used for rate limits and audit rows.

import { describe, test, expect } from 'bun:test'
import { clientIp, rateLimitKey } from '../../src/lib/clientIp.ts'
import type { FastifyRequest } from 'fastify'

const fake = (headers: Record<string, string>, ip = '203.0.113.9', socketAddress = '10.1.2.3') =>
  ({ headers, ip, socket: { remoteAddress: socketAddress } }) as unknown as FastifyRequest

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

  test('🔑 header configured but absent: uses the TCP peer, never X-Forwarded-For', () => {
    // request.ip is what trustProxy read out of X-Forwarded-For — client-written.
    const request = fake({ 'x-forwarded-for': '6.6.6.6' }, '6.6.6.6', '10.1.2.3')
    expect(clientIp(request, 'cf-connecting-ip')).toBe('10.1.2.3')
  })
})

describe('rateLimitKey', () => {
  test('IPv4 is its own bucket', () => {
    expect(rateLimitKey('198.51.100.7')).toBe('198.51.100.7')
  })

  test('IPv4-mapped IPv6 is the same bucket as plain IPv4', () => {
    expect(rateLimitKey('::ffff:198.51.100.7')).toBe('198.51.100.7')
  })

  test('🔑 every address in one IPv6 /64 shares a bucket', () => {
    const a = rateLimitKey('2001:db8:1234:5678::1')
    const b = rateLimitKey('2001:db8:1234:5678:ffff:eeee:dddd:cccc')
    expect(a).toBe('2001:db8:1234:5678::/64')
    expect(b).toBe(a)
  })

  test('a different /64 is a different bucket', () => {
    expect(rateLimitKey('2001:db8:1234:5679::1')).not.toBe(rateLimitKey('2001:db8:1234:5678::1'))
  })

  test('spellings of the same address agree', () => {
    const expected = '2001:db8:0:0::/64'
    expect(rateLimitKey('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(expected)
    expect(rateLimitKey('2001:DB8::1')).toBe(expected)
    expect(rateLimitKey('2001:db8::1%eth0')).toBe(expected)
  })

  test('compression at the start and embedded IPv4 at the end', () => {
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64')
    expect(rateLimitKey('64:ff9b::198.51.100.7')).toBe('64:ff9b:0:0::/64')
  })

  test('anything that is not an IP passes through untouched', () => {
    expect(rateLimitKey('unknown')).toBe('unknown')
  })
})
