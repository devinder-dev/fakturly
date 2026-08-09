// hibp.ts — checks whether a password appears in known data breaches.
// Uses the HaveIBeenPwned "range" API (~1 billion leaked passwords).
//
// ── k-anonymity: how we ask without revealing the password ───────
//
// The naive approach would be to send the password (or its hash) to HIBP and
// ask "does this exist?". Then HIBP knows exactly what our user's password
// is. Unacceptable.
//
// Instead:
//   1. Hash the password with SHA-1  -> 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
//   2. Send ONLY the first 5 chars   -> "5BAA6"
//   3. HIBP returns ALL ~800 hashes starting with that prefix, with counts
//   4. We look for our suffix LOCALLY in that list
//
// So HIBP sees "someone asked about 5BAA6" — which matches hundreds of
// different passwords. They cannot possibly tell which one was ours.
// The password, and even the full hash, never leaves our server.
//
// ── "But isn't SHA-1 broken?" ────────────────────────────────────
//
// Yes — for STORAGE and signatures. Here SHA-1 is not a security control but
// a lookup key format: it is simply how HIBP's database is indexed. Collision
// resistance is irrelevant when looking something up in a public list. Our
// actual passwords are stored with Argon2id.

import { createHash } from 'node:crypto'

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range'

// A network call must never hang a login. 3 seconds is plenty for an API
// that normally answers in under 200 ms.
const TIMEOUT_MS = 3000

export type BreachCheckResult = {
  /** true = the password appears in at least one known breach */
  breached: boolean
  /** How many times it has been seen in breaches. 0 if unknown or on error. */
  count: number
  /** true = the check could not be performed (network error / timeout) */
  checkFailed: boolean
}

/**
 * Checks a password against HIBP.
 *
 * IMPORTANT: pass the password NFKC-normalised (the same string that will be
 * hashed with Argon2id). Otherwise we are checking a different string from
 * the one we actually store.
 */
export async function isPasswordBreached(
  password: string
): Promise<BreachCheckResult> {
  // HIBP's database is indexed in uppercase.
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase()
  const prefix = sha1.slice(0, 5)
  const suffix = sha1.slice(5)

  try {
    const response = await fetch(`${HIBP_RANGE_URL}/${prefix}`, {
      headers: {
        // Add-Padding makes HIBP pad the response with random entries (always
        // with count 0). Without it, the SIZE of the response reveals roughly
        // how many breached passwords share the prefix — something an
        // attacker watching the traffic could infer from. Padding makes all
        // responses roughly the same size.
        'Add-Padding': 'true',
        'User-Agent': 'Fakturly-Invoicing-App'
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })

    if (!response.ok) {
      return { breached: false, count: 0, checkFailed: true }
    }

    const body = await response.text()

    // Response format, one entry per line:
    //   "1E4C9B93F3F0682250B6CF8331B7EE68FD8:24230577"
    for (const line of body.split('\n')) {
      const separatorIndex = line.indexOf(':')
      if (separatorIndex === -1) continue

      const lineSuffix = line.slice(0, separatorIndex).trim()
      if (lineSuffix !== suffix) continue

      const count = Number.parseInt(line.slice(separatorIndex + 1).trim(), 10)
      // Padding entries always have count 0 — filtered out here.
      if (Number.isFinite(count) && count > 0) {
        return { breached: true, count, checkFailed: false }
      }
    }

    return { breached: false, count: 0, checkFailed: false }
  } catch {
    // ── Fail open, deliberately ──────────────────────────────────
    // If HIBP is down we allow the password rather than blocking it. The
    // alternative (fail closed) would mean nobody can set a password while a
    // third-party service has an outage — we would have outsourced our own
    // availability to someone else.
    //
    // The caller receives checkFailed: true and SHOULD log it. Many failures
    // in a row means the protection is down, and we want to know.
    return { breached: false, count: 0, checkFailed: true }
  }
}
