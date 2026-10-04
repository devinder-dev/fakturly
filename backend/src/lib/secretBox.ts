// secretBox.ts — authenticated encryption for secrets we must read back.
//
// HASH OR ENCRYPT? Passwords and refresh tokens are hashed: we only ever
// compare them. A TOTP secret (wave 2) or a Fortnox OAuth token (wave 4)
// has to be USED, so it must be decryptable — and the key must live
// outside the database, so a database dump alone reveals nothing.
//
// AES-256-GCM, from node:crypto. GCM is authenticated: besides hiding the
// plaintext it produces a 16-byte tag, and decryption refuses anything that
// changed by a single bit. It is the AEAD both node:crypto and WebCrypto
// ship, so there is no dependency and the output is portable (the tests
// decrypt it with WebCrypto to prove it).
//
// FORMAT:  v1:<iv>:<ciphertext>:<tag>      each part base64url, no padding
//
//   v1   key id, FIRST — it says which key sealed this row, which is what
//        makes rotation possible: add v2, make it current, old rows still
//        open with v1, needsReseal() finds them, re-seal, then drop v1.
//   iv   12 random bytes, new for every seal. NIST SP 800-38D §8: IV
//        uniqueness "is almost as important as the secrecy of the key" — a
//        repeated IV under one key leaks the XOR of two plaintexts and lets
//        an attacker forge tags. Random 96-bit IVs are safe for at most 2^32
//        seals per key (§8.3); rotation resets the count.
//   tag  16 bytes, always.
//
// AAD IS REQUIRED. "Additional authenticated data" is context that is not
// encrypted but IS covered by the tag — e.g. 'totp-secret:user:<id>'. It
// binds a ciphertext to its row: someone with write access to the database
// who copies user A's sealed secret into user B's row gets AUTH_FAILED,
// not B logging in with A's authenticator. It is a required, non-empty
// argument because optional security parameters get forgotten.
//
// What the AAD does NOT stop: putting an OLDER sealed value back into the
// SAME row (from a backup, say) — the context still matches. If a value is
// ever replaced for security reasons (a TOTP re-enrolment after a stolen
// phone), put something that changes with it into the AAD, e.g.
// 'totp-secret:user:<id>:enrolment:<n>', so the old value stops opening.
//
// TRAPS — each verified on Bun 1.3.14 on 2026-10-04:
//   1. Without { authTagLength: 16 }, decryption ACCEPTS a truncated tag:
//      the first 4 bytes of a real tag open the ciphertext (only a DEP0182
//      warning is printed). Forgery odds go from 2^-128 to 2^-32. We pass
//      authTagLength AND check the tag is exactly 16 bytes before decrypting.
//   2. decipher.update() returns plaintext BEFORE the tag is checked —
//      with a wrong tag, update() alone happily returns the text. Only
//      final() authenticates. Nothing is returned until final() succeeds.
//   3. Buffer.from(garbage, 'base64') never throws: '!!!not base64!!!'
//      decodes to 6 bytes. Every part must survive decode → re-encode
//      unchanged, and the IV and tag must have exact lengths.
//
// Keys are held as KeyObjects inside a closure: they are not properties of
// the returned box, and a KeyObject prints as SecretKeyObject with no key
// bytes — logging the box or a key cannot leak one.
//
// SOURCES:
//   NIST SP 800-38D (GCM): https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf
//   Node.js DEP0182 (short GCM tags): https://nodejs.org/api/deprecations.html#DEP0182
//
// No env import (config arrives as arguments — env wiring is wave 2).
// Generate a key with: openssl rand -base64 32

import { createCipheriv, createDecipheriv, createSecretKey, randomBytes, type KeyObject } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_ID = /^v\d{1,6}$/

export type SecretBoxErrorCode = 'MALFORMED' | 'UNKNOWN_KEY' | 'AUTH_FAILED'

const MESSAGES: Record<SecretBoxErrorCode, string> = {
  MALFORMED: 'Sealed value is malformed',
  UNKNOWN_KEY: 'Sealed value names a key that is not configured',
  AUTH_FAILED: 'Sealed value failed authentication (wrong key, wrong AAD, or tampered)'
}

/**
 * A sealed value could not be opened.
 *
 * Extends Error, NOT AppError, on purpose: the client did nothing wrong. A
 * row that will not decrypt is corruption, tampering or a missing key — the
 * error handler turns any non-AppError into a logged, Sentry-reported 500
 * with a generic message, which is exactly right. Messages never contain
 * the sealed value, the plaintext or a key.
 */
export class SecretBoxError extends Error {
  readonly code: SecretBoxErrorCode

  constructor(code: SecretBoxErrorCode, options: { cause?: unknown } = {}) {
    super(MESSAGES[code], { cause: options.cause })
    this.name = 'SecretBoxError'
    this.code = code
  }
}

export type SecretBoxConfig = {
  /** Key id → 32 random bytes as standard base64. All keys that may have sealed a stored value. */
  keys: Record<string, string>
  /** The key new values are sealed with. */
  currentKeyId: string
}

export type SecretBox = {
  /** Encrypts. `aad` is required and must be non-empty — see the file header. */
  seal(plaintext: string | Uint8Array, aad: string | Uint8Array): string
  /** Decrypts to bytes, or throws SecretBoxError. Never returns unauthenticated data. */
  open(sealed: string, aad: string | Uint8Array): Buffer
  /** open() for values sealed from a string; throws if the bytes are not UTF-8. */
  openText(sealed: string, aad: string | Uint8Array): string
  /** True when the value was sealed with an older key and should be re-sealed. */
  needsReseal(sealed: string): boolean
}

