import { logInfo, logWarn } from '../diagnostics/log'
import { signedUrl } from './bilibiliWbi'
import { randomHex } from '../random'
import { canonicalUrlFor, isShortLink, refFrom, type BilibiliRef } from './bilibiliUrl'
import { BilibiliSignedOut, NOT_LOGGED_IN, currentSessdata } from './bilibiliAuth'
import { ExtractionFailed, VideoUnavailable, overHttps, type ExtractedAudio } from './extract'

/**
 * Fetching a Bilibili video's audio, on this device (#492).
 *
 * ## What the refusals actually were
 *
 * This project spent three issues explaining Bilibili's **412** — as rate
 * limiting (#214), as the droplet's address (#327), as the `b23.tv` short link
 * (#381). It is none of those. Measured 2026-08-13, alternating shapes over
 * three rounds so one reading could not stand in for a measurement:
 *
 *     bare                              412  412  412
 *     browser UA + Referer              412  412  200
 *     browser UA + Referer + buvid3     200  200  200
 *
 * **`buvid3` is a cookie we invent ourselves.** Any UUID with `infoc` appended
 * is accepted — there is no server-side validation — and yt-dlp has done exactly
 * this for years in `BiliBiliSearchIE`. That is almost certainly the whole of
 * how a hosted service fetches Bilibili from a datacenter: not a proxy, not a
 * signing scheme, not credentials. The request shape.
 *
 * ⚠️ The *first* probe of that session was a bare request that answered 200 with
 * 20 results, and it nearly sent this the wrong way — a fresh address gets a
 * request or two before the 412s start. Alternating is what corrected it.
 *
 * ## Three requests, no credentials, no signing
 *
 *     view?bvid=…        → cid, title, uploader, duration, cover
 *     playurl?bvid&cid   → DASH audio streams
 *     <baseUrl>          → the bytes, and this one needs the Referer
 *
 * yt-dlp signs `x/player/wbi/playurl` with a key derived from `x/web-interface/nav`.
 * The **legacy** endpoint used here answered with full DASH and needs none of
 * it. Signing is about twenty-five lines if that ever stops being true, and
 * `expo-crypto` already ships the MD5 it needs — but it is not written until it
 * is needed.
 *
 * ## What this does not get
 *
 * **Loudness.** YouTube ships an integrated-loudness measurement with its
 * player response and Bilibili does not, so `loudness_lufs` is null and these
 * tracks play uncorrected. `normalizationGain` already treats a missing
 * measurement as "no correction", so nothing breaks — but a Bilibili track will
 * sit at its own level next to a normalized YouTube one, and that is worth
 * knowing before it is reported as a bug.
 */

/**
 * A browser, because the API refuses something that does not look like one.
 *
 * Pinned rather than built from the device's own agent: what is being asserted
 * is "a desktop browser", and a real Android WebView string would be a
 * different claim with a different failure mode.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Required by the CDN, and by the API. Without it the audio URL answers 403
 *  even though the API happily minted it — "a URL is not a download" again. */
const REFERER = 'https://www.bilibili.com/'

const API = 'https://api.bilibili.com'

/**
 * How long any single request may take.
 *
 * The same twenty seconds `extract.ts` uses, and for the reason #411 recorded:
 * a path with no timeout at all is one dead socket away from an import that
 * never fails, never retries and never ends.
 */
const REQUEST_TIMEOUT_MS = 20_000

/** Bilibili's own DASH flag. 16 is "give me DASH"; yt-dlp asks for 4048, which
 *  additionally opts into codecs this app has no use for. */
const FNVAL_DASH = 16

/**
 * Bilibili refused the **request**, as opposed to the video.
 *
 * `Error` rather than `ExtractionFailed`, and the difference is not cosmetic.
 * `ExtractionFailed` means *every way in was tried and none had audio*, which
 * `classifyFailure` reads as `no_source` and does not retry. A 412 is the
 * opposite: nothing was wrong with the video, our request looked wrong, and the
 * next attempt carries a fresh `buvid3` that may well work.
 *
 * Extending it would also make this class's *definition* depend on a module
 * every test of the import path mocks — `extends undefined` throws at load, so
 * a suite would fail to start rather than fail an assertion.
 */
