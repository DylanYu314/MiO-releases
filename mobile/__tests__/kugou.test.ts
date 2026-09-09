import { ExternalPlaylistTruncated } from '../src/library/externalPlaylist'
import { fetchKugouPlaylist, splitFilename } from '../src/library/kugou'
import {
  canonicalKugouPlaylistUrl,
  isKugouPlaylistLink,
  kugouPlaylistId,
  NotAKugouLink,
} from '../src/library/kugouUrl'

/**
 * Reading a Kugou 歌单 on the device (#104, ADR-013).
 *
 * Fixtures are shaped from a real response measured 2026-08-16 — including the
 * fields the reader ignores, because two of them are the whole ADR-013
 * argument: `topic_url` is the empty string on every row, and `hash` is an
 * identifier rather than a URL.
 */

describe('kugouPlaylistId', () => {
  it.each([
    ['https://www.kugou.com/yy/special/single/4304395.html', '4304395'],
    ['https://www.kugou.com/special/single/4304395.html', '4304395'],
    ['https://www.kugou.com/yy/special/single/4304395', '4304395'],
    ['https://m.kugou.com/plist/list/4304395', '4304395'],
    ['https://kugou.com/yy/special/single/4304395.html/', '4304395'],
    ['4304395', '4304395'],
  ])('reads %s', (input, expected) => {
    expect(kugouPlaylistId(input)).toBe(expected)
  })

  it('refuses another site wearing the same route', () => {
    expect(() => kugouPlaylistId('https://example.com/yy/special/single/4304395.html')).toThrow(
      NotAKugouLink,
    )
    expect(() => kugouPlaylistId('https://kugou.com.evil.test/plist/list/1')).toThrow(NotAKugouLink)
  })

  it('refuses a Kugou page that is not a playlist', () => {
    // A song and an album carry identically shaped ids on neighbouring routes,
    // which is why the route is matched rather than the digits being hunted.
    expect(() => kugouPlaylistId('https://www.kugou.com/song/#hash=ABC&album_id=123')).toThrow(
      NotAKugouLink,
    )
    expect(() => kugouPlaylistId('https://www.kugou.com/yy/album/single/123.html')).toThrow(
      NotAKugouLink,
    )
  })

  it('accepts any kugou.com subdomain, and nothing merely ending in one', () => {
    // Widened with QQ's for the same reason (#564): an allow-list of the
    // prefixes seen so far refuses the next one. The route is what keeps a song
    // page out, so the host does not need to be the strict half.
    expect(kugouPlaylistId('https://m3ws.kugou.com/plist/list/4304395')).toBe('4304395')
    expect(() => kugouPlaylistId('https://evilkugou.com/plist/list/1')).toThrow(NotAKugouLink)
  })

  it('refuses a global_specialid, deliberately', () => {
    /*
     * ⚠️ `gcid_…` is Kugou's *other* id space, carried on `/songlist/gcid_…`,
     * and it is plausibly what the Kugou app's share sheet produces (#564).
     *
     * It is refused rather than accepted because **nothing about it has been
     * measured**: there is no real `gcid_` to test with, Kugou is mainland-only
     * so one cannot be obtained here, and the endpoint this app uses takes a
     * `specialid`. Accepting it would produce a link the app says yes to and
     * then cannot fetch — the failure #104 nearly shipped by trusting an issue's
     * text about a host Android cannot even connect to.
     *
     * This test exists so that changing the answer is a deliberate act with a
     * measurement behind it, not an accident of a looser regex.
     */
    expect(() => kugouPlaylistId('https://www.kugou.com/songlist/gcid_3nQ7hV2kL8p/')).toThrow(
      NotAKugouLink,
    )
  })

  it('keeps the id a string, because these overflow a float', () => {
    expect(kugouPlaylistId('https://www.kugou.com/yy/special/single/9007199254740993.html')).toBe(
      '9007199254740993',
    )
  })
})

describe('isKugouPlaylistLink', () => {
  it('separates a Kugou playlist from everything else', () => {
    expect(isKugouPlaylistLink('https://www.kugou.com/yy/special/single/4304395.html')).toBe(true)
    expect(isKugouPlaylistLink('https://y.qq.com/n/ryqq/playlist/7707261125')).toBe(false)
    expect(isKugouPlaylistLink('not a url at all')).toBe(false)
  })
})

describe('canonicalKugouPlaylistUrl', () => {
  it('round-trips through kugouPlaylistId', () => {
    expect(kugouPlaylistId(canonicalKugouPlaylistUrl('4304395'))).toBe('4304395')
  })
})

