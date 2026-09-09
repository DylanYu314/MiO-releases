/**
 * #102 — reading a NetEase Cloud Music playlist on the device (ADR-013).
 *
 * The fixtures are the **real** shapes, read off `id=79177352` ("Billboard 2007
 * Top 100", 95 tracks) on 2026-08-16 while ADR-013 was being written — not
 * invented ones. The field names are the whole risk here: `ar` for artists, `dt`
 * for a duration in *milliseconds*, `al` for the album, and `trackIds` separate
 * from `tracks`. A guessed shape would parse to nulls and the import would look
 * like a bad matcher rather than a bad reader.
 */

import { fetchNeteasePlaylist, resolveShortLink } from '../src/library/netease'
import { ExternalPlaylistTruncated, ExternalSourceRefused } from '../src/library/externalPlaylist'
import {
  NotANeteaseLink,
  canonicalPlaylistUrl,
  isNeteasePlaylistLink,
  isNeteaseShortLink,
  neteasePlaylistId,
} from '../src/library/neteaseUrl'

describe('neteasePlaylistId', () => {
  it.each([
    ['https://music.163.com/#/playlist?id=79177352', '79177352'],
    ['http://music.163.com/#/playlist?id=79177352', '79177352'],
    ['https://music.163.com/playlist?id=79177352', '79177352'],
    ['https://music.163.com/m/playlist?id=79177352', '79177352'],
    ['https://y.music.163.com/m/playlist?id=79177352', '79177352'],
    ['https://music.163.com/#/discover/toplist?id=60198', '60198'],
    ['https://music.163.com/discover/toplist?id=60198', '60198'],
    ['https://music.163.com/#/playlist?id=79177352&userid=1', '79177352'],
    ['79177352', '79177352'],
    ['  https://music.163.com/#/playlist?id=79177352  ', '79177352'],
  ])('reads %s', (input, expected) => {
    expect(neteasePlaylistId(input)).toBe(expected)
  })

  it.each([
    'https://music.163.com/#/song?id=21534415',
    'https://music.163.com/#/album?id=133153666',
    'https://music.163.com/#/artist?id=10559',
    'https://music.163.com/',
    'https://www.youtube.com/playlist?list=PL1',
    'https://163cn.tv/abcdef',
    'not a url',
    '',
  ])('refuses %s', (input) => {
    expect(() => neteasePlaylistId(input)).toThrow(NotANeteaseLink)
  })

  it('refuses another site wearing the same route', () => {
    // The host check is the only thing rejecting these — every other rule they
    // satisfy. Without a case shaped exactly like a NetEase link but hosted
    // elsewhere, deleting `MAIN_HOST` passes the whole suite.
    expect(() => neteasePlaylistId('https://example.com/#/playlist?id=79177352')).toThrow(
      NotANeteaseLink,
    )
    expect(() => neteasePlaylistId('https://music.163.com.evil.test/playlist?id=1')).toThrow(
      NotANeteaseLink,
    )
  })

  it('refuses a playlist route with no numeric id', () => {
    // A route that looks right but carries nothing usable. Returning the raw
    // string would send a junk id to NetEase and report *its* answer, which is
    // a confusing way to say "that link has no playlist in it".
    expect(() => neteasePlaylistId('https://music.163.com/#/playlist?id=abc')).toThrow(
      NotANeteaseLink,
    )
    expect(() => neteasePlaylistId('https://music.163.com/#/playlist')).toThrow(NotANeteaseLink)
  })

  it('keeps the id a string, because these overflow a float', () => {
    // Real playlist ids reach 5347332390 today and NetEase hands out longer
    // ones; the id only ever travels back out as a query parameter.
    expect(neteasePlaylistId('https://music.163.com/#/playlist?id=5347332390')).toBe('5347332390')
  })
})

describe('isNeteaseShortLink', () => {
  it('is true for the share host and false for the real one', () => {
    expect(isNeteaseShortLink('https://163cn.tv/abcdef')).toBe(true)
    expect(isNeteaseShortLink('http://163cn.tv/abcdef')).toBe(true)
    expect(isNeteaseShortLink('https://music.163.com/#/playlist?id=1')).toBe(false)
  })
})