/**
 * Builds a box from configuration. Throws (plain Error, at startup) on any
 * configuration mistake, so a bad key is found at boot rather than at the
 * first login.
 */
export function createSecretBox(config: SecretBoxConfig): SecretBox {
  const keys = new Map<string, KeyObject>()

  for (const [keyId, encoded] of Object.entries(config.keys)) {
    // An id is only quoted once it is known to BE an id. Swap id and key in
    // an env var and the "id" is the AES key — echoing it would put the key
    // in the startup log and Sentry.
    if (!KEY_ID.test(keyId)) {
      throw new Error(`secretBox: a key id (${keyId.length} characters) does not look like v1, v2, …`)
    }
    // The message names the key id, never the key.
    const bytes = decodeCanonical(encoded, 'base64')
    if (bytes === null || bytes.length !== KEY_BYTES) {
      throw new Error(`secretBox: key ${keyId} must be ${KEY_BYTES} bytes of standard base64 (openssl rand -base64 32)`)
    }
    const key = createSecretKey(bytes)
    // The same key under two ids is a copy-paste mistake that makes a
    // "rotation" rotate nothing.
    for (const [otherId, other] of keys) {
      if (other.equals(key)) throw new Error(`secretBox: keys ${otherId} and ${keyId} are identical`)
    }
    keys.set(keyId, key)
  }

  const currentKey = keys.get(config.currentKeyId)
  if (!currentKey) {
    const shown = KEY_ID.test(config.currentKeyId) ? `"${config.currentKeyId}"` : '(not a key id)'
    throw new Error(`secretBox: currentKeyId ${shown} is not among the configured keys`)
  }
  const currentKeyId = config.currentKeyId

  function open(sealed: string, aad: string | Uint8Array): Buffer {
    const aadBytes = requireAad(aad)
    const { keyId, iv, ciphertext, tag } = parseSealed(sealed)
    const key = keys.get(keyId)
    if (!key) throw new SecretBoxError('UNKNOWN_KEY')

    // Trap 1: authTagLength pins the tag to 16 bytes inside node:crypto too,
    // not only in our own length check.
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(aadBytes)
    decipher.setAuthTag(tag)
    try {
      // Trap 2: update()'s output is unauthenticated until final() returns.
      // Both are inside the try and nothing escapes before final() passes.
      return Buffer.concat([decipher.update(ciphertext), decipher.final()])
    } catch (cause) {
      throw new SecretBoxError('AUTH_FAILED', { cause })
    }
  }

  return {
    seal(plaintext, aad) {
      const aadBytes = requireAad(aad)
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGORITHM, currentKey, iv, { authTagLength: TAG_BYTES })
      cipher.setAAD(aadBytes)
      const ciphertext = Buffer.concat([cipher.update(toBytes(plaintext)), cipher.final()])
      return [currentKeyId, encode(iv), encode(ciphertext), encode(cipher.getAuthTag())].join(':')
    },

    open,

    openText(sealed, aad) {
      // fatal: true — a value sealed as raw bytes and opened as text is a
      // bug; silently turning it into U+FFFD characters would hide it.
      // ignoreBOM: true — despite the name, this KEEPS a leading U+FEFF.
      // The default strips it, so the text would not round-trip exactly.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(open(sealed, aad))
    },

    needsReseal(sealed) {
      return parseSealed(sealed).keyId !== currentKeyId
    }
  }
}

// ─── Internals ────────────────────────────────────────────────────────────

type ParsedSealed = { keyId: string; iv: Buffer; ciphertext: Buffer; tag: Buffer }

function parseSealed(sealed: string): ParsedSealed {
  const parts = sealed.split(':')
  if (parts.length !== 4) throw new SecretBoxError('MALFORMED')
  const [keyId = '', ivText = '', ciphertextText = '', tagText = ''] = parts
  if (!KEY_ID.test(keyId)) throw new SecretBoxError('MALFORMED')

  // Trap 3: exact, canonical decoding — and exact lengths. A truncated tag
  // is MALFORMED here, before it ever reaches the decipher.
  const iv = decodeCanonical(ivText, 'base64url')
  const ciphertext = decodeCanonical(ciphertextText, 'base64url')
  const tag = decodeCanonical(tagText, 'base64url')
  if (iv === null || iv.length !== IV_BYTES || ciphertext === null || tag === null || tag.length !== TAG_BYTES) {
    throw new SecretBoxError('MALFORMED')
  }
  return { keyId, iv, ciphertext, tag }
}

/**
 * Decodes only if re-encoding gives back exactly the input. That one check
 * rejects foreign characters (silently dropped by Buffer.from), the other
 * base64 alphabet, padding where none belongs, and non-zero leftover bits.
 */
function decodeCanonical(text: string, encoding: 'base64' | 'base64url'): Buffer | null {
  const bytes = Buffer.from(text, encoding)
  return bytes.toString(encoding) === text ? bytes : null
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function toBytes(value: string | Uint8Array): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)
}

function requireAad(aad: string | Uint8Array): Buffer {
  const bytes = toBytes(aad)
  // A programming error, not a SecretBoxError: no stored value is at fault.
  if (bytes.length === 0) throw new Error('secretBox: aad must not be empty')
  return bytes
}
