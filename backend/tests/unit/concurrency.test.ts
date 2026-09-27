// concurrency.test.ts — the gate in front of Argon2id.

import { describe, test, expect } from 'bun:test'
import { BoundedConcurrency } from '../../src/lib/concurrency.ts'
import { ServiceBusyError } from '../../src/lib/errors.ts'

/** A task we finish by hand, so the test controls exactly when slots free up. */
function deferred() {
  let finish!: () => void
  const promise = new Promise<void>((resolve) => (finish = resolve))
  return { promise, finish }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('BoundedConcurrency', () => {
  test('runs at most maxActive at once', async () => {
    const gate = new BoundedConcurrency(2, 10)
    const tasks = [deferred(), deferred(), deferred()]
    const runs = tasks.map((t) => gate.run(() => t.promise))
    await tick()

    expect(gate.stats).toEqual({ active: 2, waiting: 1 })

    tasks.forEach((t) => t.finish())
    await Promise.all(runs)
    expect(gate.stats).toEqual({ active: 0, waiting: 0 })
  })

  test('waiters run in arrival order', async () => {
    const gate = new BoundedConcurrency(1, 10)
    const order: number[] = []
    const first = deferred()

    const runs = [
      gate.run(async () => {
        await first.promise
        order.push(1)
      }),
      gate.run(async () => void order.push(2)),
      gate.run(async () => void order.push(3))
    ]
    first.finish()
    await Promise.all(runs)

    expect(order).toEqual([1, 2, 3])
  })

  test('🔑 refuses with ServiceBusyError once the queue is full', async () => {
    const gate = new BoundedConcurrency(1, 1)
    const blocker = deferred()
    const running = gate.run(() => blocker.promise)
    const queued = gate.run(async () => 'queued ran')
    await tick()

    await expect(gate.run(async () => 'never')).rejects.toBeInstanceOf(ServiceBusyError)

    blocker.finish()
    await running
    expect(await queued).toBe('queued ran')
  })

  test('🔑 a task that throws still frees its slot', async () => {
    // A leaked slot would shrink capacity by one per failure until logins
    // stopped altogether.
    const gate = new BoundedConcurrency(1, 0)
    await expect(gate.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')

    expect(gate.stats).toEqual({ active: 0, waiting: 0 })
    expect(await gate.run(async () => 'next')).toBe('next')
  })
})
