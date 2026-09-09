import { ExternalPlaylistTruncated, ExternalSourceRefused } from '../src/library/externalPlaylist'
import { fetchQQPlaylist } from '../src/library/qq'
import {
  canonicalQQPlaylistUrl,
  isQQPlaylistLink,
  NotAQQLink,
  qqPlaylistId,
} from '../src/library/qqUrl'

/**
 * Reading a QQ Music 歌单 on the device (#103, ADR-013).
 *
 * The fixtures below are shaped from a real response measured 2026-08-16 —
 * field names, types and nesting — rather than from the issue, whose account of
 * this endpoint was wrong twice: it claims cookies are required (that is the
 * per-song extractor, which MiO never calls) and does not mention that the
 * endpoint answers JSONP unless `format=json` is passed.
 */

describe('qqPlaylistId', () => {
  it.each([
    ['https://y.qq.com/n/ryqq/playlist/7707261125', '7707261125'],
    ['https://y.qq.com/n/ryqq/playlist/7707261125/', '7707261125'],
    // The previous web player, still handed out by older links.
    ['https://y.qq.com/n/yqq/playlist/7707261125.html', '7707261125'],
    // The successor route. It costs nothing because the match is on the tail.
    ['https://y.qq.com/n/ryqq_v2/playlist/7799808010', '7799808010'],
    // An older share page — the id is a query parameter here.
    ['https://i.y.qq.com/n2/m/share/details/taoge.html?id=7707261125', '7707261125'],
    ['https://c.y.qq.com/n/ryqq/playlist/7707261125', '7707261125'],
    /*
     * ⚠️ **What a phone actually produces** (#564), pasted verbatim from
     * My 2026-08-17 pass, query string and all.
     *
     * Three separate things about it were refused before that day: the `i2.`
     * host (the allow-list named `i.`, `c.`, `m.` and `www.`), the
     * `details/playlist.html` route, and nothing looked at `disstid`. The QQ
     * Music app offers no "copy link" and no "open in browser", so this is the
     * *only* URL a phone user can obtain — the feature worked from a desktop
     * browser and was unreachable from the device the app runs on.
     */
    [
      'https://i2.y.qq.com/n3/other/pages/details/playlist.html?platform=11&appshare=android_qq&appversion=20040503&hosteuin=oK6kowEAoK4z7ec57Kv5oiCANv**&id=7256920196&ADTAG=wxfshare',
      '7256920196',
    ],
    // QQ's own name for the parameter, on links that use it instead of `id`.
    [
      'https://i.y.qq.com/n3/other/pages/details/playlist.html?disstid=734191243&foo=bar',
      '734191243',
    ],
    // A bare id, which is what a `source_url` round-trip produces — and, since
    // #564, what the screen tells the user to paste when there is no link.
    ['7707261125', '7707261125'],
  ])('reads %s', (input, expected) => {
    expect(qqPlaylistId(input)).toBe(expected)
  })

  it('refuses another site wearing the same route', () => {
    // The host check is the whole defence here: the path is generic enough that
    // any site could carry it, and a lookalike domain must not pass.
    expect(() => qqPlaylistId('https://example.com/n/ryqq/playlist/7707261125')).toThrow(NotAQQLink)
    expect(() => qqPlaylistId('https://y.qq.com.evil.test/n/ryqq/playlist/1')).toThrow(NotAQQLink)
  })

  it('refuses a QQ page that is not a playlist', () => {
    // `?id=` on some other QQ route is a song or an album, not a 歌单 — which is
    // why the route is matched rather than the id being regexed out.
    expect(() => qqPlaylistId('https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV')).toThrow(
      NotAQQLink,
    )
    expect(() => qqPlaylistId('https://i.y.qq.com/n2/m/share/details/album.html?id=123')).toThrow(
      NotAQQLink,
    )
    /*
     * The one that the widened host must not have cost us (#564).
     *
     * `album.html` sits on the same `i2.` host and the same
     * `/n3/other/pages/details/` directory as the playlist page above, and
     * carries an identically shaped `id`. It is the reason the *route* stayed
     * strict while the host was loosened: reading the id out of any
     * `i2.y.qq.com` URL that has one would import an album as a 歌单.
     */
    expect(() =>
      qqPlaylistId('https://i2.y.qq.com/n3/other/pages/details/album.html?id=7256920196'),
    ).toThrow(NotAQQLink)
  })

  it('accepts any y.qq.com subdomain, and nothing merely ending in one', () => {
    // The numbered hosts are load balancing — `i2` today, `i3` tomorrow — so
    // the allow-list that refused my link is gone. What replaced it still
    // has to reject a lookalike, and the two cases below are the boundary:
    // `i9.y.qq.com` is Tencent's, `evily.qq.com` is not.
    expect(qqPlaylistId('https://i9.y.qq.com/n3/other/pages/details/playlist.html?id=1')).toBe('1')
    expect(() => qqPlaylistId('https://evily.qq.com/n/ryqq/playlist/1')).toThrow(NotAQQLink)
  })

  it('refuses a playlist route with no numeric id', () => {
    expect(() => qqPlaylistId('https://y.qq.com/n/ryqq/playlist/abc')).toThrow(NotAQQLink)
    expect(() => qqPlaylistId('https://y.qq.com/n/ryqq/playlist/')).toThrow(NotAQQLink)
  })

  it('keeps the id a string, because these overflow a float', () => {
    // 7707261125 is already past 2^32 and QQ hands out longer ones. Parsing to a
    // number would round it and read someone else's playlist.
    expect(qqPlaylistId('https://y.qq.com/n/ryqq/playlist/9007199254740993')).toBe(
      '9007199254740993',
    )
  })
})