describe('splitFilename', () => {
  it('splits the ordinary case', () => {
    expect(splitFilename('颜妹 - 安乐死')).toEqual({ artist: '颜妹', title: '安乐死' })
  })

  it('keeps a multi-artist field whole', () => {
    // Real row. The separator inside is Kugou's own list punctuation, not the
    // artist/title split, so the artist must survive intact.
    expect(splitFilename('BGHY苏刚、泽亦龙 - 恶魔召唤')).toEqual({
      artist: 'BGHY苏刚、泽亦龙',
      title: '恶魔召唤',
    })
  })

  it('splits on the first separator, letting the title absorb the rest', () => {
    // The title is weighted far more heavily by the scorer than the artist, so
    // a title carrying an extra " - " still matches well — while an artist that
    // swallowed half the title would not.
    expect(splitFilename('Jay-Z - Song - Live Version')).toEqual({
      artist: 'Jay-Z',
      title: 'Song - Live Version',
    })
  })

  it('does not split a hyphen with no spaces around it', () => {
    // "Jay-Z" is one word. Splitting on a bare "-" would cut it in half.
    expect(splitFilename('Jay-Z')).toEqual({ artist: '', title: 'Jay-Z' })
  })

  it('leaves the artist empty when there is no separator at all', () => {
    // Deliberate: an empty artist caps the score at 0.70, under the 0.80 auto
    // threshold, so the track goes to review rather than to a wrong song.
    expect(splitFilename('安乐死')).toEqual({ artist: '', title: '安乐死' })
  })
})

// ── the reader ──────────────────────────────────────────────────────────────

const ok = (body: unknown) => ({ ok: true, status: 200, url: '', json: async () => body })

/** A row shaped exactly like the real ones, including what we ignore. */
const song = (over: Record<string, unknown> = {}) => ({
  hash: '174E45179B00',
  audio_id: 25900562,
  filename: '颜妹 - 安乐死',
  duration: 165,
  // The ADR-013 evidence: empty on every row of every playlist measured.
  topic_url: '',
  topic_url_320: '',
  topic_url_sq: '',
  extname: 'mp3',
  filesize: 2612345,
  ...over,
})

const page = (rows: unknown[], total?: number) =>
  ok({ status: 1, errcode: 0, data: { total: total ?? rows.length, info: rows } })

/** The name lookup, which is a second request and best-effort. */
const named = (name: string) => ok({ status: 1, errcode: 0, data: { specialname: name } })

