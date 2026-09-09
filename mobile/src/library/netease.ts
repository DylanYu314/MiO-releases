/**
 * Reading a NetEase Cloud Music playlist on the device (#102, ADR-013).
 *
 * ## Two requests, and neither one asks for audio
 *
 * ADR-013 decision 1 is implemented here rather than promised. #102's design was
 * yt-dlp's `netease:song` extractor, once per track — and that costs **6.3 s a
 * track** (ten minutes for a 95-track playlist) *and* is the only thing that
 * produces a `music.126.net` mp3 URL, which is precisely what the issue's own
 * rule forbids touching. The two endpoints below return the same title, artist,
 * duration and album with **no audio URL anywhere in the payload**.
 *
 * Measured 2026-08-16 from a residential connection, no credentials:
 *
 *     GET  /api/v6/playlist/detail?id=…&n=…   832 trackIds in 2.2 s
 *     POST /api/v3/song/detail  c=[{id},…]    832 songs in 7.0 s (one call)
 *
 * `playlist/detail` returns every id but only the first ten tracks in full,
 * which is why the second call exists. `n` caps `tracks`, not `trackIds` — a
 * 832-track playlist returned all 832 ids at both `n=1000` and `n=5000`.
 *
 * ## What it deliberately does not do
 *
 * No pacing (`app/pacing.py`, which #102 asks for) and no retries: this is two
 * requests for a whole playlist, not one per track, so there is no burst to
 * pace and a failure is a thing to report rather than to grind at. The pacing
 * that matters is in the *searching* that follows, which `deviceMatching.ts`
 * already does one batch at a time.
 */

import { logInfo } from '../diagnostics/log'
import {
  ExternalPlaylistTruncated,
  ExternalSourceRefused,
  type ExternalPlaylist,
  type ExternalTrack,
} from './externalPlaylist'
import { canonicalPlaylistUrl, isNeteaseShortLink, neteasePlaylistId } from './neteaseUrl'

export const NETEASE_SERVICE = 'netease'

const API = 'https://music.163.com'

/**
 * NetEase answers 200 to a request with no `Referer` and rejects some without
 * one, so both are sent. There is deliberately **no cookie**: nothing here needs
 * an account, and #534's lesson was measured — a visitor id alone answered `OK`
 * where the same request plus a cookie jar answered `LOGIN_REQUIRED`.
 */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://music.163.com/',
} as const

/**
 * How many ids to ask about per `song/detail` call.
 *
 * 832 in one call was measured working, so this is not a limit the service
 * imposes — it is a limit on how much a phone holds and re-sends. 200 ids came
 * back in ~420 KB and 3.6 s; chunking there keeps a dropped request cheap to
 * repeat and gives the progress line something to move.
 */
const DETAIL_CHUNK = 200

/** A hard stop, so a service answering nonsense cannot spin this forever. */
const MAX_TRACKS = 5000

type RawSong = {
  id?: unknown
  name?: unknown
  ar?: { name?: unknown }[]
  dt?: unknown
  al?: { name?: unknown }
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * NetEase's `ar` is every credited artist. Joined with `, ` because that is what
 * `build_search_query` in `matching.py` splits on — it searches with the primary
 * artist only, so the order matters and the separator has to be the one the
 * server expects.
 */
function artistOf(song: RawSong): string {
  return (song.ar ?? [])
    .map((artist) => textOf(artist?.name))
    .filter((name): name is string => name !== null)
    .join(', ')
}

function trackFrom(song: RawSong): ExternalTrack | null {
  const title = textOf(song.name)
  if (title === null) return null

  // `dt` is milliseconds here, and `duration_s` downstream is seconds. A wrong
  // unit would not fail — it would quietly score every candidate's duration at
  // zero credit, which reads as "the matcher got worse".
  const durationMs = typeof song.dt === 'number' && song.dt > 0 ? song.dt : null

  return {
    externalId: song.id === undefined || song.id === null ? null : String(song.id),
    title,
    artist: artistOf(song),
    album: textOf(song.al?.name),
    durationSeconds: durationMs === null ? null : durationMs / 1000,
  }
}

async function getJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, headers: { ...HEADERS, ...init?.headers } })
  if (!response.ok) {
    throw new ExternalSourceRefused(
      `NetEase answered HTTP ${response.status}`,
      `http_${response.status}`,
    )
  }

  const body = (await response.json()) as { code?: unknown } & Record<string, unknown>
  // NetEase reports its real answer in the body, not the status: a private or
  // deleted playlist is an HTTP 200 with a non-200 `code`. Reading only the
  // status would turn a refusal into an empty playlist, which is the one thing
  // ADR-013 says must not happen.
  if (typeof body.code === 'number' && body.code !== 200) {
    throw new ExternalSourceRefused(`NetEase answered code ${body.code}`, String(body.code))
  }
  return body
}

