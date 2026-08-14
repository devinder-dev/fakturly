// validators.test.ts — input validation.
//
// Rebuilt after the original suite was lost to a temp-directory cleanup —
// which is why these now live in the repository.

import { describe, test, expect } from 'bun:test'
import {
  loginSchema,
  newPasswordSchema,
  emailSchema,
  createClientSchema,
  setPasswordSchema
} from '../../src/validators/auth.validator.ts'
import {
  listQuerySchema,
  updateClientSchema,
  idParamSchema
} from '../../src/validators/client.validator.ts'

describe('emailSchema', () => {
  test('trims and lowercases before validating', () => {
    const result = emailSchema.parse('  Anna@Example.SE  ')
    expect(result).toBe('anna@example.se')
  })

  test('rejects a malformed address', () => {
    expect(emailSchema.safeParse('inte-en-epost').success).toBe(false)
    expect(emailSchema.safeParse('').success).toBe(false)
    expect(emailSchema.safeParse('@example.se').success).toBe(false)
  })

  test('rejects anything over the RFC 5321 limit of 254', () => {
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@x.se`).success).toBe(false)
  })
})

describe('login vs new-password policy', () => {
  test('LOGIN accepts a short password', () => {
    // Enforcing the policy here would leak it to an attacker, and would lock
    // out existing users the day the minimum is raised.
    expect(loginSchema.safeParse({ email: 'a@b.se', password: 'kort' }).success).toBe(true)
  })

  test('LOGIN still rejects an empty password', () => {
    expect(loginSchema.safeParse({ email: 'a@b.se', password: '' }).success).toBe(false)
  })

  test('LOGIN caps length as DoS protection', () => {
    // Argon2id is deliberately slow; we will not hash a megabyte per request.
    expect(loginSchema.safeParse({ email: 'a@b.se', password: 'x'.repeat(2000) }).success).toBe(false)
  })

  test('SETTING a password enforces 12 characters', () => {
    expect(newPasswordSchema.safeParse('kort123').success).toBe(false)
    expect(newPasswordSchema.safeParse('a'.repeat(12)).success).toBe(true)
  })

  test('SETTING a password rejects over 128', () => {
    expect(newPasswordSchema.safeParse('a'.repeat(129)).success).toBe(false)
  })

  test('allows at least 64 characters, as NIST requires for passphrases', () => {
    expect(newPasswordSchema.safeParse('a'.repeat(64)).success).toBe(true)
  })
})

describe('NIST SP 800-63B: no composition rules', () => {
  test('accepts a long phrase with no digits, symbols or capitals', () => {
    // Far stronger than "Sommar2026!" despite looking simpler.
    const result = newPasswordSchema.safeParse('en helt vanlig lösenordsfras utan siffror')
    expect(result.success).toBe(true)
  })

  test('accepts spaces and Unicode', () => {
    expect(newPasswordSchema.safeParse('räksmörgås med extra majonnäs').success).toBe(true)
  })
})

describe('Unicode normalisation in the validator', () => {
  test('NFC and NFD forms normalise to the same output', () => {
    const composed = 'lösenordé-test'.normalize('NFC')
    const decomposed = 'lösenordé-test'.normalize('NFD')

    expect(composed).not.toBe(decomposed)

    const a = newPasswordSchema.parse(composed)
    const b = newPasswordSchema.parse(decomposed)
    expect(a).toBe(b)
  })
})

describe('createClientSchema', () => {
  test('accepts a valid client', () => {
    const result = createClientSchema.parse({
      email: 'ny@kund.se',
      name: 'Ny Kund AB',
      phone: '070-1234567',
      address: 'Storgatan 1'
    })
    expect(result.name).toBe('Ny Kund AB')
  })

  test('phone and address are optional', () => {
    expect(createClientSchema.safeParse({ email: 'a@b.se', name: 'X' }).success).toBe(true)
  })

  test('requires a name', () => {
    expect(createClientSchema.safeParse({ email: 'a@b.se', name: '' }).success).toBe(false)
    expect(createClientSchema.safeParse({ email: 'a@b.se' }).success).toBe(false)
  })

  test('🔒 silently strips a role field — privilege escalation is impossible', () => {
    const result = createClientSchema.parse({
      email: 'attacker@evil.se',
      name: 'Hacker',
      role: 'ADMIN'
    })
    expect('role' in result).toBe(false)
  })

  test('strips any other unknown key too', () => {
    const result = createClientSchema.parse({
      email: 'a@b.se',
      name: 'X',
      userId: 'someone-elses-id',
      id: 'hijacked'
    })
    expect(Object.keys(result).sort()).toEqual(['email', 'name'])
  })
})

describe('setPasswordSchema', () => {
  test('requires both a token and a policy-compliant password', () => {
    expect(setPasswordSchema.safeParse({ token: 'abc', password: 'kort' }).success).toBe(false)
    expect(setPasswordSchema.safeParse({ token: '', password: 'a'.repeat(20) }).success).toBe(false)
    expect(setPasswordSchema.safeParse({ token: 'abc', password: 'a'.repeat(20) }).success).toBe(true)
  })
})

describe('listQuerySchema', () => {
  test('coerces query strings to numbers', () => {
    const result = listQuerySchema.parse({ limit: '15', offset: '30' })
    expect(result.limit).toBe(15)
    expect(result.offset).toBe(30)
  })

  test('applies defaults when absent', () => {
    expect(listQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 })
  })

  test('caps limit at 100 — an uncapped limit is a free DoS', () => {
    expect(listQuerySchema.safeParse({ limit: '1000000' }).success).toBe(false)
    expect(listQuerySchema.safeParse({ limit: '101' }).success).toBe(false)
    expect(listQuerySchema.safeParse({ limit: '100' }).success).toBe(true)
  })

  test('rejects nonsense', () => {
    expect(listQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
    expect(listQuerySchema.safeParse({ offset: '-5' }).success).toBe(false)
    expect(listQuerySchema.safeParse({ limit: 'abc' }).success).toBe(false)
  })
})

describe('updateClientSchema', () => {
  test('every field is optional (it is a PATCH)', () => {
    expect(updateClientSchema.safeParse({ name: 'Bara namn' }).success).toBe(true)
    expect(updateClientSchema.safeParse({ address: 'Bara adress' }).success).toBe(true)
  })

  test('rejects a completely empty body', () => {
    // Otherwise "update" succeeds while doing nothing, and still writes an
    // audit row claiming a change happened.
    expect(updateClientSchema.safeParse({}).success).toBe(false)
  })

  test('allows clearing a nullable field', () => {
    expect(updateClientSchema.safeParse({ phone: null }).success).toBe(true)
  })

  test('does not accept email, userId or id', () => {
    const result = updateClientSchema.parse({
      name: 'X',
      email: 'attacker@evil.se',
      userId: 'someone-else',
      id: 'hijacked'
    })
    expect(Object.keys(result)).toEqual(['name'])
  })
})

describe('idParamSchema', () => {
  test('accepts a normal id', () => {
    expect(idParamSchema.safeParse({ id: 'clx1234567890' }).success).toBe(true)
  })

  test('rejects empty and absurdly long ids', () => {
    expect(idParamSchema.safeParse({ id: '' }).success).toBe(false)
    expect(idParamSchema.safeParse({ id: 'a'.repeat(100) }).success).toBe(false)
  })
})
