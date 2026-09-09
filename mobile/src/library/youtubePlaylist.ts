import { describeError, logInfo, logWarn } from '../diagnostics/log'
import { thumbnailOf } from './deviceSearch'
import { youtubeClient } from './extract'
import { ExternalPlaylistTruncated, ExternalSourceRefused } from './externalPlaylist'

/**
 * Listing a YouTube playlist, on the device (#622).
 *
 * The last thing the server did for a YouTube import. `POST
 * /playlist-imports/youtube` (ADR-010) listed the playlist with yt-dlp and the
 * phone did the rest; this replaces the listing, so the whole path is local.
 *
 * ## Why `youtubei.js` rather than a direct `youtubei/v1/browse`
 *
 * #534 moved *audio extraction* off `youtubei.js` because its React Native
 * platform shim is not the Node one — so the honest question here was whether
 * browsing is affected too. It is not, and there is evidence rather than
 * hope: **`deviceSearch.ts` already calls `youtube.search()` on the phone and
 * has since #353.** Search and playlist listing are the same `browse`-family
 * request; what broke extraction was the player script and signature
 * deciphering, which no listing touches.
 *
 * ⚠️ **Measured 2026-08-19, and it changed the shape of this file.** The classic
 * `playlistVideoRenderer` that every tutorial parses is **gone** — YouTube now
 * answers with `lockupViewModel`, on every client tried (WEB old and new,
 * TVHTML5, WEB_REMIX; ANDROID and IOS refuse `browse` with 400 outright).
 * `youtubei.js` does understand it, surfacing items as `LockupView` with
 * `content_id` and `metadata.title.text` — which is exactly why this reads
 * those fields and not `id`/`title`, and why hand-rolling a parser against the
 * documented shape would have produced an importer that silently found nothing.
 */

/** One entry of a YouTube playlist. It is its own candidate (ADR-010). */
export interface YouTubePlaylistTrack {
  videoId: string
  title: string
  uploader: string | null
  durationSeconds: number | null
  /**
   * Cover art for the review row (#635).
   *
   * A YouTube playlist entry **is** its own candidate (ADR-010), so nothing
   * searches for it and nothing else ever supplies one — which is why these
   * imports drew an empty square while a Spotify import against the same source
   * had artwork on every row. `lockupViewModel` carries it as
   * `content_image.image[]`, the same `{url,width}` shape search returns.
   */
  thumbnail: string | null
}

export interface YouTubePlaylistListing {
  playlistId: string
  name: string
  tracks: YouTubePlaylistTrack[]
}

/** 100 entries a page, so this is 2000 tracks. A ceiling exists so a playlist
 *  that never stops paging cannot hang the import instead of failing it. */
const MAX_PAGES = 20

export class NotAYouTubePlaylist extends Error {
  constructor(input: string) {
    super(`Not a YouTube playlist link: ${input}`)
    this.name = 'NotAYouTubePlaylist'
  }
}

/**
 * The playlist id in a URL, or a bare id.
 *
 * ⚠️ A bare id is accepted deliberately — #564 was three importers that had
 * always taken one and said so nowhere, and a user who copies an id out of a
 * URL should not be told it is not a link.
 */
export function playlistIdFrom(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new NotAYouTubePlaylist(input)
  // `PL…`, `UU…` (a channel's uploads), `OLAK5…` (an album), `RD…` (a mix).
  if (/^(PL|UU|OLAK5|LL|FL|RD)[\w-]{2,}$/.test(trimmed)) return trimmed
  const fromQuery = /[?&]list=([\w-]+)/.exec(trimmed)?.[1]
  if (fromQuery) return fromQuery
  throw new NotAYouTubePlaylist(input)
}

/** `"960 videos"` → 960. YouTube reports the total as prose, not a number. */
export function claimedTotalFrom(total: unknown): number | null {
  if (typeof total === 'number') return Number.isFinite(total) ? total : null
  if (typeof total !== 'string') return null
  const digits = total.replace(/[^\d]/g, '')
  return digits ? Number(digits) : null
}

