/**
 * Searching Bilibili from the phone (#551).
 *
 * ## Why this exists
 *
 * A user in mainland China cannot reach YouTube, so every path that *finds*
 * music — the Search tab, a Spotify import, a NetEase/QQ/Kugou import — is
 * closed to them. Bilibili is the only source inside China that MiO is willing
 * to take audio from: the project's ground rules and ADR-013 decision 1 restrict it to
 * user-upload video platforms, never licensed music services, which is what
 * rules out Migu, Kuwo and the audio of the very services these imports read.
 *
 * The download half already works — `platformOf` routes Bilibili and the phone
 * fetches it (#492). Only the searching was missing.
 *
 * ## One request, and the old cost was yt-dlp's
 *
 * `x/web-interface/search/type` returns **20 full results in one request**,
 * ~0.5 s. `docs/bilibili.md` §2 established that the 117-second, 3-result
 * figure this project used to quote was an artefact of `BiliBiliSearchIE`,
 * which throws the metadata away and yields URLs for the downloader to
 * re-extract one at a time. It was never a Bilibili limit.
 *
 * ## ⚠️ Pacing is a measured requirement
 *
 * `docs/bilibili.md` §2.2, measured 2026-08-16: the endpoint refuses at ~1.9
 * requests per second (412 at request 76) and serves **320 in nine minutes**
 * paced at one per second. The limiter is a *rate*, not a budget — so a
 * matching loop must space its searches, and {@link paceBilibiliSearch} is
 * that. Without it a playlist of any size fails partway through and the
 * address is refused for a quarter of an hour.
 */

import type { SearchResult } from '../api/types'
import { newBuvid3 } from './bilibili'
import { canonicalUrlFor } from './bilibiliUrl'
import { logInfo } from '../diagnostics/log'

const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/search/type'

/**
 * The **source** refused, not this query (#586).
 *
 * ## Why the distinction is the whole fix
 *
 * `searchOnDeviceQuietly` swallows a failed search and returns `[]`, which
 * marks that track `no_match`. That is right for a track nobody can find — one
 * bad row must not end a forty-track run — and it is wrong for a 412, because a
 * 412 is about the **address**, so every remaining track will get one too.
 *
 * Measured in my log, 2026-08-17: two bursts, one request a second, a 412
 * every time, for at least 35 seconds. The pacing was working perfectly; the
 * loop simply spent the rest of the playlist discovering the same refusal once
 * per track and filing each as a failure.
 *
 * ⚠️ **Not fixed by slowing down.** `docs/bilibili.md` §2.2 measured the rate
 * and 1/s is right — this happened *at* that rate. The answer is to stop, not
 * to crawl.
 *
 * `status` is kept because 412 and 429 mean the same thing to us and neither is
 * worth a separate class, while a 500 is a different story worth telling apart
 * later.
 */
export class SearchRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'SearchRefused'
  }
}

/**
 * Whether this failure means *wait*, rather than *this track cannot be found*.
 *
 * ⚠️ **By `name`, not `instanceof`** — the same reason `failureKind.ts` matches
 * `DownloadWasShort` and `BilibiliRefused` that way: this is called from inside
 * `catch` blocks, and a jest module mock that does not re-export a real class
 * makes `error instanceof undefined` throw *from within the catch being
 * tested*. That has bitten this repo four times now.
 */
export function isSourceRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === 'SearchRefused'
}

/**
 * The smallest gap between two searches that was measured clean.
 *
 * 1000 ms, and the number is a reading rather than a guess: 0.65 req/s served
 * 320 searches without a refusal, 1.9 req/s refused at 76. The threshold
 * between them was not measured, so this is a value known to work rather than
 * a boundary that was found — do not lower it without re-measuring §2.2.
 */
export const BILIBILI_SEARCH_PACE_MS = 1000

/** When the next search may start. Module state, so the pace holds across the
 *  whole app rather than per caller — two screens searching at once would
 *  otherwise each think they were being polite. */
let nextAllowedAt = 0

/**
 * Wait until this device is allowed to search Bilibili again.
 *
 * Exported so a matching loop can pace *itself* around the search rather than
 * discovering the limit at track 76. Callers that search once — a user typing
 * — pay nothing, because the gate is already open.
 */
export async function paceBilibiliSearch(): Promise<void> {
  const now = Date.now()
  const waitMs = Math.max(0, nextAllowedAt - now)
  nextAllowedAt = Math.max(now, nextAllowedAt) + BILIBILI_SEARCH_PACE_MS
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
}

/** Test seam: forget the pacing window between tests. */
export function resetBilibiliSearchPace(): void {
  nextAllowedAt = 0
}

type RawResult = {
  bvid?: unknown
  title?: unknown
  author?: unknown
  duration?: unknown
  pic?: unknown
}

/**
 * Bilibili marks the matched words in a result title with HTML.
 *
 * A real title comes back as
 * `<em class="keyword">R. Kelly</em>, Usher - <em class="keyword">Same Girl</em>`.
 * `normalize()` in `matching.py` strips punctuation and splits on whitespace,
 * so leaving the tags in adds `em`, `class` and `keyword` as tokens to **every**
 * candidate — poisoning `token_set_ratio` in a way that would look like the
 * matcher getting worse rather than like a parsing bug.
 *
 * Entities are decoded after the tags come out, because `&amp;` appears in
 * ordinary titles and would otherwise reach the scorer as `amp`.
 */
