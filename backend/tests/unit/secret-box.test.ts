// secret-box.test.ts — AES-256-GCM sealing: round trips, tampering, the
// Bun traps, key rotation, and interop with WebCrypto.

import { describe, test, expect } from 'bun:test'
import { createSecretBox, SecretBoxError, type SecretBoxErrorCode } from '../../src/lib/secretBox.ts'
import { AppError } from '../../src/lib/errors.ts'

const KEY_V1 = Buffer.alloc(32, 1).toString('base64')
const KEY_V2 = Buffer.alloc(32, 2).toString('base64')
const AAD = 'totp-secret:user:42'

const boxV1 = createSecretBox({ keys: { v1: KEY_V1 }, currentKeyId: 'v1' })

function errorCode(fn: () => unknown): SecretBoxErrorCode | 'NO ERROR' | 'OTHER ERROR' {
  try {
    fn()
    return 'NO ERROR'
  } catch (error) {
    return error instanceof SecretBoxError ? error.code : 'OTHER ERROR'
  }
}

/** Replaces one part of a sealed string (0 key id, 1 iv, 2 ciphertext, 3 tag). */
function withPart(sealed: string, index: number, replace: (bytes: Buffer) => Buffer): string {
  const parts = sealed.split(':')
  parts[index] = replace(Buffer.from(parts[index] ?? '', 'base64url')).toString('base64url')
  return parts.join(':')
}

function flipBit(bytes: Buffer, byteIndex = 0): Buffer {
  const copy = Buffer.from(bytes)
  copy[byteIndex] = (copy[byteIndex] ?? 0) ^ 0x01
  return copy
}

describe('seal / open', () => {
  test('a string round-trips', () => {
    const sealed = boxV1.seal('JBSWY3DPEHPK3PXP', AAD)
    expect(boxV1.openText(sealed, AAD)).toBe('JBSWY3DPEHPK3PXP')
  })

  test('bytes round-trip', () => {
    const secret = Buffer.from([0, 1, 2, 250, 255])
    expect(boxV1.open(boxV1.seal(secret, AAD), AAD)).toEqual(secret)
  })

  test('Swedish characters survive (UTF-8)', () => {
    expect(boxV1.openText(boxV1.seal('Kalles Plåt AB — åäö', AAD), AAD)).toBe('Kalles Plåt AB — åäö')
  })

  test('a leading byte-order mark survives openText (TextDecoder strips it by default)', () => {
    expect(boxV1.openText(boxV1.seal('﻿abc', AAD), AAD)).toBe('﻿abc')
  })

  test('an empty plaintext round-trips', () => {
    expect(boxV1.openText(boxV1.seal('', AAD), AAD)).toBe('')
  })

  test('the format is v1:<12-byte iv>:<ciphertext>:<16-byte tag>, base64url', () => {
    const sealed = boxV1.seal('hemlig', AAD)
    expect(sealed).toMatch(/^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]*:[A-Za-z0-9_-]{22}$/)
  })

  test('🔑 sealing the same text twice gives different output — a fresh IV each time', () => {
    const outputs = new Set(Array.from({ length: 50 }, () => boxV1.seal('samma', AAD)))
    expect(outputs.size).toBe(50)
  })

  test('the ciphertext does not contain the plaintext', () => {
    const sealed = boxV1.seal('JBSWY3DPEHPK3PXP', AAD)
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP')
    expect(Buffer.from(sealed.split(':')[2] ?? '', 'base64url').toString()).not.toContain('JBSWY3DPEHPK3PXP')
  })
})

