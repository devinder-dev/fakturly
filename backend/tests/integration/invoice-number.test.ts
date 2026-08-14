// invoice-number.test.ts — the unbroken series required by bokföringslagen.

import { describe, test, expect, afterAll } from 'bun:test'
import {
  allocateInvoiceNumber,
  peekLastNumber
} from '../../src/repositories/invoiceNumber.repository.ts'
import { prisma } from '../helpers.ts'

// Far-future years, so tests cannot collide with real invoice data.
const YEAR_A = 9001
const YEAR_B = 9002
const YEAR_C = 9003

afterAll(async () => {
  await prisma.invoiceNumberSeries.deleteMany({
    where: { year: { in: [YEAR_A, YEAR_B, YEAR_C] } }
  })
})

describe('format', () => {
  test('starts at 0001 and increments', async () => {
    await prisma.invoiceNumberSeries.deleteMany({ where: { year: YEAR_A } })

    expect(await allocateInvoiceNumber(YEAR_A)).toBe('9001-0001')
    expect(await allocateInvoiceNumber(YEAR_A)).toBe('9001-0002')
    expect(await allocateInvoiceNumber(YEAR_A)).toBe('9001-0003')
  })

  test('is zero-padded to four digits', async () => {
    await prisma.invoiceNumberSeries.deleteMany({ where: { year: YEAR_B } })
    expect(/^\d{4}-\d{4}$/.test(await allocateInvoiceNumber(YEAR_B))).toBe(true)
  })
})

describe('🎯 concurrency — the race that only appears at month end', () => {
  test('50 parallel allocations produce 50 distinct numbers', async () => {
    await prisma.invoiceNumberSeries.deleteMany({ where: { year: YEAR_A } })

    const numbers = await Promise.all(
      Array.from({ length: 50 }, () => allocateInvoiceNumber(YEAR_A))
    )

    expect(new Set(numbers).size).toBe(50)
    // A read-then-write would let two requests both read 7 and both write 8:
    // one number, two invoices. It only shows under load.
  })

  test('and they form an unbroken 1..50 run', async () => {
    await prisma.invoiceNumberSeries.deleteMany({ where: { year: YEAR_A } })

    const numbers = await Promise.all(
      Array.from({ length: 50 }, () => allocateInvoiceNumber(YEAR_A))
    )
    const sequence = numbers.map((n) => Number(n.split('-')[1])).sort((a, b) => a - b)

    expect(sequence).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(await peekLastNumber(YEAR_A)).toBe(50)
  })
})

describe('years are independent', () => {
  test('a new year restarts at 0001', async () => {
    await prisma.invoiceNumberSeries.deleteMany({ where: { year: { in: [YEAR_B, YEAR_C] } } })

    await allocateInvoiceNumber(YEAR_B)
    await allocateInvoiceNumber(YEAR_B)

    expect(await allocateInvoiceNumber(YEAR_C)).toBe('9003-0001')
    expect(await peekLastNumber(YEAR_B)).toBe(2)
  })
})

describe('peekLastNumber', () => {
  test('is 0 for a year with no invoices', async () => {
    await prisma.invoiceNumberSeries.deleteMany({ where: { year: YEAR_C } })
    expect(await peekLastNumber(YEAR_C)).toBe(0)
  })
})
