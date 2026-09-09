import { Innertube, Platform } from 'youtubei.js/react-native'

import { requestPlayer } from './youtubePlayer'

import { videoIdFrom } from './youtubeUrl'

/**
 * Getting a playable audio URL, on the device (#246).
 *
 * The server cannot do this any more: YouTube refuses its address on every
 * client. Measured 2026-07-31 against the hosted backend — 1 import in 14, and
 * unchanged by a JS runtime or by a proof-of-origin token. A signed-in cookie
 * file bought seven imports before the session was revoked.
 *
 * A phone is refused by none of it, because the request comes from a
 * residential address rather than a datacenter one. Confirmed on real hardware:
 * every video the server could not touch returned its metadata and a working
 * stream URL from the device.
 *
 * ## "Client" is not the device we are running on
 *
 * It is the identity we *claim* to YouTube's internal API. YouTube serves its
 * website, its iPhone app, its Android app and its TV app from one API and
 * answers each differently, so this is a string in a request body — an Android
 * phone asking for the response an iPhone would get is normal and is what every
 * tool in this space does.
 */

/**
 * Which identities to try, in the order **measured against real YouTube**.
 *
 * | client | whole-file download |
 * |---|---|
 * | `ANDROID_VR` | ⚠️ **was** ✅; since 2026-08-20 ❌ 403 after the first ~1 MiB |
 * | `TV_SIMPLY` | ❌ 403 |
 * | `IOS` | ❌ 403 after the first 1 MiB |
 * | `MWEB` | ❌ 403 after the first 1 MiB |
 * | `VISIONOS` (the direct path, #651) | ✅ 4/4 whole files |
 *
 * ⚠️ **`ANDROID_VR` joined the 1 MiB club on 2026-08-20** (#651), which is the
 * exact failure mode this table already describes for `IOS` and `MWEB` — and
 * the reason it took a day to see is written two paragraphs down: *"a 403
 * meaning 'that is all you get' is indistinguishable from one meaning 'you are
 * not allowed' unless you look at the byte offset."* It happened again, to the
 * same file, for the same reason.
 *
 * Every client in the chain below is now capped or gives no URL at all. What
 * carries YouTube is the **direct** path, `VISIONOS`, in `youtubePlayer.ts`.
 *
 * ## Why IOS was wrong, and what it cost
 *
 * The spike ranked clients by *whether an audio URL came back at all*, and IOS
 * won because it hands over a ready URL. But a URL is not a download, and IOS
 * URLs serve **only the first 1 MiB** — measured exactly: 256 KB, 512 KB and
 * 1 MiB requests all return 206; 2 MiB returns 403; four sequential 256 KB
 * chunks succeed and the fifth fails; and a *fresh* URL for a later offset is
 * refused too, so it is a property of the file's first megabyte, not of the URL.
 *
 * That produced four wrong diagnoses in a row, because a 403 meaning "that is
 * all you get" is indistinguishable from one meaning "you are not allowed"
 * unless you look at the byte offset. Deciphering, `User-Agent`s, `fetch`
 * versus expo-file-system and one-request-per-URL were all fitted to part of
 * the evidence.
 *
 * `ANDROID_VR` was what yt-dlp itself selected, and it served whole files with
 * no proof-of-origin token — verified by downloading the complete file both
 * ways. ⚠️ **yt-dlp moved to `visionos` on 2026-08-19 and this project followed
 * a day later** (#651): its 2026-07-04 build still picks `android_vr` and fails
 * on the same videos with the same 403, while 2026-08-19 downloads them whole.
 *
 * **This is a moving target**, which is why it stays a chain: YouTube has
 * already closed the plain Android client and pushed web to SABR. ⚠️ **And
 * ANDROID_VR has now closed**, which the chain did *not* absorb — because the
 * options it degrades to had closed earlier. A chain only helps while one link
 * still works, so the real defence is #647's `download.refused` line, which
 * names the offset a refusal happened at and turns the next one into a
 * measurement instead of a week of guessing.
 */
