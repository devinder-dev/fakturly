// loginAttempts.service.ts — lager 2: begränsning per KONTO.
//
// Fångar det per-IP missar: password spraying. En angripare tar ett vanligt
// lösenord ("Sommar2026!") och testar det EN gång mot 50 000 konton. Varje
// konto ser ett misslyckat försök, varje IP i botnätet ser en handfull.
// Ingen per-IP-räknare slår till. En per-konto-räknare gör det.
//
// ── Den subtila fällan ───────────────────────────────────────────
// Vi räknar försök för VARJE inskickad e-postadress — även adresser som
// inte finns. Räknade vi bara riktiga konton skulle en existerande adress
// bli långsammare och långsammare medan en okänd svarar direkt. Den
// skillnaden är exakt den enumeration vi byggde bort i steg 1.
//
// Tar en service emot `request`? Nej. Den tar vanliga argument, så att
// samma logik går att anropa från en BullMQ-worker eller ett test.

import { createHash } from 'node:crypto'
import { redis } from '../lib/redis.ts'
import { RateLimitError } from '../lib/errors.ts'

/** Fönstret som misslyckade försök räknas inom. */
const WINDOW_SECONDS = 15 * 60 // 15 minuter

/** Antal misslyckanden innan kontot spärras för resten av fönstret. */
export const MAX_ATTEMPTS = 5

/** De två första försöken är gratis — folk skriver fel ibland. */
const FREE_ATTEMPTS = 2

/** Basfördröjning. Växer sedan med faktor 4 per försök. */
const DELAY_BASE_MS = 100

/** Tak på fördröjningen, annars binder vi upp våra egna anslutningar. */
const DELAY_MAX_MS = 5000

/**
 * Nyckeln innehåller en HASH av e-postadressen, inte adressen själv.
 *
 * Två skäl: vi vill inte strö kundernas e-postadresser över Redis (som
 * kan dumpas, loggas eller inspekteras), och en hash har alltid samma
 * längd — någon kan annars skicka in en 900 tecken lång "adress".
 */
function attemptsKey(email: string): string {
  const digest = createHash('sha256').update(email.toLowerCase()).digest('hex')
  return `fakturly:login:fail:${digest.slice(0, 32)}`
}

/**
 * Progressiv fördröjning — bankernas riktiga lösning.
 *
 * Försök 1-2: 0 ms       (skrivfel ska inte straffas)
 * Försök 3:   100 ms
 * Försök 4:   400 ms
 * Försök 5:   1600 ms
 * ... upp till taket
 *
 * Varför inte bara spärra direkt? För att ren utelåsning är en
 * självförvållad DoS: vem som helst kan låsa DIG ute från ditt konto
 * genom att medvetet gissa fel fem gånger. Fördröjningen gör brute force
 * praktiskt omöjlig långt innan spärren behövs — 1000 gissningar tar
 * dagar istället för sekunder — utan att ge angriparen ett vapen.
 */
export function progressiveDelayMs(failedAttempts: number): number {
  if (failedAttempts <= FREE_ATTEMPTS) return 0
  const step = failedAttempts - FREE_ATTEMPTS - 1
  return Math.min(DELAY_BASE_MS * 4 ** step, DELAY_MAX_MS)
}

export async function getFailedAttempts(email: string): Promise<number> {
  const value = await redis.get(attemptsKey(email))
  return value === null ? 0 : Number.parseInt(value, 10) || 0
}

/**
 * Räknar upp ett misslyckat försök och returnerar den nya summan.
 *
 * INCR + EXPIRE i en pipeline = en enda tur- och returresa till Redis
 * istället för två. Vi sätter EXPIRE varje gång, så fönstret glider
 * framåt: fortsätter någon att gissa förblir kontot skyddat.
 */
export async function recordFailedAttempt(email: string): Promise<number> {
  const key = attemptsKey(email)
  const results = await redis.multi().incr(key).expire(key, WINDOW_SECONDS).exec()

  // exec() ger [[err, value], ...]. Första posten är INCR-resultatet.
  const incrResult = results?.[0]
  if (!incrResult || incrResult[0]) return 0
  return Number(incrResult[1]) || 0
}

/** Nollställs vid lyckad inloggning — annars låser gamla fel ute en giltig användare. */
export async function clearFailedAttempts(email: string): Promise<void> {
  await redis.del(attemptsKey(email))
}

/**
 * Kastar RateLimitError om kontot har för många misslyckade försök.
 * Anropas FÖRST i inloggningsflödet, innan vi ens rör databasen.
 *
 * Att svara 429 här läcker ingenting: vi räknar okända adresser också,
 * så en angripare kan inte skilja "spärrat konto" från "spärrad gissning
 * mot en adress som aldrig funnits".
 */
export async function assertAccountNotLocked(email: string): Promise<void> {
  const attempts = await getFailedAttempts(email)
  if (attempts < MAX_ATTEMPTS) return

  const ttl = await redis.ttl(attemptsKey(email))
  throw new RateLimitError(ttl > 0 ? ttl : WINDOW_SECONDS)
}

/**
 * Väntar den progressiva fördröjningen ut.
 *
 * Anropas på misslyckad inloggning INNAN svaret skickas, så att
 * angriparens verktyg faktiskt tvingas vänta.
 */
export async function applyProgressiveDelay(failedAttempts: number): Promise<void> {
  const delay = progressiveDelayMs(failedAttempts)
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
}
