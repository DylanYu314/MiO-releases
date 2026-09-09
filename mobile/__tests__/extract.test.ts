import {
  CLIENT_CHAIN,
  VideoUnavailable,
  __resetYoutubeClient,
  extractAudio,
} from '../src/library/extract'
import { NotAYouTubeLink, videoIdFrom } from '../src/library/youtubeUrl'

/**
 * Choosing a client and a format on the device (#246).
 *
 * ## What these deliberately do not test
 *
 * Whether youtubei.js works under Hermes. **jest runs on Node**, which has
 * `globalThis.crypto`, `eval` and everything else the phone may lack — that is
 * exactly how #188 shipped: a green suite said nothing about the device.
 *
 * So youtubei.js is mocked and what is tested is *our* logic: the order clients
 * are tried in, that a client with no usable format is passed over rather than
 * fatal, which format is chosen, and that a total failure names what was tried.
 * The library's own behaviour on a real phone is the spike's job, and it was
 * answered by running it there.
 */

const mockGetBasicInfo = jest.fn()
const mockCreate = jest.fn()

jest.mock('youtubei.js/react-native', () => ({
  Innertube: { create: (...args: unknown[]) => mockCreate(...args) },
  Platform: { load: jest.fn(), shim: {} },
}))

/** An `adaptive_formats` entry, in the shape youtubei.js returns.
 *
 *  `decipher` defaults to handing back this format's own `url`, so tests about
 *  format *choice* stay about choice. The deciphering tests override it. */
function format(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    mime_type: 'audio/webm; codecs="opus"',
    bitrate: 129000,
    url: 'https://googlevideo.example/audio',
    content_length: 4096,
    track_absolute_loudness_lkfs: -14.3,
    ...overrides,
  }
  return { ...base, decipher: base.decipher ?? (async () => base.url as string) }
}

function info(formats: unknown[], title = 'A Song') {
  return {
    basic_info: { title, author: 'A Channel', duration: 214 },
    playability_status: { status: 'OK', reason: '' },
    streaming_data: { adaptive_formats: formats },
  }
}

/** What youtubei.js returns for a video that will not play (#400). No
 *  `streaming_data` at all, which is why this used to read as "no format". The
 *  shape is `MediaInfo`'s — read from the package's source, not recalled. */
function unplayable(status: string, reason: string) {
  return {
    basic_info: { title: 'A Song', author: 'A Channel', duration: 214 },
    playability_status: { status, reason },
  }
}

/** `Innertube.create` resolves to something carrying the player deciphering
 *  needs — absent it, `decipher` hands back the raw URL. */
function client() {
  return { getBasicInfo: mockGetBasicInfo, session: { player: { id: 'player' } } }
}

beforeEach(() => {
  __resetYoutubeClient()
  mockGetBasicInfo.mockReset()
  mockCreate.mockReset().mockResolvedValue(client())
})

describe('reading a video id out of what the user pasted', () => {
  it.each([
    ['https://www.youtube.com/watch?v=DruvTra8swY', 'DruvTra8swY'],
    ['https://youtu.be/DruvTra8swY', 'DruvTra8swY'],
    ['https://www.youtube.com/shorts/DruvTra8swY', 'DruvTra8swY'],
    ['https://m.youtube.com/watch?v=DruvTra8swY&t=42s', 'DruvTra8swY'],
    ['DruvTra8swY', 'DruvTra8swY'],
  ])('%s', (input, expected) => {
    expect(videoIdFrom(input)).toBe(expected)
  })

  it('refuses something that is not a YouTube link', () => {
    // Better than guessing: a wrong id produces a confusing "no client could
    // provide audio" several seconds later, blamed on YouTube.
    expect(() => videoIdFrom('https://example.com/song.mp3')).toThrow(NotAYouTubeLink)
  })
})

