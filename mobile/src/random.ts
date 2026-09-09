import * as Crypto from 'expo-crypto'

/**
 * Random bytes, on a platform that has no `crypto` global.
 *
 * Extracted from `api/installId.ts` when the local library needed to mint its
 * own song ids (#246). One copy, because the fallback below is the part that
 * shipped a real bug and the last thing worth having two of.
 *
 * ## Hermes has no `crypto`, and that shipped a bug
 *
 * `installId` was once one line — `crypto.getRandomValues(bytes)` — under a
 * comment claiming Hermes provides it. It does not: React Native has no
 * `crypto` global at all (#188). Minting threw on every launch that needed a
 * new id, so the install id was never created and every write answered 400.
 *
 * It stayed invisible because **jest runs on Node, which has `globalThis.crypto`**
 * — the test environment supplied the API the device lacks, so a green suite
 * said nothing about the phone. The #246 spike confirmed it again on a real
 * device: `globalThis.crypto` is `undefined` under Hermes.
 *
 * Web Crypto is still preferred where it exists — Node under jest, and the web —
 * so tests do not depend on a native module being mocked to produce good
 * randomness.
 */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const webCrypto = globalThis.crypto

  if (typeof webCrypto?.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes)
  } else {
    // Hermes. Synchronous, and cryptographically secure — the whole point of
    // paying a native dependency for this (#195).
    Crypto.getRandomValues(bytes)
  }

  return bytes
}

/** Random bytes as lowercase hex, which is what every id here is stored as. */
export function randomHex(length: number): string {
  return Array.from(randomBytes(length), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Whether minting has a cryptographic source available.
 *
 * Always true since #195 — either Web Crypto or `expo-crypto`. Kept as the thing
 * a test asserts, so that if a platform ever turns up with neither, it fails
 * here rather than silently minting guessable values.
 */
export function hasSecureRandom(): boolean {
  return (
    typeof globalThis.crypto?.getRandomValues === 'function' ||
    typeof Crypto.getRandomValues === 'function'
  )
}
