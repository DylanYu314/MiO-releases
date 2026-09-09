/**
 * A UTF-8 `TextEncoder`, because Hermes does not have one (#492, slice 3).
 *
 * ## How this was found, and why it is not a jest problem
 *
 * `react-native-qrcode-svg` encodes the QR payload with `qrcode`, whose
 * `byte-data.js` does `new TextEncoder().encode(data)` for a string input. The
 * package ships a metro transformer that injects a polyfill — but only for
 * React Native **below 0.75**, on the stated grounds that 0.75+ provides one.
 * This project is on 0.86, so that path does not run.
 *
 * It does not provide one. Measured on the actual artefact rather than assumed:
 *
 *     strings lib/arm64-v8a/libhermesvm.so | grep -c '^TextEncoder$'   → 0
 *     grep -c TextEncoder assets/index.android.bundle                  → 0
 *
 * Neither the engine nor the shipped bundle has it. **Every jest test would
 * still pass**, because Node does — which is exactly the divergence
 * `docs/lessons.md` records for `TextDecoder`, and the reason
 * `src/library/audioTags.ts` is hand-rolled. A QR screen that renders perfectly
 * in CI and throws `TextEncoder is not defined` on the phone is the same bug in
 * a new place.
 *
 * ## Why ours rather than the `text-encoding` package
 *
 * That package is what the library would have injected. It is deprecated, it
 * carries a full `TextDecoder` and a legacy encoding table for encodings
 * nothing here wants, and it would be a dependency taken on for twenty lines of
 * arithmetic. The same trade `audioTags.ts` already made.
 *
 * This encodes UTF-8 and nothing else. That is the whole of what `qrcode` asks
 * for, and `textEncoder.test.ts` checks it against Node's real implementation
 * over ASCII, Chinese, emoji, surrogate pairs and lone surrogates rather than
 * against a hand-written expectation.
 *
 * ⚠️ **Installed, not exported for use.** Import this module for its side
 * effect; call sites should keep using the global, so removing the polyfill on
 * a future Hermes that has one is deleting a single import.
 */

/** The replacement character, for an unpaired surrogate — what WHATWG requires
 *  and what Node does. */
const REPLACEMENT = 0xfffd

export class Utf8TextEncoder {
  readonly encoding = 'utf-8'

  encode(input = ''): Uint8Array {
    const text = String(input)
    // Worst case is four bytes per code unit; trimmed by `subarray` at the end,
    // which is a view rather than a copy.
    const out = new Uint8Array(text.length * 4)
    let at = 0

    for (let i = 0; i < text.length; i += 1) {
      let code = text.charCodeAt(i)

      // A surrogate pair is one code point spread over two code units.
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000
          i += 1
        } else {
          code = REPLACEMENT // a high surrogate with nothing after it
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        code = REPLACEMENT // a low surrogate with nothing before it
      }

      if (code < 0x80) {
        out[at++] = code
      } else if (code < 0x800) {
        out[at++] = 0xc0 | (code >> 6)
        out[at++] = 0x80 | (code & 0x3f)
      } else if (code < 0x10000) {
        out[at++] = 0xe0 | (code >> 12)
        out[at++] = 0x80 | ((code >> 6) & 0x3f)
        out[at++] = 0x80 | (code & 0x3f)
      } else {
        out[at++] = 0xf0 | (code >> 18)
        out[at++] = 0x80 | ((code >> 12) & 0x3f)
        out[at++] = 0x80 | ((code >> 6) & 0x3f)
        out[at++] = 0x80 | (code & 0x3f)
      }
    }

    return out.subarray(0, at)
  }
}

/**
 * Install it, once, and only where it is missing.
 *
 * Never overwrites a real implementation: on a runtime that has one — Node
 * under jest, or a future Hermes — that one is better tested than this.
 */
export function installTextEncoder(): void {
  const target = globalThis as { TextEncoder?: unknown }
  if (typeof target.TextEncoder === 'undefined') {
    target.TextEncoder = Utf8TextEncoder
  }
}

installTextEncoder()
