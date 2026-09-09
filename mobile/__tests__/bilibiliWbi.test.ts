import {
  currentMixinKey,
  keyFromUrl,
  mixinKey,
  resetWbiKeyCache,
  signableQuery,
} from '../src/library/bilibiliWbi'

/**
 * WBI signing (2026-09-08).
 *
 * ⛔ Bilibili retired the unsigned `x/web-interface/view`, which now answers
 * **412**. Measured with an invented `buvid3`, one issued by Bilibili's own
 * `finger/spi`, and a real browser cookie jar — while `search/type`, `playurl`
 * and `card` all answered 200 with that same jar. The endpoint changed; the
 * cookie and the address did not.
 *
 * ⚠️ These test the parts that can be wrong **silently**. A mis-ordered query
 * or a stripped character produces a signature Bilibili rejects, and the
 * symptom is the same 412 this is meant to fix — indistinguishable from not
 * having signed at all.
 */

beforeEach(() => resetWbiKeyCache())

describe('deriving the mixin key', () => {
  it('takes the filename out of a wbi image url', () => {
    expect(keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png')).toBe(
      '7cd084941338484aae1ad9425b84077c',
    )
  })

  it('survives a url with no path or no extension', () => {
    expect(keyFromUrl('')).toBe('')
    expect(keyFromUrl('https://example.test/abc')).toBe('abc')
  })

  it('is 32 characters, reordered by Bilibili’s table', () => {
    // The table is a constant of theirs; what is asserted here is that it is
    // applied at all and truncated, not the specific bytes it produces.
    const img = '7cd084941338484aae1ad9425b84077c'
    const sub = '4932caff0ff746eab6f01bf08b70ac45'

    const key = mixinKey(img, sub)

    expect(key).toHaveLength(32)
    expect(key).not.toBe((img + sub).slice(0, 32))
  })

  it('is stable, so the same keys always sign the same way', () => {
    expect(mixinKey('abc', 'def')).toBe(mixinKey('abc', 'def'))
  })
})

describe('the signable query', () => {
  it('sorts the parameters, because the order is part of the signature', () => {
    // ⚠️ A different order hashes differently and is refused, and the same
    // string has to be both hashed and sent — building it twice is the bug.
    expect(signableQuery({ bvid: 'BV1', aid: 2 }, 1757000000)).toBe('aid=2&bvid=BV1&wts=1757000000')
  })

  it('always carries wts, which the signature needs', () => {
    expect(signableQuery({ bvid: 'BV1' }, 999)).toContain('wts=999')
  })

  it("strips !'()* from values, which encodeURIComponent leaves alone", () => {
    /*
     * ⚠️ Bilibili's own implementation removes these and `encodeURIComponent`
     * does not, so a title containing one would sign correctly here and be
     * refused there — a 412 that looks exactly like not signing at all.
     */
    expect(signableQuery({ keyword: "a!b'c(d)e*f" }, 1)).toBe('keyword=abcdef&wts=1')
  })

  it('percent-encodes everything else, rather than sending it raw', () => {
    expect(signableQuery({ keyword: '音 楽&x' }, 1)).toBe('keyword=%E9%9F%B3%20%E6%A5%BD%26x&wts=1')
  })
})

describe('fetching the mixin key', () => {
  const nav = (imgUrl: string, subUrl: string) =>
    jest.fn().mockResolvedValue({
      json: async () => ({ code: -101, data: { wbi_img: { img_url: imgUrl, sub_url: subUrl } } }),
    } as unknown as Response)

  const IMG = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'
  const SUB = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'

  it('accepts nav answering code -101, which it always does when signed out', async () => {
    /*
     * ⛔ The trap. `nav` reports "not logged in" for an anonymous caller and
     * still returns the keys. Treating -101 as a failure would break signing
     * for everyone who is not signed in — that is, everyone.
     */
    const fetchImpl = nav(IMG, SUB)

    await expect(currentMixinKey(fetchImpl, {})).resolves.toHaveLength(32)
  })

  it('caches the key rather than fetching it for every request', async () => {
    const fetchImpl = nav(IMG, SUB)

    await currentMixinKey(fetchImpl, {}, 1_000_000)
    await currentMixinKey(fetchImpl, {}, 1_000_000 + 60_000)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refetches once the key is old, because they rotate', async () => {
    const fetchImpl = nav(IMG, SUB)

    await currentMixinKey(fetchImpl, {}, 1_000_000)
    await currentMixinKey(fetchImpl, {}, 1_000_000 + 2 * 60 * 60 * 1000)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('throws rather than signing with a key it did not get', async () => {
    // A silent empty key produces a valid-looking request that is always
    // refused — the same 412, with no clue that signing was the problem.
    const fetchImpl = jest.fn().mockResolvedValue({
      json: async () => ({ code: 0, data: {} }),
    } as unknown as Response)

    await expect(currentMixinKey(fetchImpl, {})).rejects.toThrow(/wbi keys/)
  })
})