describe('choosing a client (#246)', () => {
  it('takes the first client that gives a usable URL', async () => {
    mockGetBasicInfo.mockResolvedValue(info([format()]))

    const result = await extractAudio('https://www.youtube.com/watch?v=DruvTra8swY')

    expect(result.client).toBe(CLIENT_CHAIN[0])
    // Measured: the only client that serves a whole file (#246).
    expect(result.client).toBe('ANDROID_VR')
    expect(mockGetBasicInfo).toHaveBeenCalledTimes(1)
    expect(mockGetBasicInfo).toHaveBeenCalledWith('DruvTra8swY', { client: 'ANDROID_VR' })
  })

  it('falls through to the next client when formats come back ciphered', async () => {
    // Measured on a real device: ANDROID and WEB return formats with no URL.
    // Without the fallback those videos would simply fail, unpredictably, which
    // is the silent partial coverage this chain exists to avoid.
    mockGetBasicInfo
      .mockResolvedValueOnce(info([format({ url: undefined })]))
      .mockResolvedValueOnce(info([format()]))

    const result = await extractAudio('DruvTra8swY')

    expect(result.client).toBe(CLIENT_CHAIN[1])
    expect(result.audio_url).toBe('https://googlevideo.example/audio')
  })

  it('falls through when a client throws outright', async () => {
    mockGetBasicInfo
      .mockRejectedValueOnce(new Error('login required'))
      .mockResolvedValueOnce(info([format()]))

    await expect(extractAudio('DruvTra8swY')).resolves.toMatchObject({ client: CLIENT_CHAIN[1] })
  })

  /**
   * A video YouTube will not play here (#400), from the device pass.
   *
   * The one track that failed reported `no audio format` from all four clients,
   * three times over, which reads as the app being blocked. It was not:
   * `Kvv5CpePWk0` is an Art Track whose `availableCountries` are **AT, CH and
   * DE**. Measured from a residential connection, so this is not #177's
   * datacenter refusal wearing a different coat — every client was telling the
   * truth, and the app was the only thing lying.
   */
  describe('a video that will not play here', () => {
    it('says what YouTube said, not what four clients did not have', async () => {
      mockGetBasicInfo.mockResolvedValue(unplayable('UNPLAYABLE', 'This video is not available'))

      await expect(extractAudio('Kvv5CpePWk0')).rejects.toThrow(/This video is not available/)
      // And not the four-client list, which is written for whoever is debugging
      // and says nothing anyone can act on.
      await expect(extractAudio('Kvv5CpePWk0')).rejects.not.toThrow(/no audio format/)
    })

    it('is a kind of failure a caller can tell apart', async () => {
      // `instanceof`, not a message match: the import loop uses this to decide
      // whether retrying can possibly help, and a substring is not a decision.
      mockGetBasicInfo.mockResolvedValue(unplayable('LOGIN_REQUIRED', 'Sign in to confirm'))

      await expect(extractAudio('Kvv5CpePWk0')).rejects.toBeInstanceOf(VideoUnavailable)
      await expect(extractAudio('Kvv5CpePWk0')).rejects.toMatchObject({
        status: 'LOGIN_REQUIRED',
      })
    })

    it('still asks every client before concluding it', async () => {
      // One client's answer is not the chain's: they do not all use the same
      // identity, and #246's whole design is that a refusal is per client until
      // it is not.
      mockGetBasicInfo
        .mockResolvedValueOnce(unplayable('UNPLAYABLE', 'nope'))
        .mockResolvedValueOnce(info([format()]))

      await expect(extractAudio('Kvv5CpePWk0')).resolves.toMatchObject({
        client: CLIENT_CHAIN[1],
      })
    })

    it('is not claimed for a video that merely had no usable format', async () => {
      // The distinction is the whole point: `OK` with nothing playable is a
      // different problem, and calling it unavailable would stop the retries
      // that fix it.
      mockGetBasicInfo.mockResolvedValue(info([]))

      await expect(extractAudio('DruvTra8swY')).rejects.not.toBeInstanceOf(VideoUnavailable)
    })
  })

  it('names every client it tried when none works', async () => {
    mockGetBasicInfo.mockResolvedValue(info([]))

    // "It did not work" with no detail is what cost a day on the server side.
    await expect(extractAudio('DruvTra8swY')).rejects.toThrow(/ANDROID_VR.*IOS.*TV_SIMPLY.*MWEB/s)
    expect(mockGetBasicInfo).toHaveBeenCalledTimes(CLIENT_CHAIN.length)
  })
})

describe('choosing a format', () => {
  it('prefers Opus, which is what the library stores', async () => {
    mockGetBasicInfo.mockResolvedValue(
      info([
        format({ mime_type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 999000, url: 'https://m4a' }),
        format({ mime_type: 'audio/webm; codecs="opus"', bitrate: 129000, url: 'https://opus' }),
      ]),
    )

    // Even though the m4a is higher bitrate: no transcode is the point, and the
    // server's pipeline produces Opus too.
    await expect(extractAudio('DruvTra8swY')).resolves.toMatchObject({ audio_url: 'https://opus' })
  })

  it('takes the highest bitrate within Opus', async () => {
    mockGetBasicInfo.mockResolvedValue(
      info([
        format({ bitrate: 46000, url: 'https://low' }),
        format({ bitrate: 129000, url: 'https://high' }),
      ]),
    )

    await expect(extractAudio('DruvTra8swY')).resolves.toMatchObject({ audio_url: 'https://high' })
  })

  it('accepts a non-Opus format rather than failing', async () => {
    mockGetBasicInfo.mockResolvedValue(
      info([format({ mime_type: 'audio/mp4; codecs="mp4a.40.2"', url: 'https://m4a' })]),
    )

    // Android plays AAC too. Refusing it would turn a playable song into a
    // failure for a preference.
    await expect(extractAudio('DruvTra8swY')).resolves.toMatchObject({ audio_url: 'https://m4a' })
  })

  it('takes a usable format even when a better one is ciphered', async () => {
    // The mixed case, and the one that makes the `url` filter load-bearing:
    // choosing by bitrate alone picks the ciphered format, which then fails the
    // guard and discards the *whole client* — skipping audio that was right
    // there. Caught by mutation testing rather than by thinking about it.
    mockGetBasicInfo.mockResolvedValue(
      info([
        format({ bitrate: 160000, url: undefined }),
        format({ bitrate: 129000, url: 'https://usable' }),
      ]),
    )

    const result = await extractAudio('DruvTra8swY')

    expect(result.audio_url).toBe('https://usable')
    expect(result.client).toBe(CLIENT_CHAIN[0])
  })

  it('ignores video formats entirely', async () => {
    mockGetBasicInfo.mockResolvedValue(
      info([
        format({ mime_type: 'video/mp4; codecs="avc1"', bitrate: 5000000, url: 'https://video' }),
        format({ url: 'https://audio' }),
      ]),
    )

    await expect(extractAudio('DruvTra8swY')).resolves.toMatchObject({ audio_url: 'https://audio' })
  })
})

