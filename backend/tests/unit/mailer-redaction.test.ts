// mailer-redaction.test.ts — what the console mail transport may print.

import { describe, test, expect } from 'bun:test'
import { printableBody } from '../../src/lib/mailer.ts'

const BODY = 'Välj ditt lösenord här:\nhttps://app.example.com/set-password#token=Zm9vYmFyLXNlY3JldA\n\nHälsningar'

describe('printableBody', () => {
  test('🔑 production: the set-password token never reaches the log', () => {
    const printed = printableBody(BODY, true)
    expect(printed).not.toContain('Zm9vYmFyLXNlY3JldA')
    expect(printed).toContain('set-password#token=[REDACTED]')
    expect(printed).toContain('Hälsningar')
  })

  test('also covers an old-style ?token= link and several tokens', () => {
    const printed = printableBody('a ?token=one&x=1 b #token=two', true)
    expect(printed).toBe('a ?token=[REDACTED]&x=1 b #token=[REDACTED]')
  })

  test('development: printed in full, because the log IS how a local invite gets finished', () => {
    expect(printableBody(BODY, false)).toBe(BODY)
  })
})
