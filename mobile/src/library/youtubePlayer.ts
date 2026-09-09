/**
 * YouTube's player endpoint, called directly (#534).
 *
 * ## Why this exists rather than `youtubei.js`
 *
 * On 2026-08-14 every YouTube add-link started failing on the phone with
 *
 *     Refused by ANDROID_VR, IOS, TV_SIMPLY, MWEB.
 *     Last download error: Download refused with status 403 at byte 0
 *
 * so extraction produced URLs and every one of them was refused by the CDN.
 * Measured rather than reasoned about, in this order:
 *
 * | measurement | result |
 * |---|---|
 * | the app, two builds, two phones | ❌ 403 — so not a regression of ours |
 * | `youtubei.js` `getBasicInfo` + ANDROID_VR, in Node on the laptop | ✅ 8/8, download 206 |
 * | the phone downloading a **laptop-extracted** URL | ✅ 206 — the phone's egress is fine |
 * | the raw player POST **from the phone**, via `curl` | ✅ 4 audio formats with URLs |
 * | that URL downloaded **from the phone** | ✅ 206 |
 *
 * The phone can reach YouTube, get URLs and download bytes. What could not do
 * it was `youtubei.js` **as it runs on React Native** — its RN platform shim is
 * not the Node one (it ships no `sha1Hash`, among other differences), and the
 * library's session handling is where the two diverge.
 *
 * So this asks YouTube the same question the measurement asked, with `fetch`
 * and nothing else. It is about eighty lines because the ANDROID_VR client
 * needs no signature deciphering and no player script — which is also why
 * `yt-dlp` marks it `REQUIRE_JS_PLAYER: False`, and why this path does not need
 * the `new Function` evaluator that `extract.ts` warns may not survive a
 * release build.
 *
 * ## What is deliberately not sent
 *
 * ⚠️ **No cookies.** Measured, and counter-intuitive: a visitor id *alone*
 * answers `OK` with four usable URLs, while the same request carrying the
 * cookie jar from a watch page answers `LOGIN_REQUIRED`. Sending more made it
 * worse, so nothing here collects or forwards cookies.
 */

import { overHttps } from './extract'

/**
 * The client `yt-dlp` uses for audio, at the version it currently declares.
 *
 * ## ⚠️ It was `ANDROID_VR` until 2026-08-20, and that stopped working (#651)
 *
 * googlevideo began serving only the **first ~1 MiB** of an `ANDROID_VR` stream
 * URL and then answering 403. Not a rate limit, not the address, not the video:
 * a *fresh* URL asked for a deep range first — nothing spent — is refused too,
 * so re-minting cannot help. `IOS` is capped the same way, and the remaining
 * clients hand back no direct URL at all.
 *
 * `VISIONOS` is not. Measured the same minute, same videos, whole-file
 * downloads:
 *
 * | video | ANDROID_VR | VISIONOS |
 * |---|---|---|
 * | `iy4ueq0opIw` | 512K/3886K, 403 | **3886K/3886K ✅** |
 * | `7E7jJNoCQIY` | 1024K/4519K, 403 | **4519K/4519K ✅** |
 * | `dQw4w9WgXcQ` | 512K/3353K, 403 | **3353K/3353K ✅** |
 * | `zFOzPvpY4ro` | 512K/2652K, 403 | **2652K/2652K ✅** |
 *
 * 4/4 against 0/4, on the same format (itag 251).
 *
 * ⚠️ **Read off `yt-dlp`, not invented.** yt-dlp 2026.07.04 still uses
 * `android_vr` and fails on these videos with the same 403; 2026.08.19 uses
 * `visionos` and downloads them completely. These field values are its
 * `INNERTUBE_CONTEXT` verbatim, including the numeric client name **101** and
 * the Safari user agent — which is not a mistake: visionOS reports itself that
 * way. That is the lesson this repo already paid for with Bilibili's `buvid3`
 * (#492): when a dependency does the thing you cannot, read it.
 *
 * `REQUIRE_JS_PLAYER: False` in yt-dlp for this client too, so it still needs
 * no signature deciphering and no player script — the property this whole file
 * exists for.
 *
 * ⚠️ **Expect to change this again.** The exemption these clients enjoy is
 * being closed one at a time, and the failure it produces is a 403 partway
 * through a download rather than an error anyone would recognise. #647's
 * `download.refused` line is what makes the next one legible.
 */
const CLIENT = {
  name: 'VISIONOS',
  version: '1.02',
  /** InnerTube's numeric id for it, sent as `X-YouTube-Client-Name`. */
  id: '101',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
} as const

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'
const REQUEST_TIMEOUT_MS = 20_000

/** One audio format, reduced to what the caller needs. */
export interface PlayerAudio {
  url: string
  itag: number
  bitrate: number
  contentLength: number | null
  /** LUFS/LKFS, which YouTube ships for free and the server had to measure. */
  loudnessLkfs: number | null
}

export interface PlayerResult {
  playability: string
  reason: string
  title: string | null
  author: string | null
  durationSeconds: number | null
  thumbnailUrl: string | null
  audio: PlayerAudio | null
}