describe('AAD — binds a value to its row', () => {
  test('🔑 a value copied to another row does not open there', () => {
    const sealedForUser42 = boxV1.seal('hemlig', 'totp-secret:user:42')
    expect(errorCode(() => boxV1.open(sealedForUser42, 'totp-secret:user:43'))).toBe('AUTH_FAILED')
  })

  test('an empty AAD is refused on seal and on open — it would bind to nothing', () => {
    const sealed = boxV1.seal('hemlig', AAD)
    expect(() => boxV1.seal('hemlig', '')).toThrow('aad must not be empty')
    expect(() => boxV1.open(sealed, new Uint8Array())).toThrow('aad must not be empty')
  })

  test('🔑 a lone surrogate is refused — it would encode to the same bytes as U+FFFD', () => {
    // Buffer.from('\uD800') and Buffer.from('�') are both EF BF BD.
    // Without the check, these three different AADs would open each
    // other's values.
    const sealed = boxV1.seal('hemlig', 'user:�')
    expect(() => boxV1.open(sealed, 'user:\uD800')).toThrow('lone surrogate')
    expect(() => boxV1.open(sealed, 'user:\uDC00')).toThrow('lone surrogate')
    expect(() => boxV1.seal('hemlig', 'user:\uD800')).toThrow('lone surrogate')
    expect(() => boxV1.seal('half an emoji: \uD83D', AAD)).toThrow('lone surrogate')
  })

  test('a full surrogate pair (an emoji) is fine', () => {
    expect(boxV1.openText(boxV1.seal('kvitto 🧾', 'user:🧾'), 'user:🧾')).toBe('kvitto 🧾')
  })

  test('string and byte AAD are the same thing', () => {
    const sealed = boxV1.seal('hemlig', AAD)
    expect(boxV1.openText(sealed, Buffer.from(AAD))).toBe('hemlig')
  })
})

describe('tampering', () => {
  const sealed = boxV1.seal('hemlig text som är lång nog', AAD)

  test.each([
    [1, 'iv'],
    [2, 'ciphertext'],
    [3, 'tag']
  ])('one flipped bit in the %s (%s) → AUTH_FAILED', (index) => {
    expect(errorCode(() => boxV1.open(withPart(sealed, index, (b) => flipBit(b)), AAD))).toBe('AUTH_FAILED')
  })

  test('every single-bit flip anywhere in the ciphertext is caught', () => {
    const ciphertext = Buffer.from(sealed.split(':')[2] ?? '', 'base64url')
    for (let byte = 0; byte < ciphertext.length; byte += 1) {
      for (let bit = 0; bit < 8; bit += 1) {
        const tampered = withPart(sealed, 2, (b) => {
          const copy = Buffer.from(b)
          copy[byte] = (copy[byte] ?? 0) ^ (1 << bit)
          return copy
        })
        expect(errorCode(() => boxV1.open(tampered, AAD))).toBe('AUTH_FAILED')
      }
    }
  })

  test('🔑 a truncated tag (first 4 bytes of the REAL tag) → MALFORMED, never opened', () => {
    // Trap 1: Bun's decipher accepts a 4-byte prefix of the correct tag when
    // authTagLength is not set — this exact input would decrypt. Our exact
    // length check stops it before it reaches node:crypto at all.
    const truncated = withPart(sealed, 3, (tag) => tag.subarray(0, 4))
    expect(errorCode(() => boxV1.open(truncated, AAD))).toBe('MALFORMED')
  })

  test('a ciphertext with a byte cut off → AUTH_FAILED', () => {
    expect(errorCode(() => boxV1.open(withPart(sealed, 2, (b) => b.subarray(0, -1)), AAD))).toBe('AUTH_FAILED')
  })

  test('the error carries no secret material', () => {
    let thrown: unknown = null
    try {
      boxV1.open(withPart(sealed, 2, (b) => flipBit(b)), AAD)
    } catch (error) {
      thrown = error
    }
    const text = `${(thrown as Error).message} ${(thrown as Error).stack}`
    expect(text).not.toContain('hemlig')
    expect(text).not.toContain(sealed.split(':')[2] ?? '')
    expect(text).not.toContain(KEY_V1)
  })

  test('SecretBoxError is not an AppError — a row that will not open is a 500', () => {
    let thrown: unknown = null
    try {
      boxV1.open(withPart(sealed, 2, (b) => flipBit(b)), AAD)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SecretBoxError)
    expect(thrown).not.toBeInstanceOf(AppError)
  })
})

