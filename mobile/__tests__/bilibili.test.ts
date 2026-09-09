import {
  BilibiliRefused,
  extractBilibiliAudio,
  listBilibiliParts,
  sourceUrlFor,
} from '../src/library/bilibili'
import {
  NotABilibiliLink,
  canonicalUrlFor,
  isBilibiliLink,
  isShortLink,
  refFrom,
} from '../src/library/bilibiliUrl'
import { classifyFailure, isWorthRetrying } from '../src/library/failureKind'
import { canImportOnDevice, platformOf, sourceLabelKey } from '../src/library/sources'

/**
 * Fetching Bilibili on the device (#492).
 *
 * ## What these can and cannot say
 *
 * `fetch` is faked, so what is under test is **the shape of the requests** and
 * what is made of the answers — which is exactly where this feature has been
 * wrong before. Three issues explained Bilibili's 412 as rate limiting (#214),
 * as the droplet's address (#327) and as the `b23.tv` short link (#381); it was
 * a missing `buvid3` cookie, measured 2026-08-13 by alternating request shapes
 * over three rounds.
 *
 * So the cookie, the `Referer` and the canonical URL are asserted here, because
 * those are the parts a silent change would break with no test to notice.
 *
 * What no test here can say is that Bilibili still answers this way, or that
 * React Native's `fetch` lets the cookie out at all — OkHttp keeps a cookie jar
 * of its own. That is the first thing to check on a device.
 */

import { resetWbiKeyCache } from '../src/library/bilibiliWbi'

// Module state, and it outlives a test — a cached key from one would hide a
// missing nav handler in the next.
beforeEach(() => resetWbiKeyCache())

type Handler = (url: string, init?: RequestInit) => { status?: number; body?: unknown }

/** A Bilibili that answers by URL, so one canned body cannot stand in for four
 *  different endpoints. */
function serve(handlers: [RegExp, Handler][], seen?: { url: string; init?: RequestInit }[]) {
  /*
   * `nav` is answered for every test that does not override it (2026-09-08).
   *
   * ⛔ Since Bilibili retired the unsigned `x/web-interface/view`, the metadata
   * call is signed, and signing fetches the wbi keys from `nav` first. Without
   * this, every extraction test fails on a missing key rather than on the thing
   * it is testing.
   */
  const withNav: [RegExp, Handler][] = [
    ...handlers,
    [
      /web-interface\/nav/,
      () => ({
        // `code: -101` is what nav really answers when signed out, and it still
        // carries the keys — the trap the signing code documents.
        body: {
          code: -101,
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
            },
          },
        },
      }),
    ],
  ]

  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    seen?.push({ url: String(url), init })
    const hit = withNav.find(([pattern]) => pattern.test(String(url)))
    const answer = hit ? hit[1](String(url), init) : { status: 404, body: {} }
    const status = answer.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      url: String(url),
      json: async () => answer.body,
    }
  }) as unknown as typeof fetch
}

const view = (overrides: Record<string, unknown> = {}) => ({
  code: 0,
  data: {
    bvid: 'BV1xx411c7mD',
    title: 'A song',
    pic: '//i0.hdslb.com/bfs/archive/cover.jpg',
    duration: 214,
    cid: 62131,
    owner: { name: 'An Uploader' },
    ...overrides,
  },
})

const playurl = (overrides: Record<string, unknown> = {}) => ({
  code: 0,
  data: {
    dash: {
      audio: [
        { baseUrl: 'https://upos-sz.bilivideo.com/low.m4s', bandwidth: 68646 },
        { baseUrl: 'https://upos-sz.bilivideo.com/high.m4s', bandwidth: 132000, size: 4096 },
      ],
    },
    ...overrides,
  },
})

const HAPPY: [RegExp, Handler][] = [
  [/web-interface\/(wbi\/)?view/, () => ({ body: view() })],
  [/player\/playurl/, () => ({ body: playurl() })],
]