describe('isQQPlaylistLink', () => {
  it('separates a QQ playlist from everything else', () => {
    expect(isQQPlaylistLink('https://y.qq.com/n/ryqq/playlist/7707261125')).toBe(true)
    expect(isQQPlaylistLink('https://music.163.com/#/playlist?id=79177352')).toBe(false)
    expect(isQQPlaylistLink('not a url at all')).toBe(false)
  })
})

describe('canonicalQQPlaylistUrl', () => {
  it('round-trips through qqPlaylistId', () => {
    // Two spellings of one playlist must become one `source_url`, or a
    // re-import builds a second copy.
    expect(qqPlaylistId(canonicalQQPlaylistUrl('7707261125'))).toBe('7707261125')
  })
})

// ── the reader ──────────────────────────────────────────────────────────────

const ok = (body: unknown) => ({ ok: true, status: 200, url: '', json: async () => body })

/** A row shaped exactly like the real ones, including the fields we ignore. */
const song = (over: Record<string, unknown> = {}) => ({
  songmid: '0039MnYb0qxYhV',
  songid: 5062307,
  songname: '你的',
  singer: [{ name: 'DouDou' }, { name: 'Viva宋佩豫' }],
  interval: 163,
  albumname: '你的',
  // Present in the real payload and deliberately kept: they are identifiers and
  // byte counts, never URLs, which is the point ADR-013 turns on.
  strMediaMid: '0039MnYb0qxYhV',
  size128: 2612345,
  size320: 6530862,
  ...over,
})

const playlist = (rows: unknown[], over: Record<string, unknown> = {}) =>
  ok({
    code: 0,
    subcode: 0,
    cdlist: [
      {
        dissname: '甜度爆表 | 旋律说唱狙击少女心',
        songnum: rows.length,
        songlist: rows,
        ...over,
      },
    ],
  })