describe('isNeteasePlaylistLink', () => {
  it('accepts a short link, which has no id yet', () => {
    // Which *site*, not which playlist — the fetcher resolves it.
    expect(isNeteasePlaylistLink('https://163cn.tv/abcdef')).toBe(true)
    expect(isNeteasePlaylistLink('https://music.163.com/#/playlist?id=1')).toBe(true)
    expect(isNeteasePlaylistLink('https://www.youtube.com/playlist?list=PL1')).toBe(false)
  })
})

describe('canonicalPlaylistUrl', () => {
  it('round-trips through neteasePlaylistId', () => {
    expect(neteasePlaylistId(canonicalPlaylistUrl('79177352'))).toBe('79177352')
  })
})

// ── the reader ──────────────────────────────────────────────────────────────

const ok = (body: unknown) => ({ ok: true, status: 200, url: '', json: async () => body })

/** `playlist/detail`: every id, and only the first ten tracks in full. */
const detail = (ids: number[], over: Record<string, unknown> = {}) =>
  ok({
    code: 200,
    playlist: {
      name: 'Billboard 2007 Top 100',
      trackCount: ids.length,
      trackIds: ids.map((id) => ({ id })),
      tracks: [],
      ...over,
    },
  })

/** A row shaped exactly like the real ones. */
const song = (over: Record<string, unknown> = {}) => ({
  id: 21534415,
  name: 'Same Girl',
  ar: [
    { id: 1, name: 'R. Kelly' },
    { id: 2, name: 'Usher' },
  ],
  dt: 253910,
  al: { id: 3, name: 'Double Up' },
  ...over,
})

const songs = (rows: unknown[]) => ok({ code: 200, songs: rows })