describe("YouTube's own loudness measurement (#246)", () => {
  it('is carried through, so normalization does not need ffmpeg', async () => {
    mockGetBasicInfo.mockResolvedValue(info([format()]))

    // LKFS and LUFS are the same unit under two names, so this drops straight
    // into `loudness_lufs` and playback normalizes exactly as before.
    await expect(extractAudio('DruvTra8swY')).resolves.toMatchObject({ loudness_lufs: -14.3 })
  })

  it('is null when YouTube omits it, rather than a guess', async () => {
    mockGetBasicInfo.mockResolvedValue(info([format({ track_absolute_loudness_lkfs: undefined })]))

    // `normalizationGain` already treats a missing measurement as "no
    // correction"; inventing one would quietly change how a track sounds.
    await expect(extractAudio('DruvTra8swY')).resolves.toMatchObject({ loudness_lufs: null })
  })
})

describe('the client is created once', () => {
  it('does not refetch the player script per song', async () => {
    mockGetBasicInfo.mockResolvedValue(info([format()]))

    await extractAudio('DruvTra8swY')
    await extractAudio('dQw4w9WgXcQ')

    // Creating it parses YouTube's player script, which is far too expensive
    // to repeat for every track of a playlist.
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})

describe('the headers the download must repeat (#246)', () => {
  it('carries the stated content length, which the download cannot do without', async () => {
    mockGetBasicInfo.mockResolvedValue(info([format()]))

    // A stream URL serves one request and refuses the next, so the size has to
    // be known before asking rather than discovered by walking ranges (#246).
    await expect(extractAudio('DruvTra8swY')).resolves.toMatchObject({ content_length: 4096 })
  })

  it('is null when YouTube states no length, rather than a guess', async () => {
    mockGetBasicInfo.mockResolvedValue(info([format({ content_length: undefined })]))

    await expect(extractAudio('DruvTra8swY')).resolves.toMatchObject({ content_length: null })
  })

  it('sends no headers of its own, which is the corrected finding', async () => {
    mockGetBasicInfo.mockResolvedValue(info([format()]))

    const result = await extractAudio('DruvTra8swY')

    // The 403 was first blamed on a missing User-Agent; sending the iOS agent
    // changed nothing. The spike had already fetched an IOS-minted URL with no
    // iOS agent at all — the HTTP client was the variable, not the header.
    expect(result.http_headers).toEqual({})
  })

  it('skips a client whose URL was already refused', async () => {
    mockGetBasicInfo.mockResolvedValue(info([format()]))

    const result = await extractAudio('DruvTra8swY', { exclude: ['ANDROID_VR'] })

    // A URL that 403s is as useless as no URL, so the chain has to cover the
    // download too — this is how the caller retires a client that failed.
    expect(result.client).toBe('IOS')
    expect(mockGetBasicInfo).toHaveBeenCalledWith('DruvTra8swY', { client: 'IOS' })
  })
})

describe('the URL must be deciphered before it can be fetched (#246)', () => {
  it('returns the deciphered URL, not the raw one', async () => {
    mockGetBasicInfo.mockResolvedValue(
      info([format({ decipher: async () => 'https://googlevideo.example/audio?n=transformed' })]),
    )

    const result = await extractAudio('DruvTra8swY')

    // `format.url` is raw. Fetching it gets a small allowance and then 403 —
    // 256 KB worked, 1 MiB worked, the second request did not, and asking for
    // the whole file failed at byte 0. Throttling dressed as a permission error.
    expect(result.audio_url).toBe('https://googlevideo.example/audio?n=transformed')
  })

  it('hands the player to decipher, without which it is a no-op', async () => {
    const decipher = jest.fn().mockResolvedValue('https://deciphered')
    mockGetBasicInfo.mockResolvedValue(info([format({ decipher })]))

    await extractAudio('DruvTra8swY')

    // youtubei.js returns the original URL when given no player, which would
    // fail exactly as before and look like the fix had not worked.
    expect(decipher).toHaveBeenCalledWith({ id: 'player' })
  })

  it('moves to the next client when deciphering yields nothing', async () => {
    mockGetBasicInfo
      .mockResolvedValueOnce(info([format({ decipher: async () => '' })]))
      .mockResolvedValueOnce(info([format()]))

    const result = await extractAudio('DruvTra8swY')

    expect(result.client).toBe(CLIENT_CHAIN[1])
  })
})

describe('a ciphered format is usable, not a dead end (#246)', () => {
  it('takes a format that has only a signature cipher', async () => {
    // Filtering on `url` threw these away — so the clients that offer them
    // reported "no usable format" and were skipped before the evaluator ever
    // ran. Deciphering is exactly what turns them into a URL.
    mockGetBasicInfo.mockResolvedValue(
      info([
        format({
          url: undefined,
          signature_cipher: 's=abc&url=https%3A%2F%2Fgooglevideo',
          decipher: async () => 'https://deciphered-from-cipher',
        }),
      ]),
    )

    const result = await extractAudio('DruvTra8swY')

    expect(result.audio_url).toBe('https://deciphered-from-cipher')
  })

  it('still reports a client with no audio at all', async () => {
    mockGetBasicInfo.mockResolvedValueOnce(info([])).mockResolvedValue(info([format()]))

    const result = await extractAudio('DruvTra8swY')

    expect(result.client).toBe(CLIENT_CHAIN[1])
  })
})

/**
 * A URL Android will actually send (#456).
 *
 * The 2026-08-09 pass lost a track that had worked before:
 *
 *     fetch failed: java.net.UnknownServiceException: CLEARTEXT communication
 *     to rr1---sn-5hnekn7s.googlevideo.com not permitted by network security
 *     policy
 *
 * googlevideo had handed back an `http://` URL, and Android has blocked
 * cleartext by default since API 28 — so the request never left the phone. The
 * other three clients then failed the same way, because the scheme is not
 * something a different client fixes.
 *
 * It is **intermittent**: googlevideo returns a mix. So a success on a device
 * proves nothing, and this is the test that can.
 */
describe('a stream URL Android is allowed to fetch (#456)', () => {
  it('upgrades a cleartext stream URL to https', async () => {
    mockGetBasicInfo.mockResolvedValue(
      info([format({ url: 'http://rr1---sn-5hnekn7s.googlevideo.com/videoplayback?id=1' })]),
    )

    const result = await extractAudio('DruvTra8swY')

    // The host and query are untouched — this is the same URL over TLS, not a
    // different one. Rewriting more than the scheme would be a new bug.
    expect(result.audio_url).toBe('https://rr1---sn-5hnekn7s.googlevideo.com/videoplayback?id=1')
  })

  it('upgrades a deciphered URL too, since that is a different code path', async () => {
    mockGetBasicInfo.mockResolvedValue(
      info([
        format({
          url: undefined,
          signature_cipher: 's=abc',
          decipher: async () => 'http://googlevideo.example/deciphered',
        }),
      ]),
    )

    const result = await extractAudio('DruvTra8swY')

    expect(result.audio_url).toBe('https://googlevideo.example/deciphered')
  })

  it('upgrades the cover URL as well', async () => {
    const withThumbnail = info([format()])
    ;(withThumbnail.basic_info as Record<string, unknown>).thumbnail = [
      { url: 'http://i.ytimg.com/vi/x/maxres.jpg' },
    ]
    mockGetBasicInfo.mockResolvedValue(withThumbnail)

    const result = await extractAudio('DruvTra8swY')

    // Never seen failing only because `saveCover` swallows its own errors — so
    // the same URL would have cost artwork silently rather than loudly.
    expect(result.cover_url).toBe('https://i.ytimg.com/vi/x/maxres.jpg')
  })

  it('leaves an https URL exactly as it is, query string included', async () => {
    const url = 'https://googlevideo.example/videoplayback?u=http://cdn.example/a&sig=1'
    mockGetBasicInfo.mockResolvedValue(info([format({ url })]))

    const result = await extractAudio('DruvTra8swY')

    // A googlevideo URL routinely carries another URL as a parameter. Only the
    // **scheme at the start** may be touched: an unanchored rewrite would edit
    // the parameter instead, and the URL would then 403 rather than fail in a
    // way anybody could read.
    expect(result.audio_url).toBe(url)
  })
})