describe('malformed input', () => {
  const sealed = boxV1.seal('hemlig', AAD)
  const [keyId, iv, ciphertext, tag] = sealed.split(':') as [string, string, string, string]

  test.each([
    ['', 'empty'],
    ['v1:abc', 'too few parts'],
    [`${sealed}:extra`, 'too many parts'],
    [`V1:${iv}:${ciphertext}:${tag}`, 'key id in upper case'],
    [`1:${iv}:${ciphertext}:${tag}`, 'key id without the v'],
    [`v1x:${iv}:${ciphertext}:${tag}`, 'key id with junk'],
    [`${keyId}:${iv}=:${ciphertext}:${tag}`, 'padding where none belongs'],
    [`${keyId}:${iv.slice(0, -1)}+:${ciphertext}:${tag}`, 'the other base64 alphabet'],
    [`${keyId}:!!!not base64!!!:${ciphertext}:${tag}`, 'garbage Buffer.from would happily decode'],
    [`${keyId}:${iv.slice(0, -2)}:${ciphertext}:${tag}`, 'IV too short'],
    [`${keyId}:${iv}:${ciphertext}:${tag}AA`, 'tag too long']
  ])('%p (%s) → MALFORMED', (input) => {
    expect(errorCode(() => boxV1.open(input, AAD))).toBe('MALFORMED')
  })

  test.each([11, 13])('a canonical %p-byte IV → MALFORMED (the length check itself)', (length) => {
    // These decode and re-encode cleanly, so only `iv.length !== 12` can
    // reject them. GCM itself accepts IVs of any length, so without the
    // check they would reach the decipher and fail as AUTH_FAILED instead.
    const wrongIv = Buffer.alloc(length, 7).toString('base64url')
    expect(Buffer.from(wrongIv, 'base64url').toString('base64url')).toBe(wrongIv)
    expect(errorCode(() => boxV1.open(`${keyId}:${wrongIv}:${ciphertext}:${tag}`, AAD))).toBe('MALFORMED')
  })

  test('needsReseal refuses malformed input too', () => {
    expect(errorCode(() => boxV1.needsReseal('nonsense'))).toBe('MALFORMED')
  })

  test('openText refuses bytes that are not UTF-8', () => {
    const sealedBytes = boxV1.seal(Buffer.from([0xff, 0xfe, 0xfd]), AAD)
    expect(() => boxV1.openText(sealedBytes, AAD)).toThrow()
    expect(boxV1.open(sealedBytes, AAD)).toEqual(Buffer.from([0xff, 0xfe, 0xfd]))
  })
})

describe('keys and rotation', () => {
  test('a different key under the same id → AUTH_FAILED', () => {
    const impostor = createSecretBox({ keys: { v1: KEY_V2 }, currentKeyId: 'v1' })
    expect(errorCode(() => impostor.open(boxV1.seal('hemlig', AAD), AAD))).toBe('AUTH_FAILED')
  })

  test('a key id the box does not know → UNKNOWN_KEY', () => {
    const boxV2Only = createSecretBox({ keys: { v2: KEY_V2 }, currentKeyId: 'v2' })
    expect(errorCode(() => boxV2Only.open(boxV1.seal('hemlig', AAD), AAD))).toBe('UNKNOWN_KEY')
  })

  test('🔑 rotation v1 → v2: old values open, are flagged, and re-seal under v2', () => {
    const oldValue = boxV1.seal('hemlig', AAD)

    // Step 1: deploy with both keys, v2 current.
    const rotating = createSecretBox({ keys: { v1: KEY_V1, v2: KEY_V2 }, currentKeyId: 'v2' })
    expect(rotating.openText(oldValue, AAD)).toBe('hemlig')
    expect(rotating.needsReseal(oldValue)).toBe(true)

    // Step 2: a job re-seals every flagged value.
    const resealed = rotating.seal(rotating.open(oldValue, AAD), AAD)
    expect(resealed.startsWith('v2:')).toBe(true)
    expect(rotating.needsReseal(resealed)).toBe(false)

    // Step 3: once nothing needs re-sealing, v1 can be removed.
    const afterRotation = createSecretBox({ keys: { v2: KEY_V2 }, currentKeyId: 'v2' })
    expect(afterRotation.openText(resealed, AAD)).toBe('hemlig')
    expect(errorCode(() => afterRotation.open(oldValue, AAD))).toBe('UNKNOWN_KEY')
  })
})

