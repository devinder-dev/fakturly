// redis.ts — EN Redis-anslutning för hela processen.
//
// Vad använder vi Redis till i Fakturly?
//   1. Denylist för utloggade JWT-tokens (revocable sessions)
//   2. Rate limiting — räknar requests per IP
//   3. Jobbkö med BullMQ (vecka 3)
//
// Varför ioredis och inte Bun.redis? ioredis är vad BullMQ kräver, så vi
// slipper två olika Redis-bibliotek i samma projekt.
//
// OBS inför vecka 3: BullMQ ska INTE dela den här anslutningen. Workers
// blockerar anslutningen medan de väntar på jobb, och BullMQ kräver
// maxRetriesPerRequest: null. Vi skapar en egen anslutning åt BullMQ då.

import Redis from 'ioredis'
import { env } from './env.ts'

export const redis = new Redis(env.REDIS_URL, {
  // Hur många gånger ett kommando görs om innan det kastar fel.
  // Vi vill hellre få ett tydligt fel snabbt än att en request hänger.
  maxRetriesPerRequest: 3,

  // Backoff: vänta längre och längre mellan återanslutningsförsök,
  // max 2 sekunder. Utan tak hamnar vi i en tight loop som spammar
  // en nedsläckt Redis med anslutningsförsök.
  retryStrategy: (times: number) => Math.min(times * 200, 2000)
})