describe('reading a Bilibili link', () => {
  it.each([
    ['https://www.bilibili.com/video/BV1xx411c7mD', { bvid: 'BV1xx411c7mD' }],
    /*
     * ⚠️ This row used to assert `{ bvid }` with **no part** — it pinned the
     * bug (#575). `?p=` was parsed by nothing, so a link to part 3 of a 33-part
     * album fetched part 1 under the whole upload's title, and this test said
     * that was correct.
     */
    ['https://m.bilibili.com/video/BV1xx411c7mD?p=2', { bvid: 'BV1xx411c7mD', part: 2 }],
    // Part one is the same identity as no part at all, deliberately: a `?p=1`
    // link and a bare one are the same track and must not become two rows.
    ['https://www.bilibili.com/video/BV1xx411c7mD?p=1', { bvid: 'BV1xx411c7mD', part: 1 }],
    // Values Bilibili itself ignores are treated as absent rather than as
    // errors — refusing an otherwise perfectly good link over a query
    // parameter would be the worse answer.
    ['https://www.bilibili.com/video/BV1xx411c7mD?p=0', { bvid: 'BV1xx411c7mD' }],
    ['https://www.bilibili.com/video/BV1xx411c7mD?p=two', { bvid: 'BV1xx411c7mD' }],
    ['https://www.bilibili.com/video/av170001?p=4', { aid: '170001', part: 4 }],
    ['BV1xx411c7mD', { bvid: 'BV1xx411c7mD' }],
    // The `av` form is what Bilibili's own search results hand back, so this
    // will matter again the moment search lands.
    ['https://www.bilibili.com/video/av170001', { aid: '170001' }],
    ['av170001', { aid: '170001' }],
  ])('%s', (input, expected) => {
    expect(refFrom(input)).toEqual(expected)
  })

  it('refuses a short link rather than guessing an id out of it', () => {
    // There is no id in a `b23.tv` link. Returning something plausible would be
    // worse than saying so — the extractor resolves it with a request first.
    expect(() => refFrom('https://b23.tv/vtV4k1G')).toThrow(NotABilibiliLink)
    expect(isShortLink('https://b23.tv/vtV4k1G')).toBe(true)
    // …and it is still a Bilibili link, which is what the screens ask.
    expect(isBilibiliLink('https://b23.tv/vtV4k1G')).toBe(true)
  })

  it('does not claim links belonging to anyone else', () => {
    expect(isBilibiliLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false)
    expect(isBilibiliLink('https://example.com/song.mp3')).toBe(false)
    expect(isBilibiliLink('not a url at all')).toBe(false)
    // A near miss: right host, no video in it.
    expect(isBilibiliLink('https://www.bilibili.com/anime')).toBe(false)
  })
})

