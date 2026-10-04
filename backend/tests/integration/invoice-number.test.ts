// invoice-number.test.ts — the unbroken series required by bokföringslagen.
//
// One series per organization and year (ADR 56): every allocation below
// names the organization, and the last block proves two organizations never
// share a counter.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  allocateInvoiceNumber,
  peekLastNumber
} from '../../src/repositories/invoiceNumber.repository.ts'
import { createTestOrganization, cleanupOrganizations, prisma } from '../helpers.ts'

// Far-future years, so tests cannot collide with real invoice data.
const YEAR_A = 9001
const YEAR_B = 9002
const YEAR_C = 9003

let org: string
let otherOrg: string

beforeAll(async () => {
  org = (await createTestOrganization()).id
  otherOrg = (await createTestOrganization('Annat Bolag AB')).id
})

afterAll(async () => {
  // Removes both organizations' series rows too.
  await cleanupOrganizations([org, otherOrg])
})

describe('format', () => {
  test('starts at 0001 and increments', async () => {
    await prisma.invoiceNumberSeries.deleteMany({ where: { organizationId: org, year: YEAR_A } })

    expect(await allocateInvoiceNumber(org, YEAR_A)).toBe('9001-0001')
    expect(await allocateInvoiceNumber(org, YEAR_A)).toBe('9001-0002')
    expect(await allocateInvoiceNumber(org, YEAR_A)).toBe('9001-0003')
  })

  test('is zero-padded to four digits', async () => {
    await prisma.invoiceNumberSeries.deleteMany({ where: { organizationId: org, year: YEAR_B } })
    expect(/^\d{4}-\d{4}$/.test(await allocateInvoiceNumber(org, YEAR_B))).toBe(true)
  })
})

describe('🎯 concurrency — the race that only appears at month end', () => {
  test('50 parallel allocations produce 50 distinct numbers', async () => {
    await prisma.invoiceNumberSeries.deleteMany({ where: { organizationId: org, year: YEAR_A } })

    const numbers = await Promise.all(
      Array.from({ length: 50 }, () => allocateInvoiceNumber(org, YEAR_A))
    )

    expect(new Set(numbers).size).toBe(50)
    // A read-then-write would let two requests both read 7 and both write 8:
    // one number, two invoices. It only shows under load.
  })

  test('and they form an unbroken 1..50 run', async () => {
    await prisma.invoiceNumberSeries.deleteMany({ where: { organizationId: org, year: YEAR_A } })

    const numbers = await Promise.all(
      Array.from({ length: 50 }, () => allocateInvoiceNumber(org, YEAR_A))
    )
    const sequence = numbers.map((n) => Number(n.split('-')[1])).sort((a, b) => a - b)

    expect(sequence).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(await peekLastNumber(org, YEAR_A)).toBe(50)
  })
})

describe('years are independent', () => {
  test('a new year restarts at 0001', async () => {
    await prisma.invoiceNumberSeries.deleteMany({ where: { organizationId: org, year: { in: [YEAR_B, YEAR_C] } } })

    await allocateInvoiceNumber(org, YEAR_B)
    await allocateInvoiceNumber(org, YEAR_B)

    expect(await allocateInvoiceNumber(org, YEAR_C)).toBe('9003-0001')
    expect(await peekLastNumber(org, YEAR_B)).toBe(2)
  })
})

describe('peekLastNumber', () => {
  test('is 0 for a year with no invoices', async () => {
    await prisma.invoiceNumberSeries.deleteMany({ where: { organizationId: org, year: YEAR_C } })
    expect(await peekLastNumber(org, YEAR_C)).toBe(0)
  })
})

describe('🏢 organizations never share a series', () => {
  test('each starts at 0001, and allocating in one does not move the other', async () => {
    await prisma.invoiceNumberSeries.deleteMany({
      where: { organizationId: { in: [org, otherOrg] }, year: YEAR_C }
    })

    expect(await allocateInvoiceNumber(org, YEAR_C)).toBe('9003-0001')
    expect(await allocateInvoiceNumber(org, YEAR_C)).toBe('9003-0002')
    // The law wants an unbroken series per BUSINESS. A shared counter would
    // give this organization 9003-0003 — and both of them holes that are
    // really the other's invoices.
    expect(await allocateInvoiceNumber(otherOrg, YEAR_C)).toBe('9003-0001')
    expect(await peekLastNumber(org, YEAR_C)).toBe(2)
  })
})