export class BilibiliRefused extends Error {
  constructor(
    message: string,
    /** The HTTP status, or Bilibili's own negative `code`. Named because the
     *  two mean different things and the log has to be able to say which. */
    readonly status: number,
  ) {
    super(message)
    // Matched **by name** in `failureKind.ts`, which cannot import this module.
    // `librarySources.test.ts` asserts the two agree.
    this.name = 'BilibiliRefused'
  }
}

/**
 * A fresh `buvid3` per extraction.
 *
 * Per attempt rather than per process, deliberately: if a value ever does get
 * rate-limited, the retry that follows carries a different one — which is the
 * whole reason a 412 is classified as worth retrying.
 *
 * Shaped like a UUID because that is what the site's own script produces. The
 * server does not check, and depending on that would be depending on a thing
 * nobody promised.
 */
export function newBuvid3(): string {
  const hex = randomHex(16)
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
  return `${uuid}infoc`
}

/**
 * One request to Bilibili, shaped like a browser and bounded in time.
 *
 * ⚠️ **The cookie is the load-bearing header**, and React Native's `fetch` is
 * backed by OkHttp with a cookie jar of its own. If `buvid3` is ever stripped
 * on the way out, every call here answers 412 — so this is the one place to
 * change if a device pass shows that, and the failure is named rather than
 * silent so the pass can tell.
 */
/**
 * The cookie every Bilibili request carries, plus the session when there is one.
 *
 * One place, so a private read and a public one cannot drift into different
 * request shapes — the drift that §2 of `docs/bilibili.md` spent three issues
 * diagnosing. `buvid3` is always sent; `SESSDATA` only when signed in.
 */
function cookieHeader(buvid3: string): string {
  const sessdata = currentSessdata()
  return sessdata ? `buvid3=${buvid3}; SESSDATA=${sessdata}` : `buvid3=${buvid3}`
}

async function bilibiliFetch(url: string, buvid3: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: REFERER,
        /*
         * `SESSDATA` rides along when one is held (#492 slice 3).
         *
         * Read synchronously from `bilibiliAuth`'s cache rather than threaded
         * through every call site: the alternative was an extra parameter on
         * `apiCall`, `extractBilibili`, `fetchFavList` and their callers, all of
         * which would be `undefined` at almost every one. A missing credential
         * simply means the public path, which is what this file did before.
         *
         * ⚠️ It is never logged. The cookie header is built here and nowhere
         * else, and `diagnosticsScrub.test.ts` holds that.
         */
        Cookie: cookieHeader(buvid3),
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      // 412 is Bilibili's anti-crawl page, and since #492 it means the request
      // did not look right — most likely the cookie never arrived.
      throw new BilibiliRefused(
        `Bilibili refused the request with status ${response.status}`,
        response.status,
      )
    }
    return response
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One API call, unwrapped. Bilibili puts its own status in the body: `code: 0`
 * is success and everything else is an answer about the video.
 *
 * Exported for `bilibiliFav.ts` rather than copied into it. The request shape —
 * the `buvid3` cookie above all — is the whole feature (§2 of
 * `docs/bilibili.md`), and a second hand-rolled copy of it is exactly how the
 * two would drift apart and one of them start answering 412.
 */
/**
 * The metadata call, signed (2026-09-08).
 *
 * ⚠️ **Unsigned `x/web-interface/view` survives one request and not twelve.**
 * Measured 2026-09-08 by alternating against 12 distinct videos at this loop's
 * own pace: unsigned **0/12**, signed **12/12**. In isolation an unsigned
 * request often still answers 200, which is why a single add-link kept working
 * while a 28-track import failed on every Bilibili track.
 *
 * ⛔ Do not restate this as "the endpoint was retired" — that reading was made
 * from one 412 and disproved by a user's own add-link. See `bilibiliWbi.ts`.
 */
