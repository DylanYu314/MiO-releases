/**
 * Searching Bilibili from the phone (#551).
 *
 * The fixtures are the **real** shapes read off `x/web-interface/search/type`
 * on 2026-08-16 while `docs/bilibili.md` §2.2 was being measured. Three of them
 * are traps that would not fail — they would quietly make the *matcher* look
 * worse — so they are what most of this file is about.
 */

import {
  BILIBILI_SEARCH_PACE_MS,
  durationSeconds,
  resetBilibiliSearchPace,
  searchBilibiliOnDevice,
  stripSearchMarkup,
} from '../src/library/bilibiliSearch'

describe('stripSearchMarkup', () => {
  it('removes the keyword highlighting Bilibili wraps matches in', () => {
    // Verbatim from the live endpoint. Left in, `normalize()` in matching.py
    // strips the punctuation and hands the scorer `em class keyword` as tokens
    // on *every* candidate — which reads as the matcher getting worse.
    expect(
      stripSearchMarkup(
        '<em class="keyword">R. Kelly</em>, Usher - <em class="keyword">Same Girl</em> 【中英双字】',
      ),
    ).toBe('R. Kelly, Usher - Same Girl 【中英双字】')
  })

  it('decodes entities, and decodes &amp; last', () => {
    expect(stripSearchMarkup('Simon &amp; Garfunkel')).toBe('Simon & Garfunkel')
    expect(stripSearchMarkup('say &quot;hi&quot;')).toBe('say "hi"')
    // If `&amp;` were decoded first this would become a quote that was never
    // in the title.
    expect(stripSearchMarkup('&amp;quot;')).toBe('&quot;')
  })

  it('leaves an ordinary title alone', () => {
    expect(stripSearchMarkup('周杰伦 - 稻香')).toBe('周杰伦 - 稻香')
  })
})

describe('durationSeconds', () => {
  it.each([
    ['4:48', 288],
    ['0:45', 45],
    ['1:02:03', 3723],
  ])('reads %s as %i seconds', (input, expected) => {
    expect(durationSeconds(input)).toBe(expected)
  })

  it('passes a number through, which is what the favourites endpoint sends', () => {
    expect(durationSeconds(270)).toBe(270)
  })

  it.each([null, undefined, '', 'live', '4:8:15:16', '4:xx', 0, -5])(
    'refuses %p rather than guessing',
    (input) => {
      expect(durationSeconds(input)).toBeNull()
    },
  )
})

// ── the reader ──────────────────────────────────────────────────────────────

const row = (over: Record<string, unknown> = {}) => ({
  bvid: 'BV1mx6DYbEj9',
  title: '<em class="keyword">R. Kelly</em>, Usher - <em class="keyword">Same Girl</em>',
  author: '本质上泥',
  duration: '4:48',
  pic: '//i0.hdslb.com/bfs/archive/0d71b4992b9eb9ea.jpg',
  ...over,
})

const ok = (rows: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ code: 0, data: { result: rows } }),
})

