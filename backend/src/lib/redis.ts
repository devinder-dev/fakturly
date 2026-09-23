// redis.ts — ONE Redis connection for the whole process.
//
// What do we use Redis for in Fakturly?
//   1. Denylist for logged-out JWTs (revocable sessions)
//   2. Rate limiting — counting requests per IP
//   3. Job queue with BullMQ (week 3)
//
// Why ioredis and not Bun.redis? ioredis is what BullMQ requires, so we avoid
// having two different Redis libraries in the same project.
//
// NOTE for week 3: BullMQ must NOT share this connection. Workers block the
// connection while waiting for jobs, and BullMQ requires
// maxRetriesPerRequest: null. We will create a separate connection for it.

import Redis from 'ioredis'
import { env } from './env.ts'

export const redis = new Redis(env.REDIS_URL, {
  // How many times a command is retried before it throws.
  // We would rather get a clear error quickly than have a request hang.
  maxRetriesPerRequest: 3,

  // Every request passes the rate limiter, which talks to Redis — so a slow
  // Redis is a slow API. Without these, a Redis outage made each request
  // wait out ioredis' reconnect cycle (30-40 s) before failing.
  //   connectTimeout  give up on a TCP connect after 3 s (default 10 s)
  //   commandTimeout  reject a command with no reply after 2 s. It also
  //                   covers commands queued while disconnected, so an
  //                   outage fails fast instead of piling up requests.
  // Safe on THIS connection only: nothing here issues blocking commands.
  // BullMQ's connections (jobs/queues.ts) block by design and must not
  // get a commandTimeout.
  connectTimeout: 3_000,
  commandTimeout: 2_000,

  // Backoff: wait longer and longer between reconnection attempts, capped at
  // 2 seconds. Without a cap we end up in a tight loop hammering a Redis
  // instance that is down.
  retryStrategy: (times: number) => Math.min(times * 200, 2000)
})
