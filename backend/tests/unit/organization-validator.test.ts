// organization-validator.test.ts — normalising and checking an organization's
// Swedish identifiers. No database: these are pure functions.

import { describe, test, expect } from 'bun:test'
import {
  createOrganizationSchema,
  orgNumberSchema,
  bankgiroSchema,
  vatNumberSchema
} from '../../src/validators/organization.validator.ts'

const base = {
  name: 'Exempel AB',
  orgNumber: '556677-8899',
  address: 'Storgatan 1, 111 22 Stockholm',
  email: 'faktura@exempel.se'
}

describe('organisationsnummer', () => {
  test.each([
    ['5566778899', '556677-8899'],
    ['556677-8899', '556677-8899'],
    [' 556677 8899 ', '556677-8899']
  ])('%p is stored as %p', (input, stored) => {
    expect(orgNumberSchema.parse(input)).toBe(stored)
  })

  test.each(['556677-889', '55667788990', '55667A-8899', ''])('%p is rejected', (input) => {
    expect(orgNumberSchema.safeParse(input).success).toBe(false)
  })
})

describe('momsregistreringsnummer', () => {
  test('is stored uppercase without spaces', () => {
    expect(vatNumberSchema.parse('se 5566778899 01')).toBe('SE556677889901')
  })

  test('must belong to the same organisationsnummer', () => {
    const result = createOrganizationSchema.safeParse({ ...base, vatNumber: 'SE112233445501' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['vatNumber'])
  })

  test('a malformed one gets ONE message — the format, not a misleading mismatch', () => {
    const result = createOrganizationSchema.safeParse({ ...base, vatNumber: 'SE5566-77889901' })
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'Ogiltigt momsregistreringsnummer'
    ])
  })

  test('a matching one passes, however the org number was written', () => {
    const result = createOrganizationSchema.parse({
      ...base,
      orgNumber: '5566778899',
      vatNumber: 'SE556677889901'
    })
    expect(result.vatNumber).toBe('SE556677889901')
  })

  test('is optional — not every business is VAT-registered', () => {
    expect(createOrganizationSchema.parse(base).vatNumber).toBeUndefined()
  })
})

describe('bankgiro', () => {
  test.each([
    ['1234567', '123-4567'],
    ['5050-1055', '5050-1055'],
    ['50501055', '5050-1055']
  ])('%p is stored as %p', (input, stored) => {
    expect(bankgiroSchema.parse(input)).toBe(stored)
  })

  test.each(['123456', '123456789', '12a-4567'])('%p is rejected', (input) => {
    expect(bankgiroSchema.safeParse(input).success).toBe(false)
  })
})

describe('the rest of the organization', () => {
  test('F-skatt defaults to true and payment terms to 30 days', () => {
    const result = createOrganizationSchema.parse(base)
    expect(result.fSkatt).toBe(true)
    expect(result.paymentTermsDays).toBe(30)
  })

  test('the email is normalised like a login email', () => {
    expect(createOrganizationSchema.parse({ ...base, email: ' Faktura@Exempel.SE ' }).email).toBe(
      'faktura@exempel.se'
    )
  })

  test.each([
    ['address', { address: '   ' }],
    ['name', { name: '' }],
    ['paymentTermsDays', { paymentTermsDays: 1.5 }],
    ['paymentTermsDays', { paymentTermsDays: -1 }]
  ])('rejects a bad %s', (_field, override) => {
    expect(createOrganizationSchema.safeParse({ ...base, ...override }).success).toBe(false)
  })
})
