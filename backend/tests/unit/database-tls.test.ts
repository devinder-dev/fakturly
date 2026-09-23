// database-tls.test.ts — how the database URL and CA become TLS settings.
//
// Pure functions, no network. The network behaviour these rely on (which
// URL parameters really verify a certificate) was established against
// Supabase itself and is recorded in lib/databaseTls.ts and ADR 53; these
// tests pin the translation so it cannot drift.

import { describe, test, expect } from 'bun:test'
import { resolve } from 'node:path'
import {
  urlHasTlsParams,
  assertNoTlsConflict,
  pgSslOptions,
  migrationUrl
} from '../../src/lib/databaseTls.ts'

const PLAIN = 'postgresql://postgres.ref:secret@aws-1-eu-west-1.pooler.supabase.com:5432/postgres'
const CA = 'certs/supabase-prod-ca-2021.crt'

describe('urlHasTlsParams', () => {
  test('a plain URL has none', () => {
    expect(urlHasTlsParams(PLAIN)).toBe(false)
  })

  test.each(['sslmode=require', 'sslrootcert=/x.crt', 'sslaccept=strict', 'uselibpqcompat=true'])(
    'detects %s',
    (param) => {
      expect(urlHasTlsParams(`${PLAIN}?${param}`)).toBe(true)
    }
  )

  test('ignores unrelated parameters', () => {
    expect(urlHasTlsParams(`${PLAIN}?connection_limit=5`)).toBe(false)
  })
})

describe('assertNoTlsConflict', () => {
  test('refuses a CA together with sslmode in the URL — pg would let the URL win', () => {
    expect(() => assertNoTlsConflict(`${PLAIN}?sslmode=require`, CA)).toThrow(/override the CA/)
  })

  test('allows either one on its own', () => {
    expect(() => assertNoTlsConflict(`${PLAIN}?sslmode=require`, undefined)).not.toThrow()
    expect(() => assertNoTlsConflict(PLAIN, CA)).not.toThrow()
  })
})

describe('pgSslOptions — the runtime pool', () => {
  test('without a CA, leaves TLS to the URL', () => {
    expect(pgSslOptions(PLAIN, undefined)).toBeUndefined()
  })

  test('with a CA, loads it and insists on verification', () => {
    const ssl = pgSslOptions(PLAIN, CA)
    expect(ssl?.rejectUnauthorized).toBe(true)
    expect(ssl?.ca).toContain('BEGIN CERTIFICATE')
  })

  test('a missing CA file fails loudly at startup, not silently unverified', () => {
    expect(() => pgSslOptions(PLAIN, 'certs/does-not-exist.crt')).toThrow()
  })
})

describe('migrationUrl — the Prisma CLI', () => {
  test('without a CA, the URL is passed through untouched', () => {
    expect(migrationUrl(PLAIN, undefined)).toBe(PLAIN)
  })

  test('with a CA, adds the one parameter set that actually verifies', () => {
    const params = new URL(migrationUrl(PLAIN, CA)).searchParams
    expect(params.get('sslmode')).toBe('require')
    expect(params.get('sslaccept')).toBe('strict')
    expect(params.get('sslcert')).toBe(resolve(CA))
    // verify-full + sslrootcert accepted a wrong CA in testing; never emit it.
    expect(params.has('sslrootcert')).toBe(false)
  })

  test('keeps the credentials and host intact', () => {
    const url = new URL(migrationUrl(PLAIN, CA))
    expect(url.username).toBe('postgres.ref')
    expect(url.password).toBe('secret')
    expect(url.host).toBe('aws-1-eu-west-1.pooler.supabase.com:5432')
  })
})