describe('searchBilibiliOnDevice', () => {
  const fetchMock = jest.fn()

  beforeEach(() => {
    jest.useRealTimers()
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
    resetBilibiliSearchPace()
  })

  it('reads a result into the shape the scorer takes', async () => {
    fetchMock.mockResolvedValueOnce(ok([row()]))

    const [result] = await searchBilibiliOnDevice('same girl', 5)

    expect(result).toEqual({
      // Canonical, so this and the same video pasted as a link are one library
      // row — `songs.source_url` is UNIQUE since v6.
      url: 'https://www.bilibili.com/video/BV1mx6DYbEj9',
      title: 'R. Kelly, Usher - Same Girl',
      uploader: '本质上泥',
      // Seconds, not "4:48". Sending null would make `_duration_score` return a
      // constant 0.5 and silently discard 15% of the match signal.
      duration: 288,
      // https, not the protocol-relative form the endpoint sends.
      thumbnail: 'https://i0.hdslb.com/bfs/archive/0d71b4992b9eb9ea.jpg',
    })
  })

  it('honours the limit', async () => {
    fetchMock.mockResolvedValueOnce(ok([row(), row({ bvid: 'BV2' }), row({ bvid: 'BV3' })]))
    expect(await searchBilibiliOnDevice('x', 2)).toHaveLength(2)
  })

  it('skips an unusable row rather than losing the others', async () => {
    fetchMock.mockResolvedValueOnce(ok([row({ bvid: '' }), row({ bvid: 'BV2' })]))
    const results = await searchBilibiliOnDevice('x', 5)
    expect(results.map((r) => r.url)).toEqual(['https://www.bilibili.com/video/BV2'])
  })

  it('sends a buvid3 cookie, which is what makes the request answer at all', async () => {
    fetchMock.mockResolvedValueOnce(ok([row()]))
    await searchBilibiliOnDevice('x', 5)

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers.Cookie).toMatch(/^buvid3=[0-9a-f-]+infoc$/)
    expect(headers.Referer).toBe('https://www.bilibili.com/')
  })

  it('opts out of the shared cookie jar, or the header above is a lie (#723)', async () => {
    /*
     * ⚠️ The assertion above passed against the broken app, and that is the
     * point of this one.
     *
     * React Native gives every `fetch` a shared, persistent cookie jar
     * (`android.webkit.CookieManager`, surviving restarts), and OkHttp's
     * `BridgeInterceptor` sets `Cookie` with `.header()`, which **replaces**.
     * So the device's tracked `buvid3` — and `SESSDATA`, once the QR login has
     * run — silently overwrote the fresh anonymous one, and jest cannot see it
     * because jest is not OkHttp.
     *
     * `credentials: 'omit'` is what installs `CookieJar.NO_COOKIES`, and it is
     * the *only* thing in this request that stops the override. Asserting the
     * header without asserting this describes a request the device never makes.
     */
    fetchMock.mockResolvedValueOnce(ok([row()]))
    await searchBilibiliOnDevice('x', 5)

    expect(fetchMock.mock.calls[0][1].credentials).toBe('omit')
  })

  it('throws on a 412 rather than reporting no results', async () => {
    // After volume a 412 means the *address* is rate limited and only ~15
    // minutes clears it (`docs/bilibili.md` §2.1). Reporting it as "nothing
    // found" would send the user hunting for a better search term.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 412, json: async () => ({}) })

    await expect(searchBilibiliOnDevice('x', 5)).rejects.toThrow(/412/)
  })

  it('throws on a non-zero body code', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ code: -412, data: {} }),
    })

    await expect(searchBilibiliOnDevice('x', 5)).rejects.toThrow(/-412/)
  })

  it('asks for nothing on an empty query', async () => {
    expect(await searchBilibiliOnDevice('   ', 5)).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('paces consecutive searches, because the endpoint refuses above ~1/s', async () => {
    // The measured requirement, not politeness: 1.9 req/s refused at request
    // 76 and 0.65 req/s served 320 (`docs/bilibili.md` §2.2). Asserted on
    // elapsed time rather than on a mock, because the pacing is what a real
    // matching loop depends on.
    fetchMock.mockResolvedValue(ok([row()]))

    const began = Date.now()
    await searchBilibiliOnDevice('one', 1)
    await searchBilibiliOnDevice('two', 1)
    const elapsed = Date.now() - began

    expect(elapsed).toBeGreaterThanOrEqual(BILIBILI_SEARCH_PACE_MS - 50)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('costs a single search nothing', async () => {
    fetchMock.mockResolvedValueOnce(ok([row()]))

    const began = Date.now()
    await searchBilibiliOnDevice('one', 1)

    // A user typing must not wait out a gate nobody else is using.
    expect(Date.now() - began).toBeLessThan(BILIBILI_SEARCH_PACE_MS)
  })
})
