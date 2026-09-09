import type { SearchResult } from '../api/types'
import { describeError, logInfo, logWarn } from '../diagnostics/log'
import { isSourceRefusal, searchBilibiliOnDevice } from './bilibiliSearch'
import { currentSearchSource, type SearchSource } from './searchSource'
import { youtubeClient } from './extract'

/**
 * Searching YouTube from the phone (#353).
 *
 * The other half of #246. Adding music already happens on the device; **finding**
 * it did not, and that was the last ordinary thing that still needed the server
 * to talk to YouTube.
 *
 * ## Why the server cannot do this
 *
 * YouTube refuses the droplet's address on every client — measured at **1
 * request in 14** (#177), and unchanged by a proof-of-origin provider, a
 * JavaScript runtime or a signed-in cookie file. A phone is not refused,
 * because a phone is on a residential connection. That is the whole of the
 * argument, and it is the same one that moved the downloads.
 *
 * *"when can you stop relying on the laptop, what if real user is using
 * the app, i got keep my laptop on all the time and be next to them,
 * impossible."*
 *
 * ## It reuses the client that already exists
 *
 * `extract.ts` already creates and caches one `Innertube` for downloading, so
 * this is a new call on an existing client rather than new infrastructure —
 * including the shimmed `eval` that makes deciphering work. Nothing here needs
 * the player script, but sharing the client is still right: creating a second
 * one would fetch and parse that script twice.
 *
 * ## The shape was measured, not assumed
 *
 * Run against the live API before any of this was written, across an English
 * query, a CJK query, a hyphenated "Artist - Title" query and a nonsense one:
 *
 * - every result came back as a `Video` node, 20 per search;
 * - `duration` is an object — `{ text: '3:44', seconds: 224 }` — not a number;
 * - `title` and `author` are objects with a `.text` / `.name`, not strings;
 * - a query matching nothing returns an empty list rather than throwing.
 *
 * The reader below is still defensive about all of that, because a YouTube
 * response shape is not a promise anyone made us. But it is defensive from
 * evidence rather than from imagination.
 *
 * ## Two sources since #551
 *
 * A user in mainland China cannot reach YouTube at all, so this dispatches on
 * the chosen source (`searchSource.ts`) and `bilibiliSearch.ts` is the other
 * half. Everything downstream is unchanged: both return the same
 * `SearchResult[]`, and a candidate's URL is what decides which extractor
 * downloads it (`platformOf`, #492), so there is no second decision to keep in
 * step.
 *
 * ⚠️ **The Bilibili path paces itself at one request per second** and the
 * YouTube path does not. That is a measured requirement, not caution — see
 * `docs/bilibili.md` §2.2.
 */

/** How many results to show. Matches what `GET /search` served, so the screen
 *  sees no change in density. */
const DEFAULT_LIMIT = 20

/**
 * Top results for `query`, straight from this device.
 *
 * Throws if the search itself fails, which the screen already renders — the
 * caller is a TanStack query and an error state is a thing it knows how to draw.
 */
export async function searchOnDevice(
  query: string,
  limit: number = DEFAULT_LIMIT,
  source: SearchSource = currentSearchSource(),
): Promise<SearchResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  // The query is the user's business, not the log's (#354). How many results
  // came back, and which source answered, are ours.
  logInfo('search.started', `on device via ${source}`)

  if (source === 'bilibili') return searchBilibiliOnDevice(trimmed, limit)

  const youtube = await youtubeClient()
  const search = await youtube.search(trimmed, { type: 'video' })

  const results: SearchResult[] = []
  for (const node of search.videos) {
    const result = readVideo(node)
    if (result) results.push(result)
    if (results.length >= limit) break
  }

  logInfo('search.finished', `${results.length} result(s)`)
  return results
}

/**
 * One search result, or null if the node is not a usable video.
 *
 * Skipped rather than failed, for the same reason the server's search skipped
 * unextractable entries (#124): one live-stream placeholder or one node shape
 * this does not recognise must not cost the user their other nineteen results.
 */