export function stripSearchMarkup(title: string): string {
  return (
    title
      .replace(/<[^>]*>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      // Last, or it would turn `&amp;quot;` into a quote that was never there.
      .replace(/&amp;/g, '&')
      .trim()
  )
}

/**
 * Bilibili's search gives a duration as `"4:48"`, not a number of seconds.
 *
 * ⚠️ This is not cosmetic. `_duration_score` treats an unknown duration as a
 * neutral 0.5, so sending `null` would silently convert the 15% of the score
 * that duration carries into a constant — the cheapest strong discriminator
 * against covers and live cuts, quietly switched off.
 *
 * `"1:02:03"` is accepted too; the favourites endpoint returns plain integer
 * seconds, and only *search* uses this format (`docs/bilibili.md` §6).
 */
export function durationSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value !== 'string') return null

  const parts = value.trim().split(':')
  if (parts.length < 2 || parts.length > 3) return null

  let total = 0
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    total = total * 60 + Number(part)
  }
  return total > 0 ? total : null
}

/**
 * Cover art, over https.
 *
 * Search returns the protocol-relative `//i0.hdslb.com/…`, which `overHttps`
 * does not fix — its regex is anchored on `http://`. Exactly the case
 * `coverOverHttps` in `bilibiliFav.ts` was written for; repeated here rather
 * than shared because that one is private to the favourites reader and this
 * module must not import it.
 */
function coverUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const trimmed = value.trim()
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  return trimmed.replace(/^http:\/\//i, 'https://')
}

function readResult(raw: RawResult): SearchResult | null {
  const bvid = typeof raw.bvid === 'string' ? raw.bvid.trim() : ''
  const rawTitle = typeof raw.title === 'string' ? raw.title : ''
  const title = stripSearchMarkup(rawTitle)
  // Skipped rather than failed, for the same reason `readVideo` skips a node it
  // does not recognise: one odd row must not cost the other nineteen.
  if (!bvid || !title) return null

  return {
    // Canonical, so a video found by search and the same video pasted as a link
    // become one library row — `songs.source_url` is UNIQUE since v6.
    url: canonicalUrlFor(bvid),
    title,
    uploader: typeof raw.author === 'string' && raw.author.trim() ? raw.author.trim() : null,
    duration: durationSeconds(raw.duration),
    thumbnail: coverUrl(raw.pic),
  }
}

/**
 * Top Bilibili results for `query`.
 *
 * Paced by {@link paceBilibiliSearch} on every call, so a caller cannot forget.
 * A 412 is surfaced as a throw rather than an empty list: refused and empty are
 * different answers, and only one of them is worth waiting out.
 */
export async function searchBilibiliOnDevice(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  await paceBilibiliSearch()

  const response = await fetch(
    `${SEARCH_URL}?search_type=video&page=1&keyword=${encodeURIComponent(trimmed)}`,
    {
      /*
       * ⛔ `omit` is load-bearing, and without it the header below is a lie
       * (#723).
       *
       * React Native installs a **shared, persistent cookie jar** on every
       * `fetch` — `OkHttpClientProvider` sets `ReactCookieJarContainer`, which
       * `NetworkingModule` backs with `ForwardingCookieHandler` over
       * `android.webkit.CookieManager`, and that survives app restarts. So the
       * jar accumulates whatever Bilibili has ever set on this device: an aged
       * `buvid3` it has been profiling, and `SESSDATA` if the QR login has ever
       * run.
       *
       * OkHttp's `BridgeInterceptor` then sets the `Cookie` header with
       * `.header()`, which **replaces**. The fresh anonymous `buvid3` below was
       * being overwritten by the device's tracked one on every search.
       *
       * Measured on a device: the same query returned a stably *different*
       * ranking from a clean request — long compilations where an anonymous
       * request returns the official MVs. Three clean runs agreed with each
       * other and disagreed with the phone, which is what makes it a reading
       * rather than noise.
       *
       * ⚠️ `omit` does **not** drop the header below. Read, not assumed:
       * `whatwg-fetch` maps `'omit'` to `withCredentials = false`
       * (`fetch.umd.js:595`), `NetworkingModule` turns that into
       * `CookieJar.NO_COOKIES` (`:371`), and `BridgeInterceptor` only writes
       * `Cookie` when the jar returns a non-empty list — verified in okhttp
       * 4.12's bytecode, where the `ldc "Cookie"` is inside the `isEmpty`
       * branch. An empty jar leaves an explicit header alone.
       *
       * Same shape as #534 on YouTube: send a visitor id and no cookies.
       */
      credentials: 'omit',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://www.bilibili.com/',
        Cookie: `buvid3=${newBuvid3()}`,
      },
    },
  )

  // 412 is Bilibili's refusal, and after volume it means the *address* is rate
  // limited — nothing we send changes it and only ~15 minutes does
  // (`docs/bilibili.md` §2.1). Reporting it as "no results" would send the user
  // looking for a different search term for a problem that is about time.
  if (!response.ok) {
    throw new SearchRefused(`Bilibili search refused: HTTP ${response.status}`, response.status)
  }

  const body = (await response.json()) as { code?: unknown; data?: { result?: unknown } }
  if (typeof body.code === 'number' && body.code !== 0) {
    throw new Error(`Bilibili search answered code ${body.code}`)
  }

  const rows = Array.isArray(body.data?.result) ? (body.data.result as RawResult[]) : []
  const results: SearchResult[] = []
  for (const row of rows) {
    const result = readResult(row)
    if (result) results.push(result)
    if (results.length >= limit) break
  }

  logInfo('search.bilibili', `${results.length} result(s)`)
  return results
}
