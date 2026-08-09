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

  // Backoff: wait longer and longer between reconnection attempts, capped at
  // 2 seconds. Without a cap we end up in a tight loop hammering a Redis
  // instance that is down.
  retryStrategy: (times: number) => Math.min(times * 200, 2000)
})
