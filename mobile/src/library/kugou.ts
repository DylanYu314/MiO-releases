import { logInfo } from '../diagnostics/log'
import {
  ExternalPlaylistTruncated,
  ExternalSourceRefused,
  type ExternalPlaylist,
  type ExternalTrack,
} from './externalPlaylist'
import { canonicalKugouPlaylistUrl, kugouPlaylistId } from './kugouUrl'

/**
 * Reading a Kugou playlist on this device (#104, ADR-013).
 *
 * ## The endpoint, and the host the issue names is the wrong one
 *
 *     GET mobiles.kugou.com/api/v3/special/song
 *         ?specialid=<id>&page=<n>&pagesize=<n>
 *     → status, data.total, data.info[{ filename, duration, hash }]
 *
 * ⚠️ **#104 names `mobilecdn.kugou.com`, which cannot be used from the app.**
 * Its TLS certificate does not match the hostname — measured 2026-08-16,
 * `SSL: no alternative certificate subject name matches target host name` — so
 * HTTPS fails outright, and Android blocks the cleartext fallback (which is why
 * `failureKind.ts` has a `cleartext` kind at all). `mobiles.kugou.com` serves
 * the identical API with a **valid** certificate and is what this uses.
 *
 * Measured from a residential connection, no credentials: 13, 22, 22 and 107
 * tracks, in 0.9–3.2 s.
 *
 * ## It really does paginate, unlike QQ
 *
 * `pagesize=300` is honoured, and the paging contract was measured rather than
 * assumed: at `pagesize=50` a 107-track playlist returned 50, 50 and 7 rows
 * across three pages, `total` stayed 107 on every page, and the pages were
 * **disjoint** — no row appeared twice. So the loop below walks pages until it
 * has `total` rows, and stops on a page that returns nothing so a service that
 * disagrees with itself cannot spin it forever.
 *
 * ## Never their audio
 *
 * ADR-013 decision 1, and here the payload proves it: `topic_url`,
 * `topic_url_320` and `topic_url_sq` are all the **empty string** on every row.
 * `hash`/`sqhash`/`320hash` are identifiers a separate call would need in order
 * to mint a stream URL, and that call is never made. The only `http` strings
 * anywhere in the response are cover images on `imge.kugou.com`, which are not
 * audio and are not requested here either.
 * `__tests__/externalFetchersAvoidAudio.test.ts` fails if a Kugou tracker host
 * appears anywhere in the app.
 *
 * ## Artist and title arrive glued together
 *
 * There is no artist field: `filename` is `"artist - title"` and nothing else
 * carries the split. `album_name` and `singername` come back `null`, so an
 * album is genuinely unavailable from this endpoint.
 *
 * A failed split leaves the artist **empty**, which is the deliberate
 * degradation ADR-013 asks for: the match score caps at 0.70, under the 0.80
 * auto threshold, so the track goes to **review** rather than to a wrong song.
 */

/** The slug stored on the import. Free-form on the server (ADR-013), so a new
 *  source stays an app-only change. */
export const KUGOU_SERVICE = 'kugou'

/** ⚠️ Not `mobilecdn.kugou.com` — see the note in the module docblock. */
const API = 'https://mobiles.kugou.com/api/v3/special/song'

/** The playlist's own name, which `special/song` does not carry. */
const INFO_API = 'https://mobiles.kugou.com/api/v3/special/info'

/** Kugou rejects a request with no `Referer` from its own site. No cookie:
 *  nothing here needs an account (#534's lesson, measured there). */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://www.kugou.com/',
} as const

/** Rows per request. 300 is honoured; larger was not measured, and this is
 *  already one request for all but the longest playlists. */
const PAGE_SIZE = 300

/** A hard stop, so a service answering nonsense cannot spin this forever. */
const MAX_TRACKS = 5000

/** How Kugou glues the two fields together. Spaced on both sides deliberately:
 *  a hyphen inside a title ("Jay-Z", "re-recorded") has no spaces around it. */
const ARTIST_TITLE = ' - '