describe('fetchQQPlaylist', () => {
  const fetchMock = jest.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('reads a playlist into the shape the import pipeline takes', async () => {
    fetchMock.mockResolvedValueOnce(
      playlist([
        song(),
        song({
          songmid: 'x2',
          songname: 'Dawn of us',
          singer: [{ name: '王嘉尔' }],
          interval: 179,
          albumname: 'Dawn of us',
        }),
      ]),
    )

    const result = await fetchQQPlaylist('https://y.qq.com/n/ryqq/playlist/7707261125')

    expect(result.service).toBe('qq')
    expect(result.name).toBe('甜度爆表 | 旋律说唱狙击少女心')
    expect(result.sourceUrl).toBe('https://y.qq.com/n/ryqq/playlist/7707261125')
    expect(result.tracks).toEqual([
      {
        externalId: '0039MnYb0qxYhV',
        title: '你的',
        // Both singers, joined the way `netease.ts` joins them, so a track that
        // exists on both services scores identically either way.
        artist: 'DouDou, Viva宋佩豫',
        album: '你的',
        durationSeconds: 163,
      },
      {
        externalId: 'x2',
        title: 'Dawn of us',
        artist: '王嘉尔',
        album: 'Dawn of us',
        durationSeconds: 179,
      },
    ])
  })

  it('reads interval as seconds, not milliseconds', async () => {
    // NetEase's `dt` is millis and QQ's `interval` is seconds. Getting this
    // backwards would divide every duration by 1000 and silently switch off the
    // strongest discriminator the scorer has against covers and live cuts.
    fetchMock.mockResolvedValueOnce(playlist([song({ interval: 163 })]))

    const result = await fetchQQPlaylist('7707261125')

    expect(result.tracks[0].durationSeconds).toBe(163)
  })

  it('never asks for audio, which is the whole rule (ADR-013)', async () => {
    fetchMock.mockResolvedValueOnce(playlist([song()]))

    await fetchQQPlaylist('7707261125')

    const [url] = fetchMock.mock.calls[0]
    // The metadata endpoint, and nothing that mints a playable URL. The real
    // payload carries no audio URL at all, so this is a guarantee rather than a
    // prohibition — but the request is the half we control.
    expect(url).toContain('fcg_ucc_getcdinfo_byids_cp.fcg')
    expect(url).not.toContain('vkey')
    expect(url).not.toContain('getplaysongvkey')
  })

  it('asks for JSON, because the endpoint answers JSONP by default', async () => {
    // Without `format=json` the body is `jsonCallback({…})`, which
    // `response.json()` cannot parse. Measured, and not mentioned in the issue.
    fetchMock.mockResolvedValueOnce(playlist([song()]))

    await fetchQQPlaylist('7707261125')

    expect(fetchMock.mock.calls[0][0]).toContain('format=json')
  })

  it('sends no cookie', async () => {
    // #534's lesson, measured there: a visitor id alone answered OK and the
    // same request plus a cookie jar answered LOGIN_REQUIRED. Nothing here
    // needs an account, so nothing here sends one.
    fetchMock.mockResolvedValueOnce(playlist([song()]))

    await fetchQQPlaylist('7707261125')

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers).not.toHaveProperty('Cookie')
    expect(init.headers).not.toHaveProperty('cookie')
  })

  it('reads the whole playlist in one request', async () => {
    // Measured: 1223 tracks came back in a single 922 KB response and there is
    // no offset to pass. If that ever changes this test is what notices.
    fetchMock.mockResolvedValueOnce(playlist(Array.from({ length: 300 }, () => song())))

    const result = await fetchQQPlaylist('7707261125')

    expect(result.tracks).toHaveLength(300)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a track whose artist is missing', async () => {
    // An empty artist is a real answer: it caps the match score at 0.70, under
    // the 0.80 auto threshold, so the track goes to review rather than to a
    // wrong song. Dropping it would lose it silently instead.
    fetchMock.mockResolvedValueOnce(playlist([song({ singer: [] })]))

    const result = await fetchQQPlaylist('7707261125')

    expect(result.tracks).toHaveLength(1)
    expect(result.tracks[0].artist).toBe('')
  })

  it('fails loudly rather than importing a short playlist', async () => {
    // QQ states the length in `songnum`, and every playlist measured returned
    // exactly that many rows — so a shortfall is a request that half worked.
    fetchMock.mockResolvedValueOnce(playlist([song()], { songnum: 66 }))

    await expect(fetchQQPlaylist('7707261125')).rejects.toThrow(ExternalPlaylistTruncated)
  })

  it('reports a refusal as a refusal, not as an empty playlist', async () => {
    // A private or deleted 歌单 is an HTTP 200 with `code: -1` and no cdlist.
    // Reading only the status would turn it into "this playlist has no tracks",
    // which is the one thing ADR-013 says must not happen.
    fetchMock.mockResolvedValueOnce(ok({ code: -1, subcode: 0, cdlist: [] }))

    // The *code* is asserted, not merely the class. A refused body also has an
    // empty `cdlist`, so "no playlist" throws the same type — and a first
    // version of this test passed with the code check deleted entirely.
    await expect(fetchQQPlaylist('7707261125')).rejects.toMatchObject({
      name: 'ExternalSourceRefused',
      code: '-1',
    })
  })

  it('reports an HTTP failure with its status', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })

    await expect(fetchQQPlaylist('7707261125')).rejects.toMatchObject({
      name: 'ExternalSourceRefused',
      code: 'http_503',
    })
  })

  it('refuses an empty playlist rather than creating an import with no tracks', async () => {
    fetchMock.mockResolvedValueOnce(playlist([]))

    await expect(fetchQQPlaylist('7707261125')).rejects.toThrow(ExternalSourceRefused)
  })

  it('refuses a link it cannot read before making any request', async () => {
    await expect(fetchQQPlaylist('https://example.com/nope')).rejects.toThrow(NotAQQLink)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
