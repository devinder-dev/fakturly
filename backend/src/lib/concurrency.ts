// concurrency.ts — a bounded gate for expensive work.
//
// Argon2id is slow and memory-hard on purpose (19 MiB and ~50 ms per hash on
// a laptop, far more on a shared free-tier CPU). That cost is the defence
// against offline cracking — and, unbounded, an invitation to online DoS:
// a burst of login attempts queues without limit and every other request
// waits behind it. The per-IP rate limit does not help against many IPs.
//
// So: at most `maxActive` run at once, at most `maxWaiting` queue behind
// them, and anything beyond that is turned away immediately. A fast "busy,
// retry in a moment" keeps the rest of the API responsive; a queue that
// grows forever does not.

import { ServiceBusyError } from './errors.ts'

export class BoundedConcurrency {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(
    private readonly maxActive: number,
    private readonly maxWaiting: number
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxActive) {
      if (this.waiting.length >= this.maxWaiting) {
        throw new ServiceBusyError(1)
      }
      // Wait for a finishing task to hand its slot over (see finally below).
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    } else {
      this.active++
    }

    try {
      return await work()
    } finally {
      // Hand the slot straight to the next waiter rather than releasing it:
      // `active` stays the same, and no newcomer can jump the queue in between.
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }

  /** For tests and diagnostics. */
  get stats(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting.length }
  }
}