/**
 * Follow a `163cn.tv` share link to the playlist it points at.
 *
 * `fetch` follows the redirect; what this reads is where it landed.
 * `response.url` is the only thing carrying that, and — exactly as in
 * `resolveShortLink` for Bilibili — it is the part that cannot be verified off
 * a device, so the failure says what it actually was rather than degrading into
 * "not a NetEase link".
 */
export async function resolveShortLink(url: string): Promise<string> {
  const response = await fetch(url.trim(), { headers: HEADERS })
  const landed = response.url
  if (!landed || landed === url.trim()) {
    throw new ExternalSourceRefused(`Short link did not resolve: ${url}`, 'short_link')
  }
  return landed
}

/** Every track id in the playlist, plus its name and declared length. */
async function fetchTrackIds(
  playlistId: string,
): Promise<{ name: string; declaredCount: number; ids: number[] }> {
  const body = await getJson(
    `${API}/api/v6/playlist/detail?id=${encodeURIComponent(playlistId)}&n=${MAX_TRACKS}`,
  )
  const playlist = body.playlist as
    { name?: unknown; trackCount?: unknown; trackIds?: { id?: unknown }[] } | undefined

  if (!playlist) {
    throw new ExternalSourceRefused('NetEase returned no playlist', 'no_playlist')
  }

  const ids = (playlist.trackIds ?? [])
    .map((entry) => entry?.id)
    .filter((id): id is number => typeof id === 'number')

  return {
    name: textOf(playlist.name) ?? `NetEase ${playlistId}`,
    declaredCount: typeof playlist.trackCount === 'number' ? playlist.trackCount : ids.length,
    ids,
  }
}

/** Title, artist, duration and album for a batch of ids. */
async function fetchSongDetails(ids: number[]): Promise<RawSong[]> {
  const body = await getJson(`${API}/api/v3/song/detail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `c=${encodeURIComponent(JSON.stringify(ids.map((id) => ({ id }))))}`,
  })
  return Array.isArray(body.songs) ? (body.songs as RawSong[]) : []
}

/**
 * Read a whole NetEase playlist into the shape the import pipeline takes.
 *
 * Throws {@link ExternalPlaylistTruncated} rather than importing a short list.
 * The count is checked against what the *ids* call promised, not against
 * `trackCount`: a NetEase playlist can name a track its catalogue no longer
 * carries, and `song/detail` then returns fewer songs than ids. Failing on the
 * declared count would refuse playlists that are simply a bit stale, while
 * failing on the ids catches the case that matters — a request that half worked.
 */
export async function fetchNeteasePlaylist(input: string): Promise<ExternalPlaylist> {
  const link = isNeteaseShortLink(input) ? await resolveShortLink(input) : input
  const playlistId = neteasePlaylistId(link)

  const { name, declaredCount, ids } = await fetchTrackIds(playlistId)
  logInfo('netease.playlist', `${ids.length} id(s), ${declaredCount} declared`)

  const tracks: ExternalTrack[] = []
  for (let offset = 0; offset < ids.length; offset += DETAIL_CHUNK) {
    const songs = await fetchSongDetails(ids.slice(offset, offset + DETAIL_CHUNK))
    for (const song of songs) {
      const track = trackFrom(song)
      if (track !== null) tracks.push(track)
    }
  }

  if (ids.length > 0 && tracks.length < ids.length) {
    throw new ExternalPlaylistTruncated(ids.length, tracks.length)
  }
  if (tracks.length === 0) {
    throw new ExternalSourceRefused('NetEase returned an empty playlist', 'empty')
  }

  return {
    service: NETEASE_SERVICE,
    sourceUrl: canonicalPlaylistUrl(playlistId),
    name,
    tracks,
  }
}
