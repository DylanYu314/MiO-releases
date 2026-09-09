import {
  bestPlayerAudio,
  parsePlayerResponse,
  requestPlayer,
  __resetVisitorId as resetVisitorId,
} from '../src/library/youtubePlayer'

/**
 * The direct player call (#534).
 *
 * ## The fixtures are real
 *
 * Every shape below was taken from a live response on 2026-08-14, including the
 * details that are easy to get wrong from memory and were not:
 *
 * - `contentLength` and `lengthSeconds` arrive as **strings**
 * - `loudnessDb` is a number and is often **positive** (`0.98` for one video,
 *   `5.71` for another) — a parser that treated it as "must be negative LUFS"
 *   would throw away the correction on exactly the loud tracks that need it
 * - `thumbnails` runs **smallest first**, the opposite of `youtubei.js`
 *
 * The network half is covered by measurement rather than by a mock: the same
 * request was run against live YouTube for three videos and downloaded 206 each
 * time, and from the phone itself via `curl`. A mocked `fetch` here would only
 * assert that this file agrees with itself.
 */

const format = (over: Record<string, unknown> = {}) => ({
  itag: 251,
  url: 'https://rr1---sn-x.googlevideo.com/videoplayback?expire=1',
  mimeType: 'audio/webm; codecs="opus"',
  bitrate: 130645,
  contentLength: '7491980',
  loudnessDb: -9.37,
  ...over,
})

const response = (over: Record<string, unknown> = {}) => ({
  playabilityStatus: { status: 'OK' },
  videoDetails: {
    title: 'A song',
    author: 'A channel',
    lengthSeconds: '492',
    thumbnail: {
      thumbnails: [
        { url: 'http://i.ytimg.com/small.jpg' },
        { url: 'http://i.ytimg.com/large.jpg' },
      ],
    },
  },
  streamingData: { adaptiveFormats: [format()] },
  ...over,
})

/**
 * Which identity we claim (#651).
 *
 * ⚠️ **This is the one line that decides whether YouTube works at all**, and it
 * has changed twice under this project. `ANDROID_VR` began serving only the
 * first ~1 MiB of a stream on 2026-08-20 and then answering 403 — the same cap
 * `IOS` and `MWEB` had already hit — so downloads failed partway through with
 * no error anyone would recognise. `VISIONOS` is not capped: 4/4 whole files
 * against 0/4 in the same minute.
 *
 * These values are yt-dlp's `visionos` context verbatim. Asserted rather than
 * trusted, because a typo here is not a compile error and not a test failure
 * anywhere else — it is a 403 halfway through every download.
 */
describe('the client we claim to be', () => {
  const captured: { url?: string; init?: { body?: string; headers?: Record<string, string> } } = {}

  beforeEach(() => {
    resetVisitorId()
    captured.url = undefined
    captured.init = undefined
    globalThis.fetch = jest.fn(async (url: string, init: Record<string, unknown>) => {
      // The visitor-id fetch comes first and is a plain GET of the watch page.
      if (!String(url).includes('/youtubei/')) {
        return { ok: true, text: async () => '{"visitorData":"CgtBQkNE"}' }
      }
      captured.url = String(url)
      captured.init = init as never
      return { ok: true, json: async () => ({ playabilityStatus: { status: 'OK' } }) }
    }) as unknown as typeof fetch
  })

  it('asks as VISIONOS, not as a capped client', async () => {
    await requestPlayer('abcdefghijk')

    const body = JSON.parse(captured.init!.body as string)
    expect(body.context.client.clientName).toBe('VISIONOS')
    expect(body.context.client.clientVersion).toBe('1.02')
    // The numeric id has to agree with the name, or YouTube answers for a
    // different client than the context describes.
    expect(captured.init!.headers!['X-YouTube-Client-Name']).toBe('101')
    expect(captured.init!.headers!['X-YouTube-Client-Version']).toBe('1.02')
  })

  it('sends visionOS device fields, not the Oculus ones it used to', async () => {
    await requestPlayer('abcdefghijk')

    const client = JSON.parse(captured.init!.body as string).context.client
    expect(client.deviceMake).toBe('Apple')
    expect(client.deviceModel).toBe('RealityDevice17,1')
    expect(client.osName).toBe('visionOS')
    // Left over from ANDROID_VR and meaningless here: a client claiming visionOS
    // while reporting an Android SDK level is describing a device that does not
    // exist.
    expect(client.androidSdkVersion).toBeUndefined()
  })

  it('still sends a visitor id and no cookies', async () => {
    // Measured in #534 and unchanged: a visitor id alone answers OK, the same
    // request carrying a watch page's cookie jar answers LOGIN_REQUIRED.
    await requestPlayer('abcdefghijk')

    expect(captured.init!.headers!['X-Goog-Visitor-Id']).toBe('CgtBQkNE')
    expect(captured.init!.headers!.Cookie).toBeUndefined()
  })
})