export async function signedApiCall(
  endpoint: string,
  params: Record<string, string | number>,
  buvid3: string,
): Promise<Record<string, unknown>> {
  const url = await signedUrl(endpoint, params, fetch, {
    'User-Agent': USER_AGENT,
    Referer: REFERER,
    Cookie: cookieHeader(buvid3),
  })
  return apiCall(url, buvid3)
}

export async function apiCall(url: string, buvid3: string): Promise<Record<string, unknown>> {
  const response = await bilibiliFetch(url, buvid3)
  const body = (await response.json()) as {
    code?: number
    message?: string
    data?: Record<string, unknown>
  }

  if (body.code !== 0 || !body.data) {
    const code = body.code ?? -1
    const message = body.message ?? 'no message'
    /*
     * The video is gone, or not ours to have. Its own type, because retrying
     * cannot change it — the same distinction #400 had to learn for YouTube,
     * where three attempts and six seconds of backoff were spent on a video
     * that was region-locked.
     *
     * -404 is deleted, -403 is members-only or a private list, 62002 is
     * withdrawn by the uploader, 62004 is under review.
     */
    /*
     * A dead session, which asks for a completely different action (#492).
     *
     * `-101` is "not logged in" and `-403` is "not yours". There is no refresh
     * token, so a stored `SESSDATA` stops working one day with no warning — and
     * reporting that as "this folder is private" would send the user looking at
     * Bilibili's privacy settings for a fault that is ours to fix by asking them
     * to sign in again. Exactly #106's two-things-one-error trap.
     */
    if (code === NOT_LOGGED_IN) {
      throw new BilibiliSignedOut(`Bilibili: ${message}`)
    }
    if (code === -404 || code === -403 || code === 62002 || code === 62004) {
      throw new VideoUnavailable(`Bilibili: ${message}`, String(code))
    }
    throw new BilibiliRefused(`Bilibili answered code ${code}: ${message}`, code)
  }

  return body.data
}

/**
 * Follow a `b23.tv` link to the video it points at.
 *
 * The redirect is followed by `fetch` itself; what this reads is where it
 * landed. `response.url` is the only thing that carries that, and it is the
 * part untested outside a device — a runtime that does not populate it would
 * make every short link fail as "not a Bilibili link", which is why the failure
 * says what it actually was.
 */
export async function resolveShortLink(url: string, buvid3: string): Promise<string> {
  const response = await bilibiliFetch(url, buvid3)
  const landed = response.url
  if (!landed || landed === url) {
    throw new BilibiliRefused(`Short link did not resolve: ${url}`, response.status)
  }
  return landed
}

/** The best audio stream: highest bandwidth, which is how Bilibili orders
 *  quality. Video streams are ignored entirely — this app wants audio. */
function bestAudio(streams: { baseUrl?: string; bandwidth?: number; size?: number }[]) {
  return streams
    .filter((stream) => typeof stream.baseUrl === 'string' && stream.baseUrl.length > 0)
    .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0]
}

/**
 * Everything the device needs to store one Bilibili video.
 *
 * Returns the **same `ExtractedAudio`** the YouTube path does, whose
 * `http_headers` field has been an unused seam since #246 with a comment saying
 * this is what it is for. It carries the `Referer` here, and
 * `downloadAudioFromUrl` already repeats it on every chunk.
 */
/** One part of a multi-part upload, as the picker needs it (#575). */
export interface BilibiliPart {
  /** 1-based, and Bilibili's own — never the array index. `?p=` names this. */
  page: number
  title: string
  durationSeconds: number | null
  /** The canonical URL for *this part*, which is what the import loop walks and
   *  what `songs.source_url` will hold. */
  url: string
}

export interface BilibiliVideoParts {
  bvid: string
  /** The upload's title, which names the playlist a multi-part import creates. */
  title: string
  parts: BilibiliPart[]
}

/**
 * What parts this link's video has, without downloading anything (#575).
 *
 * One `view` call — the same one `extractBilibiliAudio` makes — so asking the
 * question costs what the extraction was going to cost anyway. It is asked
 * *before* importing, because the answer decides whether there is anything to
 * ask the user.
 *
 * Returns a single-element `parts` for an ordinary video, so the caller has one
 * shape rather than two. Its `title` is `view.title`, not the page's `part`,
 * matching what {@link extractBilibiliAudio} does for the same reason: a
 * single-part upload's one page row often holds a placeholder.
 */