/**
 * The name the direct player call reports itself as (#534).
 *
 * Distinct from `ANDROID_VR` in `CLIENT_CHAIN` even though it sends that
 * client, because the two are different *code paths* and the caller excludes a
 * client whose URL was refused. Sharing a name would mean one 403 disabled
 * both, and the whole point is that one of them works when the other does not.
 */
export const DIRECT_CLIENT = 'VISIONOS_DIRECT'

export const CLIENT_CHAIN = ['ANDROID_VR', 'IOS', 'TV_SIMPLY', 'MWEB'] as const

export class ExtractionFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtractionFailed'
  }
}

/**
 * YouTube answered, and the answer is that this video cannot be played (#400).
 *
 * A subclass rather than a flag, so every existing `catch (ExtractionFailed)`
 * still catches it and only the callers that care have to know the difference.
 *
 * The difference matters twice. **Retrying is pointless** — three attempts and
 * six seconds of backoff cannot change a region lock — and **the message is the
 * only thing the user can act on**, so it carries YouTube's own words rather
 * than the names of four clients that all said no.
 *
 * From the device pass: `Kvv5CpePWk0` returned "no audio format" from every
 * client in the chain, which read as the app being blocked. It is not. The video
 * is an Art Track on a `- Topic` channel and its `availableCountries` are
 * **AT, CH, DE** — three countries, none of them ours. Every client was telling
 * the truth: for us there is no stream. Measured from a residential connection,
 * so this is not #177's datacenter refusal wearing a different coat.
 */
export class VideoUnavailable extends ExtractionFailed {
  constructor(
    message: string,
    /** YouTube's `playabilityStatus.status` — `UNPLAYABLE`, `LOGIN_REQUIRED`,
     *  `AGE_VERIFICATION_REQUIRED`, and so on. */
    readonly status: string,
  ) {
    super(message)
    this.name = 'VideoUnavailable'
  }
}

/**
 * The same URL over TLS (#456).
 *
 * The 2026-08-09 pass lost a track that had worked on an earlier run:
 *
 *     fetch failed: java.net.UnknownServiceException: CLEARTEXT communication
 *     to rr1---sn-5hnekn7s.googlevideo.com not permitted by network security
 *     policy
 *
 * The extractor had handed back an **`http://`** URL. Android has blocked
 * cleartext by default since API 28, so the request never left the phone — 0.5 s
 * and no HTTP status at all — and the client chain then spent its other three
 * attempts on the same answer, because every client returns the same *kind* of
 * URL. googlevideo hands back a mix, which is why the video worked before.
 *
 * ## Why this and not `usesCleartextTraffic`
 *
 * Allowing cleartext in the manifest would fix it by making **every** request
 * the app makes downgradeable, which is a large, permanent hole opened for an
 * occasional URL. Rewriting one scheme costs nothing and leaves the default
 * where it is: googlevideo serves the same bytes over TLS at the same address.
 *
 * Applied to the cover URL too. It is the same host family and the same
 * intermittency; the only reason it has not been seen failing is that
 * `saveCover` swallows its own errors, so it would have been silent.
 */
