// timeout.test.ts — withTimeout, the guard behind the readiness check.

import { describe, test, expect } from 'bun:test'
import { withTimeout, TimeoutError } from '../../src/lib/timeout.ts'

describe('withTimeout', () => {
  test('passes the value through when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 100)).resolves.toBe(42)
  })

  test('passes the original error through when the work fails in time', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 100)).rejects.toThrow('boom')
  })

  test('rejects with TimeoutError when the work never settles', async () => {
    // A promise that never resolves: the exact shape of a query against a
    // paused database with no driver timeout.
    const never = new Promise<never>(() => {})
    const started = Date.now()

    await expect(withTimeout(never, 50)).rejects.toBeInstanceOf(TimeoutError)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