export async function listBilibiliParts(input: string): Promise<BilibiliVideoParts> {
  const buvid3 = newBuvid3()
  const link = isShortLink(input) ? await resolveShortLink(input, buvid3) : input
  const ref = refFrom(link)

  const idParam: Record<string, string> =
    'bvid' in ref ? { bvid: ref.bvid } : { aid: String(ref.aid) }
  const view = (await signedApiCall(`${API}/x/web-interface/wbi/view`, idParam, buvid3)) as {
    bvid?: string
    title?: string
    duration?: number
    pages?: { cid?: number; page?: number; part?: string; duration?: number }[]
  }

  const bvid = view.bvid
  if (typeof bvid !== 'string' || bvid.length === 0) {
    throw new BilibiliRefused('Bilibili returned no bvid for this video', 0)
  }

  const title = view.title ?? bvid
  const pages = view.pages ?? []
  if (pages.length <= 1) {
    return {
      bvid,
      title,
      parts: [
        {
          page: 1,
          title,
          durationSeconds: typeof view.duration === 'number' ? view.duration : null,
          url: canonicalUrlFor(bvid),
        },
      ],
    }
  }

  return {
    bvid,
    title,
    parts: pages
      // A row with no page number cannot be addressed by `?p=`, so it cannot be
      // imported and must not be offered.
      .filter((page): page is { page: number } & typeof page => typeof page.page === 'number')
      .map((page) => ({
        page: page.page,
        // Falls back to the upload's title rather than to an empty row: a part
        // with no name of its own is still a part.
        title: page.part || title,
        durationSeconds: typeof page.duration === 'number' ? page.duration : null,
        url: canonicalUrlFor(bvid, page.page),
      })),
  }
}