export function overHttps(url: string): string
export function overHttps(url: string | null): string | null
export function overHttps(url: string | null): string | null {
  return url === null ? null : url.replace(/^http:\/\//i, 'https://')
}

/** What the device needs to store a song, gathered from YouTube directly. */
export interface ExtractedAudio {
  video_id: string
  title: string
  artist: string
  duration: number | null
  /** A URL the device can GET. Already deciphered, if it needed to be. */
  audio_url: string
  /**
   * YouTube's thumbnail for the video, when it offers one (#218).
   *
   * The device's only source of cover art. A song imported here has no server
   * row, so `GET /songs/{id}/cover` does not exist for it — without this, every
   * song added the way #246 made the default would have no artwork at all.
   */
  cover_url: string | null
  /**
   * The exact size in bytes, when YouTube states it.
   *
   * Load-bearing rather than informational (#246): the stream URL serves **one
   * request** and refuses the next, so the download cannot discover the length
   * by walking ranges — it has to know it in advance and ask once.
   */
  content_length: number | null
  /**
   * Integrated loudness, LUFS — the same measurement the server took with
   * ffmpeg's `ebur128` (G4), except YouTube ships it for free.
   *
   * LKFS and LUFS are the same unit under two names, so this drops straight
   * into `loudness_lufs` and playback normalizes as it always has. It is the
   * reason device-side imports do **not** lose loudness correction, which
   * looked like an unavoidable cost of moving downloads off the server.
   *
   * `null` when YouTube omits it; `normalizationGain` already treats a missing
   * measurement as "no correction" rather than guessing.
   */
  loudness_lufs: number | null
  /** What we asked YouTube to be, so a failure report can name it. */
  client: string
  /**
   * Which part of a multi-part upload this is, 1-based (#575). Bilibili only.
   *
   * Bilibili calls these 多P and a link names one with `?p=N`. It lives here
   * rather than being re-derived from the pasted URL because the *extractor* is
   * what decided it: a `?p=` naming a part that does not exist falls back to
   * the first one, and the identity has to reflect what was actually fetched
   * rather than what was asked for.
   *
   * `undefined` for YouTube, for a single-part upload and for part one — which
   * is what keeps an ordinary link's `source_url` exactly as it has always
   * been, so nothing already in a library re-imports as a duplicate of itself.
   */
  part?: number
  /**
   * Headers to repeat on the download, if any.
   *
   * **Empty, and the emptiness is the finding.** The 403 was first blamed on a
   * missing `User-Agent` — googlevideo does tie a stream URL to the client that
   * minted it — and sending the iOS agent changed nothing.
   *
   * The evidence was already in hand and pointed elsewhere: the spike fetched
   * an IOS-minted URL **with no iOS agent at all**, at 274 KB/s, because it
   * used `fetch` rather than expo-file-system. The HTTP client was the
   * variable, not the header.
   *
   * Kept as a seam rather than deleted: if a header does turn out to matter
   * this is where it goes, and the comment stops the same theory being tried a
   * third time.
   */
  http_headers: Record<string, string>
}

/**
 * How long any single request to YouTube may take.
 *
 * Twenty seconds is generous for what these are — a metadata call and a player
 * script, both small. The point is not speed; it is that **nothing on this path
 * had a timeout at all**. A frozen app leaves dead sockets behind, and a promise
 * that never settles took the whole import down with it: no failure, no retry,
 * no result, and an in-progress guard that never cleared.
 *
 * `apiFetch` has had exactly this since it was written. The device paths that
 * replaced the server (#246, #353) inherited none of it.
 */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * `fetch`, with a deadline.
 *
 * Handed to `Innertube.create` so it covers every request the library makes,
 * including the ones this file never calls directly. The signal is what makes
 * it a cancellation rather than a race: an abandoned request keeps its socket
 * and its memory, and on a phone doing a forty-track import that adds up.
 */
const boundedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

/**
 * The JavaScript evaluator youtubei.js declines to supply on React Native.
 *
 * Its own default throws — *"you must provide your own JavaScript evaluator"* —
 * and the documented answer is a WebView, which would mean a native module and
 * a cloud rebuild for every iteration.
 *
 * It is avoidable because the spike found `new Function` **works under Hermes**.
 * The contract (`youtubei.js/core/Player.js`) is: run the script with `env` in
 * scope and hand back an object holding the names in `exported` — which is how
 * the deciphered signature and `n` parameter come out.
 *
 * ⚠️ Hermes disables `eval` in some configurations, and a dev build is not a
 * release build. This has only been exercised in a dev build; the chain above
 * is what keeps that from being fatal, because the deciphering path is the
 * fallback rather than the norm.
 */
function evaluateScript(
  data: { output: string; exported: string[] },
  env: Record<string, unknown>,
): unknown {
  const names = Object.keys(env)
  const body = `${data.output}\nreturn {${data.exported.join(',')}};`
  return new Function(...names, body)(...names.map((key) => env[key]))
}

let client: Promise<Innertube> | null = null

/**
 * One Innertube client, created once.
 *
 * Cached as the promise so two imports starting together share a single
 * creation — it fetches and parses YouTube's player script, which is far too
 * expensive to repeat per song.
 */
export function youtubeClient(): Promise<Innertube> {
  client ??= (async () => {
    Platform.load({
      ...Platform.shim,
      eval: evaluateScript,
    } as Parameters<typeof Platform.load>[0])

    // `retrieve_player: true` is what makes deciphering possible at all. The
    // first spike passed `false` and every video reported zero formats — the
    // measurement was of its own configuration, not of YouTube.
    //
    // `fetch` is ours so that **every** request youtubei.js makes is bounded —
    // see `boundedFetch`. Supplying it here rather than racing `getBasicInfo`
    // against a timer means the request is actually cancelled rather than
    // abandoned while it carries on holding a socket.
    return Innertube.create({ retrieve_player: true, fetch: boundedFetch })
  })()
  return client
}

interface AudioFormat {
  mime_type?: string
  bitrate?: number
  url?: string
  content_length?: number
  /** Present instead of `url` when the URL has to be deciphered. */
  signature_cipher?: string
  cipher?: string
  /** YouTube's own loudness figure, in LKFS — the same unit as LUFS. */
  track_absolute_loudness_lkfs?: number
  loudness_db?: number
  /**
   * Applies the `n` transform (and any signature cipher) to `url`.
   *
   * **`format.url` is the raw URL and is not what should be fetched.** Without
   * the transform googlevideo serves a small allowance and then refuses — which
   * is the entire history of this bug: a 256 KB fetch worked, a 1 MiB fetch
   * worked, the second request 403'd, and asking for the whole file 403'd at
   * byte 0. Throttling, wearing the costume of a permissions error.
   */
  decipher?: (player?: never) => Promise<string>
}

/** Prefer Opus, then the highest bitrate — the device stores what YouTube sends.
 *
 *  A format with no `url` is **not** unusable: it carries a signature cipher
 *  instead, and `decipher` produces the URL. Filtering on `url` threw away
 *  exactly the formats that need deciphering — so the clients offering them
 *  reported "no usable format" and were skipped before the evaluator ever ran. */
function bestAudio(formats: AudioFormat[]) {
  const usable = formats.filter(
    (f) => f.mime_type?.startsWith('audio/') && (f.url || f.signature_cipher || f.cipher),
  )
  const opus = usable.filter((f) => f.mime_type?.includes('opus'))
  const pool = opus.length > 0 ? opus : usable
  return pool.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]
}

