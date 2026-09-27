// env-rules.test.ts — the configurations the API refuses to start with.
//
// env.ts validates at import time and exits on failure, so each case runs in
// a child process with a crafted environment. Every variable the rules look
// at is set explicitly: dotenv fills only what is missing, so backend/.env
// cannot leak into a case.

import { describe, test, expect } from 'bun:test'
import { resolve } from 'node:path'

const BACKEND = resolve(import.meta.dir, '../..')

const BASE: Record<string, string> = {
  DATABASE_URL: 'postgresql://u:p@db.example.com:5432/app?sslmode=require',
  DATABASE_CA_CERT: '',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(40),
  NODE_ENV: 'production',
  FRONTEND_URL: 'https://app.example.com',
  STRIPE_SECRET_KEY: 'sk_test_abc',
  STRIPE_WEBHOOK_SECRET: 'whsec_abc',
  RESEND_API_KEY: 're_abc',
  DEMO_MODE: 'false'
}

function boot(overrides: Record<string, string>): { ok: boolean; output: string; frontendUrl?: string } {
  const env = { ...BASE, ...overrides }
  // An empty string means "unset" for the optional CA; drop it entirely.
  if (env.DATABASE_CA_CERT === '') delete env.DATABASE_CA_CERT

  const result = Bun.spawnSync({
    cmd: ['bun', '-e', "const { env } = await import('./src/lib/env.ts'); console.log('BOOTED ' + env.FRONTEND_URL)"],
    cwd: BACKEND,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }
  })
  const output = result.stdout.toString() + result.stderr.toString()
  const booted = /BOOTED (\S+)/.exec(output)
  return { ok: result.exitCode === 0 && booted !== null, output, frontendUrl: booted?.[1] }
}

describe('startup rules', () => {
  test('a correct production configuration boots', () => {
    expect(boot({}).ok).toBe(true)
  })

  test('🔑 DEMO_MODE with a live Stripe secret key is refused', () => {
    const result = boot({ DEMO_MODE: 'true', STRIPE_SECRET_KEY: 'sk_live_abc' })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('live-nyckel')
  })

  test('DEMO_MODE with a live restricted key is refused too', () => {
    expect(boot({ DEMO_MODE: 'true', STRIPE_SECRET_KEY: 'rk_live_abc' }).ok).toBe(false)
  })

  test('DEMO_MODE with a test key boots', () => {
    expect(boot({ DEMO_MODE: 'true', STRIPE_SECRET_KEY: 'sk_test_abc' }).ok).toBe(true)
  })

  test('a live key without DEMO_MODE boots — that is a real deployment', () => {
    expect(boot({ STRIPE_SECRET_KEY: 'sk_live_abc' }).ok).toBe(true)
  })

  test('🔑 production refuses a non-https FRONTEND_URL', () => {
    const result = boot({ FRONTEND_URL: 'http://localhost:5173' })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('FRONTEND_URL')
  })

  test('a trailing slash on FRONTEND_URL is stripped, so it matches Origin', () => {
    expect(boot({ FRONTEND_URL: 'https://app.example.com/' }).frontendUrl).toBe('https://app.example.com')
  })

  test('production refuses a database connection without TLS', () => {
    const result = boot({ DATABASE_URL: 'postgresql://u:p@db.example.com:5432/app' })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('saknar TLS')
  })

  test('a CA file plus sslmode in the URL is refused', () => {
    const result = boot({ DATABASE_CA_CERT: 'certs/supabase-prod-ca-2021.crt' })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('ssl*-parametrar')
  })
})