export async function extractBilibiliAudio(input: string): Promise<ExtractedAudio> {
  const buvid3 = newBuvid3()

  const link = isShortLink(input) ? await resolveShortLink(input, buvid3) : input
  const ref: BilibiliRef = refFrom(link)

  const idParam: Record<string, string> =
    'bvid' in ref ? { bvid: ref.bvid } : { aid: String(ref.aid) }
  const view = (await signedApiCall(`${API}/x/web-interface/wbi/view`, idParam, buvid3)) as {
    bvid?: string
    title?: string
    pic?: string
    duration?: number
    cid?: number
    owner?: { name?: string }
    // Measured on `BV1r84y1e77t` (33 parts), 2026-08-17: every row carries all
    // four, and `page` is 1-based and matches what `?p=` names.
    pages?: { cid?: number; page?: number; part?: string; duration?: number }[]
  }

  const bvid = view.bvid
  // The canonical id comes from Bilibili rather than from what was pasted,
  // which is what makes an `av` link and a `BV` link one row and not two.
  if (typeof bvid !== 'string' || bvid.length === 0) {
    throw new BilibiliRefused('Bilibili returned no bvid for this video', 0)
  }

  /*
   * The part the link named, or the first one (#575).
   *
   * ⚠️ This used to be `view.cid ?? pages[0].cid` unconditionally — and the
   * view's top-level `cid` **is** `pages[0].cid`, measured, so a link to part 3
   * of a 33-part album silently downloaded part 1 under the whole video's
   * title. `?p=` was parsed by nothing.
   *
   * Matched on the stated `page` field rather than by array index. They coincide
   * in every payload measured, and one of those is a guarantee while the other
   * is an assumption about ordering nobody promised.
   *
   * Falling back to the first part when `?p=` names one that does not exist,
   * rather than refusing: the same judgement the YouTube path makes about a
   * video inside a playlist URL — the user pasted a link to a thing, and one
   * song is a better answer than an error.
   */
  const pages = view.pages ?? []
  const chosen = ref.part !== undefined ? pages.find((page) => page.page === ref.part) : undefined
  /*
   * The page whose metadata describes what is actually being fetched.
   *
   * Only for a genuinely multi-part upload. An ordinary video also has one
   * `pages` row, and its `part` is often a generic placeholder rather than a
   * title — so using it there would rename every single-part import for no
   * gain. `view.title` is what those have always used and what the user sees
   * on Bilibili.
   *
   * For a multi-part one it is `pages[0]` even when no `?p=` was given, because
   * part one is what gets downloaded and naming it after the whole album is
   * precisely the confusion this issue is about.
   */
  const effective = pages.length > 1 ? (chosen ?? pages[0]) : undefined
  const cid = effective?.cid ?? view.cid ?? pages[0]?.cid
  if (typeof cid !== 'number') {
    throw new BilibiliRefused('Bilibili returned no playable part for this video', 0)
  }
  // Only when a part was actually found: a `?p=` that matched nothing must not
  // put a number in the identity, or a bad link would become its own library row.
  const part = chosen !== undefined ? ref.part : undefined

  const play = (await apiCall(
    `${API}/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=${FNVAL_DASH}`,
    buvid3,
  )) as { dash?: { audio?: { baseUrl?: string; bandwidth?: number; size?: number }[] } }

  const audio = bestAudio(play.dash?.audio ?? [])
  if (!audio?.baseUrl) {
    // No DASH audio at all. Distinct from a refusal: the request worked and the
    // answer was "not in a form this app can use" — which is what a paid or
    // interactive video looks like.
    throw new ExtractionFailed(`Bilibili offered no audio stream for ${bvid}`)
  }

  logInfo('bilibili.extracted', `bandwidth=${audio.bandwidth ?? 'unknown'}`)

  return {
    video_id: bvid,
    // ⚠️ Load-bearing for identity, not decoration: `songs.source_url` is
    // UNIQUE since v6, so without the part every piece of one upload would be
    // the same row and importing part 2 after part 1 would collide with it.
    // `sourceUrlFor` is what turns this into the URL.
    part,
    /*
     * The **part's own** title where there is one, which is the half of this
     * fix that makes it useful rather than merely correct: a 33-part album
     * yields 33 songs called "Show You", "Find Me", "Want U 2" — not 33 called
     * after the upload.
     */
    title: effective?.part || view.title || bvid,
    // The uploader, which is the closest thing Bilibili offers to an artist —
    // the same choice the YouTube path makes with a channel name.
    artist: view.owner?.name ?? '',
    // The **part's** duration on a multi-part upload; `view.duration` is the
    // whole thing, which would be wrong by a factor of the part count.
    duration:
      typeof effective?.duration === 'number'
        ? effective.duration
        : typeof view.duration === 'number'
          ? view.duration
          : null,
    audio_url: overHttps(audio.baseUrl),
    // Protocol-relative (`//i0.hdslb.com/…`), which is a URL no fetch can use.
    cover_url: view.pic
      ? overHttps(view.pic.startsWith('//') ? `https:${view.pic}` : view.pic)
      : null,
    /*
     * Bilibili's legacy `playurl` does not state a size for DASH audio, and the
     * chunked downloader already handles that: it learns the total from the
     * first `Content-Range`, which is the only way an unstated size is ever
     * known (#454).
     */
    content_length: typeof audio.size === 'number' ? audio.size : null,
    // Not offered by this source. See the docblock — these play uncorrected.
    loudness_lufs: null,
    client: 'bilibili-web',
    /*
     * **The headers are the point.** Without the `Referer` the CDN answers 403
     * to a URL it minted seconds earlier, measured both ways on 2026-08-13.
     */
    http_headers: {
      'User-Agent': USER_AGENT,
      Referer: REFERER,
    },
  }
}

/** The canonical `source_url` for whatever was extracted — always the `BV`
 *  form, so one video is one row however it was pasted. */
export function sourceUrlFor(extracted: ExtractedAudio): string {
  return canonicalUrlFor(extracted.video_id, extracted.part)
}

/** Test seam and diagnostic: what a refusal looked like, without the URL. */
export function reportRefusal(error: unknown): void {
  if (error instanceof BilibiliRefused) {
    logWarn('bilibili.refused', `status=${error.status}`)
  }
}