/**
 * Ask YouTube for a playable audio URL, trying each identity in turn.
 *
 * Returns the first client that yields one. Throws `ExtractionFailed` naming
 * every client tried when none does — a failure that says only "it did not
 * work" is the thing that cost a day of measuring on the server side.
 */
export async function extractAudio(
  input: string,
  options: { exclude?: readonly string[] } = {},
): Promise<ExtractedAudio> {
  const videoId = videoIdFrom(input)
  const attempts: string[] = []
  let unplayableFromDirect: { status: string; reason: string } | null = null

  /*
   * The direct player call first (#534).
   *
   * `youtubei.js` on React Native stopped producing usable URLs on
   * 2026-08-14 — every client's URL answered 403 at byte 0, on two builds and
   * two phones, while the same request made with plain `fetch` **from the same
   * phone** returned four working formats and downloaded 206. So the library is
   * asked second now, not first.
   *
   * It stays as the fallback rather than being deleted: it covers clients this
   * does not, it is the only path that deciphers a signature, and one bad day
   * is not enough evidence to throw away the thing that worked for months.
   */
  if (!options.exclude?.includes(DIRECT_CLIENT)) {
    try {
      const direct = await requestPlayer(videoId)
      if (direct.playability !== 'OK') {
        unplayableFromDirect = { status: direct.playability, reason: direct.reason }
        attempts.push(`${DIRECT_CLIENT}: ${direct.playability}`)
      } else if (!direct.audio) {
        attempts.push(`${DIRECT_CLIENT}: no audio format`)
      } else {
        return {
          video_id: videoId,
          title: direct.title ?? videoId,
          artist: direct.author ?? 'Unknown',
          duration: direct.durationSeconds,
          audio_url: direct.audio.url,
          cover_url: direct.thumbnailUrl,
          loudness_lufs: direct.audio.loudnessLkfs,
          content_length: direct.audio.contentLength,
          client: DIRECT_CLIENT,
          http_headers: {},
        }
      }
    } catch (error) {
      attempts.push(`${DIRECT_CLIENT}: ${String(error).slice(0, 80)}`)
    }
  }

  const yt = await youtubeClient()
  /** What YouTube said the last time it refused to play this at all (#400).
   *  Every client asks the same servers, so one refusal is usually all of
   *  them — but it is only conclusive once the chain is exhausted. */
  let unplayable: { status: string; reason: string } | null = unplayableFromDirect

  for (const name of CLIENT_CHAIN) {
    // Excluded because this client's URL was fetched and refused. A URL that
    // 403s is as useless as no URL, so the chain has to cover the *download*
    // and not only the extraction.
    if (options.exclude?.includes(name)) continue
    try {
      const info = await yt.getBasicInfo(videoId, { client: name })

      /*
       * "No audio format" is what an unplayable video looks like from here, and
       * it is a different thing to report (#400).
       *
       * `playability_status` is `{ status, reason }` — read out of
       * `youtubei.js`'s `MediaInfo`, not recalled. When it is not `OK` there is
       * no `streaming_data` at all, so the format check below would blame the
       * formats for a decision made three steps earlier.
       */
      const playability = info.playability_status
      if (playability && playability.status !== 'OK') {
        unplayable = { status: playability.status, reason: playability.reason ?? '' }
        attempts.push(`${name}: ${playability.status}`)
        continue
      }

      const format = bestAudio(info.streaming_data?.adaptive_formats ?? [])

      if (!format) {
        attempts.push(`${name}: no audio format`)
        continue
      }

      // The URL that is actually fetchable. This is also the first thing to
      // exercise the injected evaluator: deciphering runs YouTube's player
      // script, so a Hermes that refuses `new Function` fails here rather than
      // silently serving a throttled URL.
      const player = (yt as unknown as { session?: { player?: never } }).session?.player
      const playableUrl = format.decipher ? await format.decipher(player) : format.url

      if (!playableUrl) {
        attempts.push(`${name}: could not decipher the URL`)
        continue
      }

      return {
        video_id: videoId,
        title: info.basic_info.title ?? videoId,
        // YouTube's "author" is the channel, which is the closest thing to an
        // artist it offers. The server's importer makes the same compromise.
        artist: info.basic_info.author ?? 'Unknown',
        duration: info.basic_info.duration ?? null,
        // Over TLS, always (#456). googlevideo hands back a mix of schemes and
        // Android refuses the cleartext ones before they leave the phone.
        audio_url: overHttps(playableUrl),
        // Widest first, which is how youtubei.js orders them. A track row shows
        // this at ~48px and the lock screen much larger, so downscaling one
        // decent image beats fetching a thumbnail too small for the bigger use.
        cover_url: overHttps(info.basic_info.thumbnail?.[0]?.url ?? null),
        // Only the peak is missing, and only the peak needs measuring: mobile
        // playback attenuates and never amplifies (`ATTENUATE_ONLY`), so the
        // clipping guard peak exists for is unreachable here.
        loudness_lufs: format.track_absolute_loudness_lkfs ?? null,
        content_length: format.content_length ?? null,
        client: name,
        http_headers: {},
      }
    } catch (error) {
      attempts.push(`${name}: ${String(error).slice(0, 80)}`)
    }
  }

  // Every client reached YouTube and every one was told the video will not
  // play. That is an answer, not a refusal of us, and it says so (#400).
  if (unplayable) {
    throw new VideoUnavailable(
      `${videoId}: ${unplayable.reason || unplayable.status}`,
      unplayable.status,
    )
  }

  throw new ExtractionFailed(
    `No client could provide audio for ${videoId} — ${attempts.join('; ')}`,
  )
}

/** Test seam: the client is module state and outlives a test. */
export function __resetYoutubeClient(): void {
  client = null
}
