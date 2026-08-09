// plugins/rateLimit.ts — lager 1: begränsning per IP-adress.
//
// Varför Redis och inte minnet?
//   - Minnet nollställs vid varje deploy. En angripare som får 5 försök
//     per minut får plötsligt 5 nya direkt efter en omstart.
//   - Kör vi tre instanser bakom en lastbalanserare har varje instans sin
//     egen räknare — alltså 15 försök per minut istället för 5.
// Redis ger EN delad räknare som överlever både omstart och utskalning.
//
// OBS: detta är bara halva skyddet. Per-IP fångar klassisk brute force
// (ett konto, många lösenord) men missar password spraying (ett lösenord,
// tusentals konton) — där varje IP och varje konto ser få försök.
// Lager 2 (services/loginAttempts.service.ts) täcker det.

import fp from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance } from 'fastify'
import { RateLimitError } from '../lib/errors.ts'

async function rateLimitPlugin(app: FastifyInstance) {
  await app.register(rateLimit, {
    // Redis-backad räknare. Vi återanvänder appens befintliga anslutning.
    redis: app.redis,

    // Prefix så att rate limit-nycklar inte krockar med jti-denylistan
    // eller BullMQ:s nycklar i samma Redis.
    nameSpace: 'fakturly:rl:',

    // Generöst globalt tak. Enskilda auth-rutter sätter mycket hårdare
    // gränser själva via sin route-config.
    global: true,
    max: 100,
    timeWindow: '1 minute',

    // Nyckeln är klientens IP. request.ip respekterar X-Forwarded-For
    // endast när trustProxy är på — vilket vi satt i produktion. Utan det
    // skulle alla bakom en proxy dela EN räknare och låsa varandra ute.
    keyGenerator: (request) => request.ip,

    // Plugin-et KASTAR det som errorResponseBuilder returnerar. Returnerar
    // vi ett vanligt objekt saknar det statusCode, och vår centrala
    // felhanterare tolkar det som en okänd bugg -> 500 istället för 429.
    //
    // Genom att returnera ett riktigt RateLimitError går det genom exakt
    // samma väg som alla andra domänfel: rätt status, vårt felformat,
    // requestId och Retry-After-headern — allt på ett ställe.
    errorResponseBuilder: (_request, context) => {
      throw new RateLimitError(Math.ceil(context.ttl / 1000))
    },

    // Skicka med hur många försök som återstår redan INNAN taket nås.
    // En ärlig klient kan då sakta ner självmant.
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true
    }
  })
}

export default fp(rateLimitPlugin, { name: 'rateLimit', dependencies: ['redis'] })

// ─────────────────────────────────────────────────────────────
// Färdiga konfigurationer att hänga på enskilda rutter.
//
// Används så här i en route:
//   app.post('/auth/login', { config: { rateLimit: LOGIN_RATE_LIMIT } }, handler)
// ─────────────────────────────────────────────────────────────

/** Inloggning: 5 försök per minut per IP. */
export const LOGIN_RATE_LIMIT = {
  max: 5,
  timeWindow: '1 minute'
} as const

/**
 * Token-förnyelse: generösare. En legitim klient med flera flikar öppna
 * kan förnya oftare än man tror, och en refresh token är redan skyddad
 * av rotation och stöldupptäckt.
 */
export const REFRESH_RATE_LIMIT = {
  max: 20,
  timeWindow: '1 minute'
} as const

/**
 * Att sätta lösenord: dyrt för oss (Argon2id + HIBP-anrop), så taket är lågt.
 */
export const SET_PASSWORD_RATE_LIMIT = {
  max: 5,
  timeWindow: '15 minutes'
} as const
