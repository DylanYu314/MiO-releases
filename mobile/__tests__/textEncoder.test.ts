import { Utf8TextEncoder, installTextEncoder } from '../src/polyfills/textEncoder'

/**
 * The UTF-8 encoder Hermes does not ship (#492, slice 3).
 *
 * ## Checked against Node, not against a fixture
 *
 * Every expectation here is `new TextEncoder().encode(...)` from the runtime
 * jest is on — the reference implementation. A hand-written byte array would be
 * a second guess at UTF-8 sitting next to the first one, and if both were wrong
 * in the same way the test would agree with the bug.
 *
 * That is only possible *because* of the divergence this file exists for: Node
 * has the API and Hermes does not, so the test environment happens to contain
 * the oracle. The irony is worth stating, because it is also the danger — a
 * test that used the global would test Node's encoder twice and ours never.
 * Everything below calls {@link Utf8TextEncoder} explicitly.
 */

const reference = new TextEncoder()
const ours = new Utf8TextEncoder()

const same = (input: string) =>
  expect(Array.from(ours.encode(input))).toEqual(Array.from(reference.encode(input)))

describe('Utf8TextEncoder', () => {
  it('matches Node on the payload this actually carries', () => {
    // The real thing: a Bilibili QR hand-off URL.
    same('https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&qrcode_key=c0670d1c')
  })

  it.each([
    ['empty', ''],
    ['ascii', 'hello world'],
    ['one byte boundary', ''],
    ['two byte boundary', ''],
    ['latin', 'café naïve'],
    ['three byte boundary', 'ࠀ'],
    ['chinese', '默认收藏夹'],
    ['japanese', 'こんにちは'],
    ['four byte, a surrogate pair', '😀'],
    ['emoji run', '🎵🎧🔊'],
    ['mixed', 'MiO 音乐 🎵 v1'],
    ['bmp maximum', '￿'],
  ])('matches Node for %s', (_name, input) => same(input))

  /*
   * Lone surrogates are the case a naive encoder gets wrong — it emits a
   * three-byte sequence for a value that is not a code point. WHATWG says
   * replace with U+FFFD, and Node does.
   */
  it('replaces a lone high surrogate, as the spec requires', () => {
    same('\ud800')
    same('a\ud800b')
  })

  it('replaces a lone low surrogate', () => {
    same('\udc00')
    same('a\udc00b')
  })

  it('still pairs a valid surrogate that follows a lone one', () => {
    same('\ud800😀')
  })

  it('reports its encoding, which callers may read', () => {
    expect(ours.encoding).toBe('utf-8')
  })

  it('handles no argument at all', () => {
    expect(Array.from(ours.encode())).toEqual([])
  })
})

describe('installing it', () => {
  /*
   * The rule that keeps this from being a downgrade: on a runtime that has a
   * real implementation — Node here, or a future Hermes — that one wins. Only
   * the absence is filled.
   */
  it('never replaces a real implementation', () => {
    const existing = globalThis.TextEncoder

    installTextEncoder()

    expect(globalThis.TextEncoder).toBe(existing)
    expect(globalThis.TextEncoder).not.toBe(Utf8TextEncoder)
  })

  it('installs where there is none, which is the device', () => {
    const target = globalThis as { TextEncoder?: unknown }
    const existing = target.TextEncoder
    try {
      delete target.TextEncoder

      installTextEncoder()

      expect(target.TextEncoder).toBe(Utf8TextEncoder)
    } finally {
      target.TextEncoder = existing
    }
  })
})