describe('fetchNeteasePlaylist', () => {
  const fetchMock = jest.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('reads a playlist into the shape the import pipeline takes', async () => {
    fetchMock.mockResolvedValueOnce(detail([21534415, 22227939])).mockResolvedValueOnce(
      songs([
        song(),
        song({
          id: 22227939,
          name: 'Paralyzer',
          ar: [{ name: 'Finger Eleven' }],
          dt: 208133,
          al: { name: 'Them vs. You vs. Me' },
        }),
      ]),
    )

    const playlist = await fetchNeteasePlaylist('https://music.163.com/#/playlist?id=79177352')

    expect(playlist.service).toBe('netease')
    expect(playlist.name).toBe('Billboard 2007 Top 100')
    expect(playlist.sourceUrl).toBe('https://music.163.com/#/playlist?id=79177352')
    expect(playlist.tracks).toEqual([
      {
        externalId: '21534415',
        title: 'Same Girl',
        // Joined with ", " because `build_search_query` in matching.py splits
        // on it and searches with the primary artist only.
        artist: 'R. Kelly, Usher',
        album: 'Double Up',
        // `dt` is milliseconds and `durationSeconds` is seconds. A wrong unit
        // would not fail — it would score every candidate's duration at zero
        // credit, which reads as "the matcher got worse".
        durationSeconds: 253.91,
      },
      {
        externalId: '22227939',
        title: 'Paralyzer',
        artist: 'Finger Eleven',
        album: 'Them vs. You vs. Me',
        durationSeconds: 208.133,
      },
    ])
  })

  it('never asks for audio, which is the whole rule (ADR-013)', async () => {
    fetchMock.mockResolvedValueOnce(detail([1])).mockResolvedValueOnce(songs([song({ id: 1 })]))

    await fetchNeteasePlaylist('79177352')

    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls).toEqual([
      'https://music.163.com/api/v6/playlist/detail?id=79177352&n=5000',
      'https://music.163.com/api/v3/song/detail',
    ])
    // Neither endpoint returns a stream URL, so there is nothing to decline to
    // use. `song/url` and `song/enhance` are the ones that would.
    expect(urls.some((url) => /song\/(url|enhance)|music\.126\.net/.test(url))).toBe(false)
  })

  it('sends no cookie', async () => {
    fetchMock.mockResolvedValueOnce(detail([1])).mockResolvedValueOnce(songs([song({ id: 1 })]))
    await fetchNeteasePlaylist('79177352')

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers.Referer).toBe('https://music.163.com/')
    expect(headers.Cookie).toBeUndefined()
  })

  it('batches the detail call rather than asking per track', async () => {
    // 250 ids is two calls at DETAIL_CHUNK=200, not 250 calls. #102's design
    // was one yt-dlp extraction per track at 6.3 s each.
    const ids = Array.from({ length: 250 }, (_, index) => index + 1)
    fetchMock
      .mockResolvedValueOnce(detail(ids))
      .mockResolvedValueOnce(songs(ids.slice(0, 200).map((id) => song({ id }))))
      .mockResolvedValueOnce(songs(ids.slice(200).map((id) => song({ id }))))

    const playlist = await fetchNeteasePlaylist('79177352')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(playlist.tracks).toHaveLength(250)
  })

  it('keeps a track whose artist is missing', async () => {
    // An empty artist is a real answer. It caps the score under the auto
    // threshold, which sends the track to review — that is the point, and it
    // must not drop the track.
    fetchMock
      .mockResolvedValueOnce(detail([1]))
      .mockResolvedValueOnce(songs([song({ id: 1, ar: [], al: undefined, dt: 0 })]))

    const playlist = await fetchNeteasePlaylist('79177352')

    expect(playlist.tracks[0]).toEqual({
      externalId: '1',
      title: 'Same Girl',
      artist: '',
      album: null,
      durationSeconds: null,
    })
  })

  it('fails loudly rather than importing a short playlist', async () => {
    // ADR-013's consequence: every source states its own count, and a silently
    // truncated import cannot be detected by anything downstream.
    fetchMock
      .mockResolvedValueOnce(detail([1, 2, 3]))
      .mockResolvedValueOnce(songs([song({ id: 1 }), song({ id: 2 })]))

    await expect(fetchNeteasePlaylist('79177352')).rejects.toThrow(ExternalPlaylistTruncated)
  })

  it('reports a refusal as a refusal, not as an empty playlist', async () => {
    // NetEase answers HTTP 200 with a non-200 `code` for a private or deleted
    // playlist. Reading only the status would make "you may not have this" and
    // "this has nothing in it" the same thing, and only one is worth retrying.
    //
    // The body deliberately carries a `playlist` as well as the bad `code`:
    // with a code-less body the *next* check ("no playlist") throws the same
    // class, and a mutation removing the code check survived this test until
    // the fixture was fixed. The assertion is on `code` for the same reason.
    fetchMock.mockResolvedValueOnce(
      ok({ code: 401, msg: 'need login', playlist: { name: 'x', trackCount: 0, trackIds: [] } }),
    )

    await expect(fetchNeteasePlaylist('79177352')).rejects.toMatchObject({
      name: 'ExternalSourceRefused',
      code: '401',
    })
  })

  it('reports an HTTP failure with its status', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, url: '', json: async () => ({}) })

    await expect(fetchNeteasePlaylist('79177352')).rejects.toMatchObject({
      name: 'ExternalSourceRefused',
      code: 'http_503',
    })
  })

  it('refuses an empty playlist rather than creating an import with no tracks', async () => {
    fetchMock.mockResolvedValueOnce(detail([]))

    await expect(fetchNeteasePlaylist('79177352')).rejects.toThrow(ExternalSourceRefused)
  })

  it('follows a share link before reading it', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://music.163.com/#/playlist?id=79177352',
        json: async () => ({}),
      })
      .mockResolvedValueOnce(detail([1]))
      .mockResolvedValueOnce(songs([song({ id: 1 })]))

    const playlist = await fetchNeteasePlaylist('https://163cn.tv/abcdef')

    expect(playlist.sourceUrl).toBe('https://music.163.com/#/playlist?id=79177352')
  })
})

describe('resolveShortLink', () => {
  const fetchMock = jest.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('says a link did not resolve rather than calling it a bad link', async () => {
    // `response.url` is the part that cannot be verified off a device — the
    // same seam as `resolveShortLink` for Bilibili. A runtime that leaves it
    // empty must produce a failure that names *that*, not "not a NetEase link".
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, url: '', json: async () => ({}) })

    await expect(resolveShortLink('https://163cn.tv/abcdef')).rejects.toMatchObject({
      code: 'short_link',
    })
  })
})