function readVideo(node: unknown): SearchResult | null {
  const video = node as {
    video_id?: unknown
    id?: unknown
    title?: unknown
    author?: unknown
    duration?: unknown
    thumbnails?: unknown
  }

  const videoId = firstString(video.video_id, video.id)
  const title = textOf(video.title)
  if (!videoId || !title) return null

  return {
    // Built rather than read. A node carries several endpoints and shortened
    // forms; the canonical watch URL is what every other part of this app
    // treats as a song's identity, and it must match what `extract.ts` and
    // `saveDeviceSongMetadata` write (`source_url`) or the same video imported
    // from search and from a pasted link would become two rows.
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    uploader: nameOf(video.author),
    duration: secondsOf(video.duration),
    thumbnail: thumbnailOf(video.thumbnails),
  }
}

/** The first of these that is a non-empty string. */
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

/** A youtubei.js `Text`, which is an object with `.text` — or already a string. */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (value && typeof value === 'object' && 'text' in value) {
    const text = (value as { text?: unknown }).text
    if (typeof text === 'string') return text.trim() || null
  }
  return null
}

/** An `Author`, which carries `.name`. */
function nameOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (value && typeof value === 'object' && 'name' in value) {
    const name = (value as { name?: unknown }).name
    if (typeof name === 'string') return name.trim() || null
  }
  return null
}

/**
 * Duration in seconds.
 *
 * `{ text: '3:44', seconds: 224 }` in the measured responses. The number form
 * is accepted too — and `0` is deliberately treated as unknown rather than as a
 * zero-length track, because that is what a live stream reports and a duration
 * of zero would score as a 224-second mismatch in the matcher.
 */
function secondsOf(value: unknown): number | null {
  if (typeof value === 'number') return value > 0 ? value : null
  if (value && typeof value === 'object' && 'seconds' in value) {
    const seconds = (value as { seconds?: unknown }).seconds
    if (typeof seconds === 'number' && seconds > 0) return seconds
  }
  return null
}

/**
 * The widest thumbnail worth sending to a phone.
 *
 * The same ceiling the server applies (`ytdlp.py`'s `_MAX_THUMBNAIL_WIDTH`), and
 * for the same reason: a review row is a 44-point square, so anything past this
 * is bytes nobody sees. Kept identical on purpose — the two paths feed the same
 * screens, and a different rule here would show up as art that changes size
 * depending on where a candidate came from.
 */
const MAX_THUMBNAIL_WIDTH = 640

/**
 * The largest thumbnail within the ceiling, else the smallest available.
 *
 * Exported for `youtubePlaylist.ts` (#635) rather than copied into it. Both read
 * a YouTube response and both feed `MatchReview`, so a second selection rule
 * would show up as art that changes size depending on which import produced the
 * candidate — which is the drift `MAX_THUMBNAIL_WIDTH` above was kept identical
 * to the server's to avoid in the first place.
 */
export function thumbnailOf(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null

  const usable = value
    .filter(
      (entry): entry is { url: string; width?: number } =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as { url?: unknown }).url === 'string',
    )
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0))

  if (usable.length === 0) return null
  const withinCeiling = usable.filter((entry) => (entry.width ?? 0) <= MAX_THUMBNAIL_WIDTH)
  // Smallest available when every option is oversized — a too-large thumbnail
  // still draws, and no thumbnail at all is the worse answer.
  return (withinCeiling[withinCeiling.length - 1] ?? usable[0]).url
}

/**
 * Search, swallowing a failure **about this track** and propagating one about
 * the **source** (#586).
 *
 * For the matching loop (#353), where one track that cannot be searched must
 * degrade that row and never the run — the same contract the server's matching
 * phase had, kept so the review screen behaves identically.
 *
 * ## ⚠️ Why it is no longer "without letting a failure reach the caller"
 *
 * It used to swallow everything, and that turned a rate limit into forty
 * `no_match` rows. A 412 is not a fact about the track; it is a fact about the
 * **address**, so the next track gets one too, and the one after that. My
 * log for 2026-08-17 has the shape exactly: one request a second, a 412 every
 * time, for at least 35 seconds, each one filed as a track that could not be
 * found.
 *
 * So the contract is finer than it was, and the finer version is the one that
 * was always meant: *one track's failure must never end the run* — which says
 * nothing about a failure that is not one track's.
 */
export async function searchOnDeviceQuietly(
  query: string,
  limit?: number,
  source?: SearchSource,
): Promise<SearchResult[]> {
  try {
    return await searchOnDevice(query, limit, source)
  } catch (error) {
    logWarn('search.failed', describeError(error))
    if (isSourceRefusal(error)) throw error
    return []
  }
}