describe('which extractor a link goes to', () => {
  it('routes each site to its own', () => {
    expect(platformOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube')
    expect(platformOf('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('bilibili')
    expect(platformOf('https://b23.tv/vtV4k1G')).toBe('bilibili')
    expect(platformOf('https://example.com/song.mp3')).toBeNull()
  })

  it('names the service a message about that link should blame (#565)', () => {
    // The failure copy interpolates this. It used to say "YouTube" for every
    // `VideoUnavailable`, including the ones Bilibili throws.
    expect(sourceLabelKey('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'searchSource.youtube',
    )
    expect(sourceLabelKey('https://b23.tv/vtV4k1G')).toBe('searchSource.bilibili')
    // Neutral rather than a guess: `add/bilibili.tsx` sends links the device
    // cannot read to the server, and naming one of our two would be the same
    // bug in different clothes.
    expect(sourceLabelKey('https://example.com/song.mp3')).toBe('searchSource.unknown')
  })

  it('accepts both sites for import, which is the whole of #492 on this screen', () => {
    expect(canImportOnDevice('https://www.bilibili.com/video/BV1xx411c7mD')).toBe(true)
    expect(canImportOnDevice('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
    expect(canImportOnDevice('https://example.com/song.mp3')).toBe(false)
  })
})

describe('extracting', () => {
  it('sends the cookie that the whole feature turned out to rest on', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    serve(HAPPY, seen)

    await extractBilibiliAudio('https://www.bilibili.com/video/BV1xx411c7mD')

    // Measured: bare and UA+Referer both answered 412; only the cookie answered
    // 200 three times out of three.
    for (const call of seen) {
      const headers = call.init?.headers as Record<string, string>
      expect(headers.Cookie).toMatch(/^buvid3=[0-9a-f-]{36}infoc$/)
      expect(headers.Referer).toBe('https://www.bilibili.com/')
      expect(headers['User-Agent']).toContain('Mozilla/5.0')
    }
  })

  it('mints a fresh cookie per extraction, so a retry is not the same request', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    serve(HAPPY, seen)

    await extractBilibiliAudio('BV1xx411c7mD')
    await extractBilibiliAudio('BV1xx411c7mD')

    const cookies = new Set(
      seen.map((call) => (call.init?.headers as Record<string, string>).Cookie),
    )
    expect(cookies.size).toBe(2)
  })

  it('reads the song off the two calls, and picks the best audio', async () => {
    serve(HAPPY)

    const audio = await extractBilibiliAudio('https://www.bilibili.com/video/BV1xx411c7mD')

    expect(audio).toMatchObject({
      video_id: 'BV1xx411c7mD',
      title: 'A song',
      artist: 'An Uploader',
      duration: 214,
      // Highest bandwidth, which is how Bilibili orders quality.
      audio_url: 'https://upos-sz.bilivideo.com/high.m4s',
      content_length: 4096,
      client: 'bilibili-web',
    })
    // Protocol-relative, which is a URL no fetch can use.
    expect(audio.cover_url).toBe('https://i0.hdslb.com/bfs/archive/cover.jpg')
  })

  it('hands the download the Referer, without which the CDN answers 403', async () => {
    serve(HAPPY)

    const audio = await extractBilibiliAudio('BV1xx411c7mD')

    // Measured both ways on the same URL seconds apart: 403 without, 206 with.
    // `http_headers` has been an unused seam since #246 for exactly this.
    expect(audio.http_headers.Referer).toBe('https://www.bilibili.com/')
    expect(audio.http_headers['User-Agent']).toContain('Mozilla/5.0')
  })

  it('says loudness is unknown rather than inventing one', async () => {
    // YouTube ships a measurement and Bilibili does not. `normalizationGain`
    // already reads null as "no correction"; a zero would read as "measured, and
    // it needs none", which is a different and false claim.
    serve(HAPPY)

    expect((await extractBilibiliAudio('BV1xx411c7mD')).loudness_lufs).toBeNull()
  })

  it('takes the first part of a multi-part video rather than refusing it', async () => {
    serve([
      [
        /web-interface\/(wbi\/)?view/,
        () => ({ body: view({ cid: undefined, pages: [{ cid: 999 }] }) }),
      ],
      [/player\/playurl/, () => ({ body: playurl() })],
    ])

    await expect(extractBilibiliAudio('BV1xx411c7mD')).resolves.toMatchObject({
      video_id: 'BV1xx411c7mD',
    })
  })

  /*
   * Multi-part uploads — Bilibili's 多P (#575).
   *
   * The fixture is shaped from a real payload, `BV1r84y1e77t` measured
   * 2026-08-17: 33 parts, each row carrying `page` (1-based), `cid`, `part`
   * (its own title) and `duration`, and the view's top-level `cid` exactly
   * equal to `pages[0].cid` — which is why the old code was *always* part one
   * rather than sometimes right.
   */
  const album = (overrides: Record<string, unknown> = {}) =>
    view({
      title: 'The Whole Album',
      cid: 952077940,
      pages: [
        { page: 1, cid: 952077940, part: 'Show You', duration: 178 },
        { page: 2, cid: 952079318, part: 'Find Me', duration: 188 },
        { page: 3, cid: 952080258, part: 'Want U 2', duration: 183 },
      ],
      ...overrides,
    })

  it('fetches the part the link names, not always the first', async () => {
    const asked: string[] = []
    serve([
      [/web-interface\/(wbi\/)?view/, () => ({ body: album() })],
      [
        /player\/playurl/,
        (url: string) => {
          asked.push(url)
          return { body: playurl() }
        },
      ],
    ])

    await extractBilibiliAudio('https://www.bilibili.com/video/BV1xx411c7mD?p=3')

    // The whole bug: `?p=` was parsed by nothing, so this was 952077940 — part
    // one — for every part anyone pasted.
    expect(asked[0]).toContain('cid=952080258')
  })

  it('trusts the page number, not the position in the array', async () => {
    /*
     * ⚠️ **The fixture is deliberately out of order**, and that is the whole
     * test. Bilibili returns `pages` in order in every payload measured, so a
     * fixture that mirrors reality cannot tell `find(p => p.page === n)` apart
     * from `pages[n - 1]` — a mutation swapping one for the other survived
     * until this existed.
     *
     * `page` is a field the API states; array order is an assumption nobody
     * promised. Matching on the stated field is a guarantee, and this is what
     * makes that claim mean something rather than being a comment.
     */
    const asked: string[] = []
    serve([
      [
        /web-interface\/(wbi\/)?view/,
        () => ({
          body: view({
            cid: 952077940,
            pages: [
              { page: 3, cid: 952080258, part: 'Want U 2', duration: 183 },
              { page: 1, cid: 952077940, part: 'Show You', duration: 178 },
              { page: 2, cid: 952079318, part: 'Find Me', duration: 188 },
            ],
          }),
        }),
      ],
      [
        /player\/playurl/,
        (url: string) => {
          asked.push(url)
          return { body: playurl() }
        },
      ],
    ])

    const audio = await extractBilibiliAudio('https://www.bilibili.com/video/BV1xx411c7mD?p=2')

    expect(asked[0]).toContain('cid=952079318')
    expect(audio.title).toBe('Find Me')
  })

  it("uses the part's own title, which is what makes it a song", async () => {
    serve([
      [/web-interface\/(wbi\/)?view/, () => ({ body: album() })],
      [/player\/playurl/, () => ({ body: playurl() })],
    ])

    const audio = await extractBilibiliAudio('https://www.bilibili.com/video/BV1xx411c7mD?p=2')

    // Not "The Whole Album" three times over.
    expect(audio.title).toBe('Find Me')
  })

  it('⚠️ gives each part its own identity', async () => {
    /*
     * `songs.source_url` is UNIQUE since v6. Without the part in the URL every
     * piece of one upload is the same row, so importing part 2 after part 1
     * collides with it and the user gets one track for two requests.
     */
    serve([
      [/web-interface\/(wbi\/)?view/, () => ({ body: album() })],
      [/player\/playurl/, () => ({ body: playurl() })],
    ])

    const second = await extractBilibiliAudio('https://www.bilibili.com/video/BV1xx411c7mD?p=2')
    const third = await extractBilibiliAudio('https://www.bilibili.com/video/BV1xx411c7mD?p=3')

    expect(sourceUrlFor(second)).not.toBe(sourceUrlFor(third))
    expect(sourceUrlFor(second)).toBe('https://www.bilibili.com/video/BV1xx411c7mD?p=2')
  })

  it('leaves an ordinary link"s identity exactly as it was', async () => {
    // The control, and the reason part one carries no `?p=`: anything already
    // in a library must not re-import as a duplicate of itself.
    serve([
      [/web-interface\/(wbi\/)?view/, () => ({ body: album() })],
      [/player\/playurl/, () => ({ body: playurl() })],
    ])

    const bare = await extractBilibiliAudio('https://www.bilibili.com/video/BV1xx411c7mD')
    const first = await extractBilibiliAudio('https://www.bilibili.com/video/BV1xx411c7mD?p=1')

    expect(sourceUrlFor(bare)).toBe('https://www.bilibili.com/video/BV1xx411c7mD')
    expect(sourceUrlFor(first)).toBe(sourceUrlFor(bare))
  })

  it('falls back to the first part when the link names one that is not there', async () => {
    /*
     * The same judgement the YouTube path makes about a video inside a playlist
     * URL: the user pasted a link to a thing, and one song is a better answer
     * than an error.
     *
     * ⚠️ And the identity must **not** carry the part they asked for, or a
     * mistyped link would become its own library row pointing at part one.
     */
    serve([
      [/web-interface\/(wbi\/)?view/, () => ({ body: album() })],
      [/player\/playurl/, () => ({ body: playurl() })],
    ])

    const audio = await extractBilibiliAudio('https://www.bilibili.com/video/BV1xx411c7mD?p=99')

    // Part one's audio *and* part one's title. Falling back on the cid while
    // keeping the album's name was the first version of this fix, and it
    // produced a track whose title described something else entirely.
    expect(audio.title).toBe('Show You')
    expect(audio.duration).toBe(178)
    expect(sourceUrlFor(audio)).toBe('https://www.bilibili.com/video/BV1xx411c7mD')
  })

  it('names a bare multi-part link after the part it downloads', async () => {
    // No `?p=` at all still means part one, so calling it after the whole
    // upload is the same confusion in a quieter form.
    serve([
      [/web-interface\/(wbi\/)?view/, () => ({ body: album() })],
      [/player\/playurl/, () => ({ body: playurl() })],
    ])

    const audio = await extractBilibiliAudio('https://www.bilibili.com/video/BV1xx411c7mD')

    expect(audio.title).toBe('Show You')
    expect(audio.duration).toBe(178)
  })

  it('leaves an ordinary single-part video named as it always was', async () => {
    /*
     * The control that keeps the rule narrow. A single video also has one
     * `pages` row, and its `part` is often a placeholder rather than a title —
     * renaming every ordinary import would be a much bigger change than this
     * issue asked for, and a worse one.
     */
    serve([
      [
        /web-interface\/(wbi\/)?view/,
        () => ({ body: view({ pages: [{ page: 1, cid: 62131, part: 'P1', duration: 214 }] }) }),
      ],
      [/player\/playurl/, () => ({ body: playurl() })],
    ])

    const audio = await extractBilibiliAudio('BV1xx411c7mD')

    expect(audio.title).toBe('A song')
  })

  it('lists the parts of a multi-part upload, for the picker (#575)', async () => {
    /*
     * Asked *before* anything is imported, so the app knows whether there is a
     * question to put to the user. One `view` call — the same one the extractor
     * was about to make — so asking costs what the answer was going to cost.
     */
    serve([
      [/web-interface\/(wbi\/)?view/, () => ({ body: album() })],
      [/player\/playurl/, () => ({ body: playurl() })],
    ])

    const video = await listBilibiliParts('https://www.bilibili.com/video/BV1xx411c7mD')

    expect(video.title).toBe('The Whole Album')
    expect(video.parts.map((part) => part.page)).toEqual([1, 2, 3])
    expect(video.parts.map((part) => part.title)).toEqual(['Show You', 'Find Me', 'Want U 2'])
    expect(video.parts.map((part) => part.durationSeconds)).toEqual([178, 188, 183])
    // Each part's own canonical URL, which is what the import loop walks and
    // what `songs.source_url` will hold. Part one carries no `?p=`.
    expect(video.parts.map((part) => part.url)).toEqual([
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
      'https://www.bilibili.com/video/BV1xx411c7mD?p=3',
    ])
  })

  it('gives an ordinary video one part, so the caller has one shape', async () => {
    // Not two shapes and a branch at every call site. The single part uses
    // `view.title` rather than the page row's `part`, for the same reason the
    // extractor does: an ordinary upload's one row often holds a placeholder.
    serve([
      [
        /web-interface\/(wbi\/)?view/,
        () => ({ body: view({ pages: [{ page: 1, cid: 62131, part: 'P1', duration: 214 }] }) }),
      ],
      [/player\/playurl/, () => ({ body: playurl() })],
    ])

    const video = await listBilibiliParts('BV1xx411c7mD')

    expect(video.parts).toHaveLength(1)
    expect(video.parts[0].title).toBe('A song')
    expect(video.parts[0].url).toBe('https://www.bilibili.com/video/BV1xx411c7mD')
  })

  it('leaves out a part with no page number, which cannot be addressed', async () => {
    // `?p=` names the `page` field. A row without one cannot be imported, so
    // offering it in the picker would be offering something that fails.
    serve([
      [
        /web-interface\/(wbi\/)?view/,
        () => ({
          body: view({
            pages: [
              { page: 1, cid: 1, part: 'One', duration: 10 },
              { cid: 2, part: 'Nameless', duration: 10 },
              { page: 3, cid: 3, part: 'Three', duration: 10 },
            ],
          }),
        }),
      ],
      [/player\/playurl/, () => ({ body: playurl() })],
    ])

    const video = await listBilibiliParts('BV1xx411c7mD')

    expect(video.parts.map((part) => part.page)).toEqual([1, 3])
  })

  it('resolves a short link and then reads where it landed', async () => {
    // `response.url` is the only thing carrying the redirect target, and it is
    // the part untested outside a device.
    globalThis.fetch = jest.fn(async (url: string) => {
      const target = String(url).includes('b23.tv')
        ? 'https://www.bilibili.com/video/BV1xx411c7mD'
        : String(url)
      const body = /web-interface\/nav/.test(target)
        ? {
            code: -101,
            data: {
              wbi_img: {
                img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
                sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
              },
            },
          }
        : /playurl/.test(target)
          ? playurl()
          : view()
      return { ok: true, status: 200, url: target, json: async () => body }
    }) as unknown as typeof fetch

    await expect(extractBilibiliAudio('https://b23.tv/vtV4k1G')).resolves.toMatchObject({
      video_id: 'BV1xx411c7mD',
    })
  })
})

describe('when Bilibili says no', () => {
  it('names a 412 as a refusal of the request, not of the video', async () => {
    /*
     * ⚠️ nav is let through deliberately. Since the metadata call is signed
     * (2026-09-08), a blanket 412 fails while *fetching the signing keys* — a
     * real thing, but not the classification this test is about. Refusing only
     * the video call keeps the test on its own subject.
     */
    serve([
      [
        /web-interface\/nav/,
        () => ({
          body: {
            code: -101,
            data: {
              wbi_img: {
                img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
                sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
              },
            },
          },
        }),
      ],
      [/./, () => ({ status: 412, body: '' })],
    ])

    await expect(extractBilibiliAudio('BV1xx411c7mD')).rejects.toThrow(BilibiliRefused)
  })

  it('classifies that refusal as worth trying again', async () => {
    /*
     * The judgement, and it is the point of the whole investigation: a 412 is
     * our request looking wrong, and the next attempt carries a fresh cookie.
     * Filing it as the server does — `rate_limited` since #214 — would tell
     * someone to wait for something waiting cannot fix.
     */
    const refused = new BilibiliRefused('refused', 412)

    expect(classifyFailure(refused)).toBe('refused')
    expect(isWorthRetrying(classifyFailure(refused))).toBe(true)
  })

  it('treats a deleted or members-only video as unavailable, and does not retry it', async () => {
    // Bilibili puts its own code in the body of a 200. -404 is deleted.
    serve([[/web-interface\/(wbi\/)?view/, () => ({ body: { code: -404, message: '啥都木有' } })]])

    const failure = await extractBilibiliAudio('BV1xx411c7mD').catch((error: unknown) => error)

    expect(classifyFailure(failure)).toBe('unavailable')
    expect(isWorthRetrying(classifyFailure(failure))).toBe(false)
  })

  it('does not mistake "no audio offered" for a refusal', async () => {
    // The request worked; the answer was a video with no DASH audio. Retrying
    // the same request cannot change that.
    serve([
      [/web-interface\/(wbi\/)?view/, () => ({ body: view() })],
      [/player\/playurl/, () => ({ body: playurl({ dash: { audio: [] } }) })],
    ])

    const failure = await extractBilibiliAudio('BV1xx411c7mD').catch((error: unknown) => error)

    expect(failure).not.toBeInstanceOf(BilibiliRefused)
    expect(classifyFailure(failure)).toBe('no_source')
  })
})

describe('the library identity', () => {
  it('is the canonical page, whatever was pasted', async () => {
    serve(HAPPY)

    // An `av` link, which names the same video by its other id. Bilibili's own
    // search results use this form.
    const audio = await extractBilibiliAudio('https://www.bilibili.com/video/av170001')

    // The bvid comes back from Bilibili rather than from the input, which is
    // what makes an av link and a BV link one row and not two — `source_url` is
    // UNIQUE since schema v6.
    expect(sourceUrlFor(audio)).toBe('https://www.bilibili.com/video/BV1xx411c7mD')
    expect(canonicalUrlFor('BV1xx411c7mD')).toBe(sourceUrlFor(audio))
  })

  it('keeps the name failureKind matches on', () => {
    // Two files that must agree on a string with no compiler between them:
    // `failureKind.ts` cannot import this class without dragging the extractor
    // in behind it, so it matches by name.
    expect(new BilibiliRefused('x', 412).name).toBe('BilibiliRefused')
  })
})
