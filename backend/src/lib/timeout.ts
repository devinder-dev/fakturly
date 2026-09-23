// timeout.ts — race a promise against a clock.
//
// For the few places that must answer within a bound even when a dependency
// does not (the readiness check). It does NOT cancel the losing work — a
// promise cannot be cancelled from outside — it only stops the caller from
// waiting for it. The driver timeouts in prisma.ts and redis.ts are what
// actually end a stuck query or command.

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms} ms`)
    this.name = 'TimeoutError'
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const clock = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms)
  })
  try {
    return await Promise.race([promise, clock])
  } finally {
    // Clear the timer when the real work wins, or every fast call would
    // leave a pending timer behind until it fires.
    clearTimeout(timer)
  }
}