/** `"3:15"` → 195. Absent on some rows, which is not a failure. */
export function durationFrom(text: unknown): number | null {
  if (typeof text !== 'string') return null
  const parts = text.trim().split(':')
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null
  return parts.reduce((total, part) => total * 60 + Number(part), 0)
}

/** Dig the uploader out of a `LockupView`'s metadata rows. */
function uploaderFrom(item: Record<string, unknown>): string | null {
  const metadata = item.metadata as
    | { metadata?: { metadata_rows?: { metadata_parts?: { text?: { text?: string } }[] }[] } }
    | undefined
  const rows = metadata?.metadata?.metadata_rows ?? []
  for (const row of rows) {
    const text = row.metadata_parts?.[0]?.text?.text
    if (typeof text === 'string' && text.trim()) return text.trim()
  }
  return null
}

function titleFrom(item: Record<string, unknown>): string | null {
  const metadata = item.metadata as { title?: { text?: string } } | undefined
  const text = metadata?.title?.text
  return typeof text === 'string' && text.trim() ? text.trim() : null
}

/**
 * Map one raw entry, or `null` if it is not a playable video.
 *
 * Exported because `__tests__/fixtures/youtubePlaylistItems.json` holds real
 * entries captured from the live API — the field paths here were read off that
 * response rather than off documentation, and a fixture is the only way to keep
 * them honest without a network call in the suite.
 *
 * A playlist can contain a deleted or private entry; those carry no usable id
 * and are dropped. ⚠️ **Dropping is counted**, never silent — that is #585,
 * where entries a fetch could not read were discarded and the survivors
 * recorded as the playlist's size, so an eighteen-track import said "4/4 done".
 */
export function parsePlaylistItem(raw: unknown): YouTubePlaylistTrack | null {
  const item = raw as Record<string, unknown>
  const videoId = item?.content_id
  if (typeof videoId !== 'string' || !videoId) return null
  if (item.content_type && item.content_type !== 'VIDEO') return null
  const title = titleFrom(item)
  if (!title) return null
  const durationText = /"text":"(\d+:\d{2}(?::\d{2})?)"/.exec(JSON.stringify(item))?.[1]
  return {
    videoId,
    title,
    uploader: uploaderFrom(item),
    durationSeconds: durationFrom(durationText),
    // `thumbnailOf` and not a rule of our own: the same function search uses,
    // so one candidate cannot draw at a different size than another (#635).
    thumbnail: thumbnailOf((item.content_image as { image?: unknown } | undefined)?.image),
  }
}

/**
 * Read a whole YouTube playlist.
 *
 * Throws `ExternalPlaylistTruncated` when the playlist says it holds more than
 * this managed to read, so a short import fails loudly rather than importing
 * part of somebody's playlist and calling it done.
 */
export async function fetchYouTubePlaylist(input: string): Promise<YouTubePlaylistListing> {
  const playlistId = playlistIdFrom(input)
  const youtube = await youtubeClient()

  let page
  try {
    page = await youtube.getPlaylist(playlistId)
  } catch (error: unknown) {
    // A private or deleted playlist and a network failure ask for different
    // actions, and only the source can tell us which this is (#492's lesson).
    logWarn('youtubePlaylist.refused', describeError(error))
    throw new ExternalSourceRefused(describeError(error), 'browse')
  }

  const name = typeof page.info?.title === 'string' ? page.info.title : 'YouTube playlist'
  const claimed = claimedTotalFrom(page.info?.total_items)

  const tracks: YouTubePlaylistTrack[] = []
  let dropped = 0
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    for (const raw of page.items ?? []) {
      const track = parsePlaylistItem(raw)
      if (track) tracks.push(track)
      else dropped += 1
    }
    if (!page.has_continuation) break
    page = await page.getContinuation()
  }

  logInfo(
    'youtubePlaylist.read',
    `${tracks.length} track(s), ${dropped} unreadable, claimed ${claimed ?? '?'}`,
  )

  if (claimed !== null && tracks.length + dropped < claimed) {
    throw new ExternalPlaylistTruncated(claimed, tracks.length)
  }
  return { playlistId, name, tracks }
}