describe('fetchKugouPlaylist', () => {
  const fetchMock = jest.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('reads a playlist into the shape the import pipeline takes', async () => {
    fetchMock
      .mockResolvedValueOnce(
        page([song(), song({ hash: 'B2', filename: '泽亦龙 - 贝斯叭叭叭 (DJ版)', duration: 134 })]),
      )
      .mockResolvedValueOnce(named('我真的好喜欢你ʸᵃ'))

    const result = await fetchKugouPlaylist('https://www.kugou.com/yy/special/single/4304395.html')

    expect(result.service).toBe('kugou')
    expect(result.name).toBe('我真的好喜欢你ʸᵃ')
    expect(result.sourceUrl).toBe('https://www.kugou.com/yy/special/single/4304395.html')
    expect(result.tracks).toEqual([
      {
        externalId: '174E45179B00',
        title: '安乐死',
        artist: '颜妹',
        // This endpoint returns `album_name: null` on every row, so there is no
        // album to report and inventing one would be worse.
        album: null,
        durationSeconds: 165,
      },
      {
        externalId: 'B2',
        title: '贝斯叭叭叭 (DJ版)',
        artist: '泽亦龙',
        album: null,
        durationSeconds: 134,
      },
    ])
  })

  it('reads duration as seconds', async () => {
    fetchMock
      .mockResolvedValueOnce(page([song({ duration: 165 })]))
      .mockResolvedValueOnce(named('x'))

    const result = await fetchKugouPlaylist('4304395')

    expect(result.tracks[0].durationSeconds).toBe(165)
  })

  it('walks every page and keeps them in order', async () => {
    // Measured: at pagesize 50 a 107-track playlist returned 50, 50 and 7 rows,
    // `total` stayed 107 on every page, and the pages were disjoint.
    fetchMock
      .mockResolvedValueOnce(page([song({ filename: 'a - 1' }), song({ filename: 'a - 2' })], 3))
      .mockResolvedValueOnce(page([song({ filename: 'a - 3' })], 3))
      .mockResolvedValueOnce(named('Three'))

    const result = await fetchKugouPlaylist('4304395')

    expect(result.tracks.map((track) => track.title)).toEqual(['1', '2', '3'])
  })

  it('stops on a page that returns nothing, even if the total disagrees', async () => {
    // A service that disagrees with itself about `total` must not spin this
    // forever — the same guard `pendingMatches` needed for the same reason.
    fetchMock
      .mockResolvedValueOnce(page([song()], 99))
      .mockResolvedValueOnce(page([], 99))
      .mockResolvedValueOnce(named('Short'))

    // It read everything there was, and 1 < 99, so this is the truncation case.
    await expect(fetchKugouPlaylist('4304395')).rejects.toThrow(ExternalPlaylistTruncated)
    // Three calls: two pages and no more. Without the empty-page guard the loop
    // would have kept asking.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never asks for audio, which is the whole rule (ADR-013)', async () => {
    fetchMock.mockResolvedValueOnce(page([song()])).mockResolvedValueOnce(named('x'))

    await fetchKugouPlaylist('4304395')

    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain('trackercdn')
      expect(String(url)).not.toContain('getSongInfo')
      expect(String(url)).not.toContain('play/getdata')
    }
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v3/special/song')
  })

  it('uses a host whose certificate is valid', async () => {
    /*
     * ⚠️ #104 names `mobilecdn.kugou.com`, whose TLS certificate does not match
     * its hostname — measured 2026-08-16. HTTPS to it fails outright and
     * Android blocks the cleartext fallback, so the issue's host would have
     * produced an import that could never work on a phone.
     */
    fetchMock.mockResolvedValueOnce(page([song()])).mockResolvedValueOnce(named('x'))

    await fetchKugouPlaylist('4304395')

    expect(String(fetchMock.mock.calls[0][0])).toContain('https://mobiles.kugou.com/')
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('mobilecdn.kugou.com')
  })

  it('sends no cookie', async () => {
    fetchMock.mockResolvedValueOnce(page([song()])).mockResolvedValueOnce(named('x'))

    await fetchKugouPlaylist('4304395')

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers).not.toHaveProperty('Cookie')
    expect(init.headers).not.toHaveProperty('cookie')
  })

  it('keeps a track whose artist could not be split out', async () => {
    fetchMock
      .mockResolvedValueOnce(page([song({ filename: '安乐死' })]))
      .mockResolvedValueOnce(named('x'))

    const result = await fetchKugouPlaylist('4304395')

    // Kept, not dropped: an empty artist sends it to review, and losing it
    // silently would be the worse failure.
    expect(result.tracks).toEqual([expect.objectContaining({ title: '安乐死', artist: '' })])
  })

  it('falls back to the id when the name lookup fails', async () => {
    // A nameless import is cosmetic; a failed one is not. The name is the only
    // best-effort request in this file, and this is why.
    fetchMock
      .mockResolvedValueOnce(page([song()]))
      .mockRejectedValueOnce(new Error('network went away'))

    const result = await fetchKugouPlaylist('4304395')

    expect(result.name).toBe('Kugou 4304395')
    expect(result.tracks).toHaveLength(1)
  })

  it('fails loudly rather than importing a short playlist', async () => {
    fetchMock
      .mockResolvedValueOnce(page([song()], 107))
      .mockResolvedValueOnce(page([], 107))
      .mockResolvedValueOnce(named('x'))

    await expect(fetchKugouPlaylist('4304395')).rejects.toThrow(ExternalPlaylistTruncated)
  })

  it('reports a refusal as a refusal, not as an empty playlist', async () => {
    // A private or deleted 歌单 is an HTTP 200 with a `status` other than 1.
    // The code is asserted, not just the class: "empty" throws the same type,
    // so matching only the class cannot tell the two apart.
    fetchMock.mockResolvedValueOnce(ok({ status: 0, errcode: 20010, data: null }))

    await expect(fetchKugouPlaylist('4304395')).rejects.toMatchObject({
      name: 'ExternalSourceRefused',
      code: '20010',
    })
  })

  it('reports an HTTP failure with its status', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })

    await expect(fetchKugouPlaylist('4304395')).rejects.toMatchObject({
      name: 'ExternalSourceRefused',
      code: 'http_503',
    })
  })

  it('refuses an empty playlist rather than creating an import with no tracks', async () => {
    fetchMock.mockResolvedValueOnce(page([], 0))

    await expect(fetchKugouPlaylist('4304395')).rejects.toMatchObject({
      name: 'ExternalSourceRefused',
      code: 'empty',
    })
  })

  it('refuses a link it cannot read before making any request', async () => {
    await expect(fetchKugouPlaylist('https://example.com/nope')).rejects.toThrow(NotAKugouLink)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
