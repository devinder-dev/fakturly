// hibp.ts — kontrollerar om ett lösenord finns i kända dataläckor.
// Använder HaveIBeenPwned:s "range"-API (~1 miljard läckta lösenord).
//
// ── k-anonymitet: hur vi frågar utan att avslöja lösenordet ──────
//
// Naiva sättet vore att skicka lösenordet (eller dess hash) till HIBP och
// fråga "finns detta?". Då vet HIBP exakt vilket lösenord vår användare har.
// Oacceptabelt.
//
// Istället:
//   1. Hasha lösenordet med SHA-1        -> 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
//   2. Skicka BARA de 5 första tecknen   -> "5BAA6"
//   3. HIBP svarar med ALLA ~800 hashar som börjar så, med antal läckor
//   4. Vi letar efter vår ändelse LOKALT i den listan
//
// HIBP ser alltså "någon frågade om 5BAA6" — vilket matchar hundratals
// olika lösenord. De kan omöjligt veta vilket som var vårt.
// Lösenordet, och till och med hela hashen, lämnar aldrig vår server.
//
// ── "Men SHA-1 är ju osäkert?" ──────────────────────────────────
//
// Ja — för LAGRING och signaturer. Här används SHA-1 inte som skydd utan
// som ett uppslagsnyckel-format: det är helt enkelt det format HIBP:s
// databas är indexerad i. Kollisionsresistens spelar ingen roll när man
// slår upp i en publik lista. Våra riktiga lösenord lagras med Argon2id.

import { createHash } from 'node:crypto'

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range'

// Nätverksanrop får inte hänga en inloggning. 3 sekunder är gott om tid
// för ett API som normalt svarar på under 200 ms.
const TIMEOUT_MS = 3000

export type BreachCheckResult = {
  /** true = lösenordet finns i minst en känd läcka */
  breached: boolean
  /** Antal gånger lösenordet setts i läckor. 0 om okänt eller vid fel. */
  count: number
  /** true = kontrollen kunde inte utföras (nätverksfel/timeout) */
  checkFailed: boolean
}

/**
 * Kontrollerar ett lösenord mot HIBP.
 *
 * VIKTIGT: skicka in lösenordet NFKC-normaliserat (samma sträng som
 * kommer att hashas med Argon2id). Annars kontrollerar vi en annan
 * sträng än den vi faktiskt sparar.
 */
export async function isPasswordBreached(
  password: string
): Promise<BreachCheckResult> {
  // HIBP:s databas är indexerad på versaler.
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase()
  const prefix = sha1.slice(0, 5)
  const suffix = sha1.slice(5)

  try {
    const response = await fetch(`${HIBP_RANGE_URL}/${prefix}`, {
      headers: {
        // Add-Padding får HIBP att fylla svaret med slumpmässiga poster
        // (alltid med count 0). Utan det avslöjar svarets STORLEK ungefär
        // hur många läckta lösenord som delar prefixet — en angripare som
        // avlyssnar trafiken kan gissa utifrån det. Padding gör alla svar
        // ungefär lika stora.
        'Add-Padding': 'true',
        'User-Agent': 'Fakturly-Invoicing-App'
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })

    if (!response.ok) {
      return { breached: false, count: 0, checkFailed: true }
    }

    const body = await response.text()

    // Svarsformat, en post per rad:  "1E4C9B93F3F0682250B6CF8331B7EE68FD8:24230577"
    for (const line of body.split('\n')) {
      const separatorIndex = line.indexOf(':')
      if (separatorIndex === -1) continue

      const lineSuffix = line.slice(0, separatorIndex).trim()
      if (lineSuffix !== suffix) continue

      const count = Number.parseInt(line.slice(separatorIndex + 1).trim(), 10)
      // Padding-poster har alltid count 0 — de filtreras bort här.
      if (Number.isFinite(count) && count > 0) {
        return { breached: true, count, checkFailed: false }
      }
    }

    return { breached: false, count: 0, checkFailed: false }
  } catch {
    // ── Fail open, med flit ──────────────────────────────────────
    // Går HIBP ner släpper vi igenom lösenordet istället för att blockera
    // det. Alternativet (fail closed) skulle innebära att ingen kan sätta
    // ett lösenord när en tredjepartstjänst har driftstörning — vi hade
    // outsourcat vår egen tillgänglighet till någon annan.
    //
    // Anroparen får checkFailed: true och SKA logga det. Många fel i rad
    // betyder att skyddet är nere, och det vill vi veta.
    return { breached: false, count: 0, checkFailed: true }
  }
}