describe('parsePlayerResponse', () => {
  it('reads the fields the library used to supply', () => {
    const result = parsePlayerResponse(response())

    expect(result).toMatchObject({
      playability: 'OK',
      title: 'A song',
      author: 'A channel',
      durationSeconds: 492,
    })
    expect(result.audio).toMatchObject({ itag: 251, contentLength: 7491980, loudnessLkfs: -9.37 })
  })

  it('takes the widest thumbnail, which is last here', () => {
    // ⚠️ The opposite of youtubei.js's ordering, and the reason this is asserted
    // rather than assumed: picking [0] silently ships the smallest cover.
    expect(parsePlayerResponse(response()).thumbnailUrl).toBe('https://i.ytimg.com/large.jpg')
  })

  it('puts every URL over TLS, because Android refuses cleartext (#456)', () => {
    const result = parsePlayerResponse(
      response({
        streamingData: { adaptiveFormats: [format({ url: 'http://rr1.googlevideo.com/x' })] },
      }),
    )

    expect(result.audio?.url).toBe('https://rr1.googlevideo.com/x')
  })

  it('reports an unplayable video rather than blaming the formats (#400)', () => {
    const result = parsePlayerResponse(
      response({
        playabilityStatus: { status: 'UNPLAYABLE', reason: 'Video unavailable' },
        streamingData: {},
      }),
    )

    expect(result).toMatchObject({ playability: 'UNPLAYABLE', reason: 'Video unavailable' })
    expect(result.audio).toBeNull()
  })

  it('survives a response with nothing in it', () => {
    expect(parsePlayerResponse({})).toMatchObject({ playability: 'UNKNOWN', audio: null })
    expect(parsePlayerResponse(null)).toMatchObject({ audio: null })
  })
})

describe('bestPlayerAudio', () => {
  it('ignores video formats', () => {
    const chosen = bestPlayerAudio([
      format({ mimeType: 'video/mp4; codecs="avc1"', bitrate: 9_000_000, itag: 137 }),
      format({ itag: 251 }),
    ])

    expect(chosen?.itag).toBe(251)
  })

  it('prefers opus over a higher-bitrate mp4', () => {
    // Deliberately gives mp4 the higher bitrate: a plain "highest wins" sort
    // would pick it, and opus is better at the rates YouTube serves.
    const chosen = bestPlayerAudio([
      format({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 200_000 }),
      format({ itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 130_000 }),
    ])

    expect(chosen?.itag).toBe(251)
  })

  it('takes the highest bitrate within opus', () => {
    const chosen = bestPlayerAudio([
      format({ itag: 249, bitrate: 50_000 }),
      format({ itag: 251, bitrate: 130_000 }),
      format({ itag: 250, bitrate: 70_000 }),
    ])

    expect(chosen?.itag).toBe(251)
  })

  it('falls back to mp4 when opus is not offered', () => {
    const chosen = bestPlayerAudio([
      format({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"' }),
    ])

    expect(chosen?.itag).toBe(140)
  })

  /*
   * A format with no `url` is a SABR-only stream. It cannot be fetched, and
   * treating it as usable is what produces a "download refused" instead of an
   * honest "no audio format".
   */
  it('skips formats with no URL at all', () => {
    expect(bestPlayerAudio([format({ url: undefined })])).toBeNull()
    expect(bestPlayerAudio([])).toBeNull()
  })

  it('keeps a positive loudness, which real responses carry', () => {
    expect(bestPlayerAudio([format({ loudnessDb: 5.71 })])?.loudnessLkfs).toBe(5.71)
  })

  it('reports a missing length rather than guessing one', () => {
    expect(bestPlayerAudio([format({ contentLength: undefined })])?.contentLength).toBeNull()
    expect(bestPlayerAudio([format({ loudnessDb: undefined })])?.loudnessLkfs).toBeNull()
  })
})