type RawSong = {
  hash?: unknown
  audio_id?: unknown
  filename?: unknown
  duration?: unknown
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Split `"artist - title"`.
 *
 * Split on the **first** separator, because a title may contain one of its own
 * — `'BGHY苏刚、泽亦龙 - 恶魔召唤'` is one artist field with a punctuation mark in
 * it, while `'颜人中 - 爱的就是你 (32秒片段)'` has the separator only once. Taking
 * the first occurrence keeps the artist whole and lets the title absorb the
 * rest, which is the right way round: the scorer weights the title far more
 * heavily, and a title with an extra `" - "` in it still matches well.
 *
 * Exported for its own tests — this is the one piece of guessing in the file.
 */
export function splitFilename(filename: string): { artist: string; title: string } {
  const at = filename.indexOf(ARTIST_TITLE)
  // No separator: the whole thing is the title and the artist is empty, which
  // caps the score at 0.70 and sends the track to review. Deliberate — see the
  // module docblock.
  if (at === -1) return { artist: '', title: filename.trim() }

  return {
    artist: filename.slice(0, at).trim(),
    title: filename.slice(at + ARTIST_TITLE.length).trim(),
  }
}

function trackFrom(song: RawSong): ExternalTrack | null {
  const filename = textOf(song.filename)
  // Skipped rather than failed: one unreadable row must not cost the playlist,
  // and the count check is what notices if many of them do.
  if (filename === null) return null

  const { artist, title } = splitFilename(filename)
  if (title === '') return null

  const seconds = typeof song.duration === 'number' && song.duration > 0 ? song.duration : null
  const id = song.hash ?? song.audio_id

  return {
    externalId: id === undefined || id === null ? null : String(id),
    title,
    artist,
    // This endpoint returns `album_name: null` on every row, so there is no
    // album to report. Saying so beats inventing one.
    album: null,
    durationSeconds: seconds,
  }
}

/** One page of the playlist, plus the total it declares. */
async function fetchPage(
  playlistId: string,
  page: number,
): Promise<{ total: number; songs: RawSong[] }> {
  const response = await fetch(
    `${API}?specialid=${encodeURIComponent(playlistId)}&page=${page}&pagesize=${PAGE_SIZE}`,
    { headers: HEADERS },
  )
  if (!response.ok) {
    throw new ExternalSourceRefused(
      `Kugou answered HTTP ${response.status}`,
      `http_${response.status}`,
    )
  }

  const body = (await response.json()) as {
    status?: unknown
    errcode?: unknown
    data?: { total?: unknown; info?: RawSong[] }
  }
  // Kugou reports its real answer in the body, not the status: a private or
  // deleted 歌单 is an HTTP 200 with `status` other than 1. Reading only the
  // status code would turn a refusal into an empty playlist, which is the one
  // thing ADR-013 says must not happen.
  if (body.status !== 1) {
    const code = typeof body.errcode === 'number' ? String(body.errcode) : String(body.status)
    throw new ExternalSourceRefused(`Kugou answered status ${String(body.status)}`, code)
  }

  const data = body.data ?? {}
  return {
    total: typeof data.total === 'number' ? data.total : 0,
    songs: Array.isArray(data.info) ? data.info : [],
  }
}

/**
 * The playlist's name.
 *
 * A second request, because `special/song` returns the songs and nothing about
 * the list they belong to — measured, not assumed. Deliberately **best-effort**:
 * a nameless import is a cosmetic problem and a failed one is not, so a refusal
 * here falls back to the id rather than costing the user their playlist.
 */
async function fetchName(playlistId: string): Promise<string> {
  try {
    const response = await fetch(`${INFO_API}?specialid=${encodeURIComponent(playlistId)}`, {
      headers: HEADERS,
    })
    if (!response.ok) return `Kugou ${playlistId}`

    const body = (await response.json()) as { status?: unknown; data?: { specialname?: unknown } }
    if (body.status !== 1) return `Kugou ${playlistId}`
    return textOf(body.data?.specialname) ?? `Kugou ${playlistId}`
  } catch {
    return `Kugou ${playlistId}`
  }
}

/**
 * Read a whole Kugou playlist into the shape the import pipeline takes.
 *
 * Throws {@link ExternalPlaylistTruncated} rather than importing a short list.
 * Checked against Kugou's declared `total`, which was stable across every page
 * of every playlist measured.
 */
export async function fetchKugouPlaylist(input: string): Promise<ExternalPlaylist> {
  const playlistId = kugouPlaylistId(input)

  const tracks: ExternalTrack[] = []
  let total = 0

  for (let page = 1; tracks.length < MAX_TRACKS; page++) {
    const { total: declared, songs } = await fetchPage(playlistId, page)
    if (page === 1) total = declared

    // Guarded on the page being empty as well as on the total, so a service
    // that disagrees with itself about `total` cannot spin this forever.
    if (songs.length === 0) break

    for (const song of songs) {
      const track = trackFrom(song)
      if (track !== null) tracks.push(track)
    }

    if (tracks.length >= total) break
  }

  logInfo('kugou.playlist', `${tracks.length} track(s), ${total} declared`)

  if (total > 0 && tracks.length < total) {
    throw new ExternalPlaylistTruncated(total, tracks.length)
  }
  if (tracks.length === 0) {
    throw new ExternalSourceRefused('Kugou returned an empty playlist', 'empty')
  }

  return {
    service: KUGOU_SERVICE,
    sourceUrl: canonicalKugouPlaylistUrl(playlistId),
    // Asked for only once the tracks are in hand, so a playlist that was going
    // to fail does not pay for a second request first.
    name: await fetchName(playlistId),
    tracks,
  }
}