describe('configuration errors — found at startup, not at first login', () => {
  test.each([
    [{ keys: { v1: KEY_V1 }, currentKeyId: 'v2' }, 'currentKeyId "v2" is not among'],
    [{ keys: { v1: Buffer.alloc(16, 1).toString('base64') }, currentKeyId: 'v1' }, 'must be 32 bytes'],
    [{ keys: { v1: `${KEY_V1.slice(0, -1)}` }, currentKeyId: 'v1' }, 'must be 32 bytes'], // padding stripped
    [{ keys: { v1: Buffer.alloc(32, 1).toString('base64url') }, currentKeyId: 'v1' }, 'must be 32 bytes'], // wrong alphabet
    [{ keys: { key1: KEY_V1 }, currentKeyId: 'key1' }, 'does not look like v1'],
    [{ keys: { 'v1:x': KEY_V1 }, currentKeyId: 'v1:x' }, 'does not look like v1'],
    [{ keys: { v1: KEY_V1, v2: KEY_V1 }, currentKeyId: 'v2' }, 'keys v1 and v2 are identical']
  ])('%#: %p → %p', (config, message) => {
    expect(() => createSecretBox(config)).toThrow(message)
  })

  test('a configuration error never echoes the key', () => {
    const badKey = Buffer.alloc(16, 7).toString('base64')
    let message = ''
    try {
      createSecretBox({ keys: { v1: badKey }, currentKeyId: 'v1' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain(badKey)
  })

  test.each([
    ['id and key swapped', { keys: { [KEY_V1]: 'v1' }, currentKeyId: 'v1' }],
    ['the key in currentKeyId', { keys: { v1: KEY_V1 }, currentKeyId: KEY_V1 }]
  ])('🔑 %s: the error does not print the key', (_label, config) => {
    // The easiest env-var mistake to make, and the one that would put the
    // AES key into the startup log — so ids are quoted only once valid.
    let message = ''
    try {
      createSecretBox(config)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toStartWith('secretBox:')
    expect(message).not.toContain(KEY_V1)
  })

  test('🔑 the box holds no key you could log', () => {
    const box = createSecretBox({ keys: { v1: KEY_V1 }, currentKeyId: 'v1' })
    expect(JSON.stringify(box)).not.toContain(KEY_V1)
    expect(Bun.inspect(box)).not.toContain(KEY_V1)
  })
})

describe('interop', () => {
  test('🔑 WebCrypto decrypts our output — it is plain AES-256-GCM', async () => {
    const sealed = boxV1.seal('hemlig', AAD)
    const [, ivText = '', ciphertextText = '', tagText = ''] = sealed.split(':')
    const key = await crypto.subtle.importKey('raw', Buffer.from(KEY_V1, 'base64'), 'AES-GCM', false, ['decrypt'])
    // WebCrypto expects the tag appended to the ciphertext.
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: Buffer.from(ivText, 'base64url'),
        additionalData: Buffer.from(AAD),
        tagLength: 128
      },
      key,
      Buffer.concat([Buffer.from(ciphertextText, 'base64url'), Buffer.from(tagText, 'base64url')])
    )
    expect(new TextDecoder().decode(plaintext)).toBe('hemlig')
  })
})