/**
 * The visitor identity, cached for the process.
 *
 * ⚠️ **Not always required, and required often enough to be worth having.** A
 * request without one was measured answering both `OK` and `LOGIN_REQUIRED` at
 * different moments; with one it answered `OK` every time. It costs a single
 * GET per process, so it is not worth being clever about.
 *
 * `null` means "asked and could not find one" — the request then goes without,
 * because a missing visitor id is not a reason to fail before trying.
 */
let visitorId: Promise<string | null> | null = null

async function bounded(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export function fetchVisitorId(): Promise<string | null> {
  visitorId ??= (async () => {
    try {
      const response = await bounded('https://www.youtube.com/?bpctr=9999999999&has_verified=1', {
        headers: {
          // A browser UA, because this is the browser's own page. The client UA
          // belongs on the InnerTube call and nowhere else.
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15',
        },
      })
      const html = await response.text()
      const found = /"visitorData":"(.*?)"/.exec(html)?.[1]
      return found ? decodeURIComponent(found) : null
    } catch {
      return null
    }
  })()
  return visitorId
}

/** Pick the audio stream to fetch: highest bitrate, opus preferred. */
export function bestPlayerAudio(formats: readonly RawFormat[]): PlayerAudio | null {
  const mimeOf = (f: RawFormat) => (typeof f.mimeType === 'string' ? f.mimeType : '')
  const bitrateOf = (f: RawFormat) => (typeof f.bitrate === 'number' ? f.bitrate : 0)

  const usable = formats.filter((f) => typeof f.url === 'string' && mimeOf(f).startsWith('audio/'))
  if (usable.length === 0) return null

  // Opus for the same reason the rest of this app prefers it: better at the
  // bitrates YouTube serves. Falling back rather than requiring it, because a
  // format that exists beats a codec preference.
  const opus = usable.filter((f) => mimeOf(f).includes('opus'))
  const best = (opus.length > 0 ? opus : usable).sort((a, b) => bitrateOf(b) - bitrateOf(a))[0]

  return {
    url: overHttps(best.url as string),
    itag: typeof best.itag === 'number' ? best.itag : 0,
    bitrate: typeof best.bitrate === 'number' ? best.bitrate : 0,
    // A string in the JSON, a number everywhere it is used.
    contentLength: numberFrom(best.contentLength),
    loudnessLkfs: typeof best.loudnessDb === 'number' ? best.loudnessDb : null,
  }
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

export interface RawFormat {
  url?: unknown
  itag?: unknown
  bitrate?: unknown
  mimeType?: unknown
  contentLength?: unknown
  loudnessDb?: unknown
}

/** Parse a player response. Exported so a test does not need the network. */
export function parsePlayerResponse(body: unknown): PlayerResult {
  const json = (body ?? {}) as {
    playabilityStatus?: { status?: unknown; reason?: unknown }
    videoDetails?: {
      title?: unknown
      author?: unknown
      lengthSeconds?: unknown
      thumbnail?: { thumbnails?: { url?: unknown }[] }
    }
    streamingData?: { adaptiveFormats?: RawFormat[] }
  }

  const details = json.videoDetails ?? {}
  const thumbnails = details.thumbnail?.thumbnails ?? []
  // Widest last in this payload, which is the opposite of youtubei.js's order.
  const widest = thumbnails[thumbnails.length - 1]?.url

  return {
    playability:
      typeof json.playabilityStatus?.status === 'string'
        ? json.playabilityStatus.status
        : 'UNKNOWN',
    reason: typeof json.playabilityStatus?.reason === 'string' ? json.playabilityStatus.reason : '',
    title: typeof details.title === 'string' ? details.title : null,
    author: typeof details.author === 'string' ? details.author : null,
    durationSeconds: numberFrom(details.lengthSeconds),
    thumbnailUrl: typeof widest === 'string' ? overHttps(widest) : null,
    audio: bestPlayerAudio(json.streamingData?.adaptiveFormats ?? []),
  }
}

/** Ask YouTube for a video's streams. Throws only if the request itself fails. */
export async function requestPlayer(videoId: string): Promise<PlayerResult> {
  const visitor = await fetchVisitorId()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': CLIENT.userAgent,
    'X-YouTube-Client-Name': CLIENT.id,
    'X-YouTube-Client-Version': CLIENT.version,
    Origin: 'https://www.youtube.com',
  }
  if (visitor) headers['X-Goog-Visitor-Id'] = visitor

  const response = await bounded(PLAYER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      context: {
        client: {
          clientName: CLIENT.name,
          clientVersion: CLIENT.version,
          // yt-dlp's `visionos` context, verbatim. `androidSdkVersion` is gone
          // because this client is not Android.
          deviceMake: 'Apple',
          deviceModel: 'RealityDevice17,1',
          osName: 'visionOS',
          osVersion: '26.5.23O471',
          hl: 'en',
        },
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  })

  return parsePlayerResponse(await response.json())
}

/** Test seam — the visitor id is cached for the life of the process. */
export function __resetVisitorId(): void {
  visitorId = null
}
