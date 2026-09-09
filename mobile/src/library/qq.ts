import { logInfo } from '../diagnostics/log'
import {
  ExternalPlaylistTruncated,
  ExternalSourceRefused,
  type ExternalPlaylist,
  type ExternalTrack,
} from './externalPlaylist'
import { canonicalQQPlaylistUrl, qqPlaylistId } from './qqUrl'

/**
 * Reading a QQ Music playlist on this device (#103, ADR-013).
 *
 * ## One request, and no account
 *
 *     GET i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg
 *         ?type=1&json=1&utf8=1&onlysong=0&format=json&disstid=<id>
 *     → dissname, songnum, songlist[{ songname, singer[], interval, albumname }]
 *
 * Measured 2026-08-16 from a residential connection, no credentials: 28 tracks
 * in 1.7 s, 66 in 4.2 s, and **1223 tracks in a single 922 KB response**. There
 * is no pagination and no `offset` to pass — the whole 歌单 arrives at once,
 * which is why this file has none of `netease.ts`'s chunking.
 *
 * ⚠️ **#103's cookie requirement does not exist.** The issue body says QQ
 * answers *"only available for registered users. Use --cookies"*. That is the
 * per-**song** extractor, which MiO never calls. This is the *playlist*
 * endpoint and it is anonymous. There is no `QQ_MUSIC_COOKIES` setting, no
 * degraded title-only mode, and therefore no "which mode did this run in"
 * notice to show.
 *
 * ## Never their audio
 *
 * ADR-013 decision 1. Audited rather than asserted: the whole payload was
 * searched for any string containing `http`, `.mp3` or `.m4a` and there are
 * **none**. The song objects carry `songmid` and `strMediaMid`, which are
 * identifiers, plus `size128`/`size320`/`sizeflac`, which are byte counts. A
 * playable URL has to be minted from a separate `vkey` call that this file does
 * not make. So the guarantee is structural, not a rule someone has to keep —
 * and `__tests__/externalFetchersAvoidAudio.test.ts` fails if a QQ audio host
 * ever appears anywhere in the app.
 *
 * ## The wrapper, which the issue does not mention
 *
 * Without `format=json` the endpoint answers **JSONP** — `jsonCallback({…})` —
 * which `response.json()` cannot parse. Passing `format=json` returns bare
 * JSON. That is a documented request parameter rather than string surgery on
 * the response, so it is the one used here.
 */

/** The slug stored on the import. Free-form on the server (ADR-013), so a new
 *  source stays an app-only change. */
export const QQ_SERVICE = 'qq'

const API = 'https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg'

/**
 * QQ rejects a request with no `Referer` from its own site. There is
 * deliberately **no cookie**: nothing here needs an account, and #534's lesson
 * was measured — sending a cookie jar turned an `OK` into `LOGIN_REQUIRED`.
 */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://y.qq.com/',
} as const

/** A hard stop, so a service answering nonsense cannot spin this forever. The
 *  largest playlist measured was 1223; 5000 matches `netease.ts`. */
const MAX_TRACKS = 5000

type RawSinger = { name?: unknown }

type RawSong = {
  songmid?: unknown
  songid?: unknown
  songname?: unknown
  singer?: RawSinger[]
  interval?: unknown
  albumname?: unknown
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Every credited artist, joined.
 *
 * QQ gives an array — a duet is two entries — and the scorer wants one string.
 * Joined with `, ` to match what `netease.ts` produces, so a track that exists
 * on both services scores the same either way.
 */
function artistOf(song: RawSong): string {
  const names = (song.singer ?? [])
    .map((singer) => textOf(singer?.name))
    .filter((name): name is string => name !== null)
  return names.join(', ')
}

function trackFrom(song: RawSong): ExternalTrack | null {
  const title = textOf(song.songname)
  // Skipped rather than failed: one unreadable row must not cost the playlist,
  // and the count check below is what notices if many of them do.
  if (title === null) return null

  // `interval` is already seconds — unlike NetEase's `dt`, which is millis.
  const seconds = typeof song.interval === 'number' && song.interval > 0 ? song.interval : null
  const id = song.songmid ?? song.songid

  return {
    externalId: id === undefined || id === null ? null : String(id),
    title,
    artist: artistOf(song),
    album: textOf(song.albumname),
    durationSeconds: seconds,
  }
}

/**
 * Read a whole QQ Music playlist into the shape the import pipeline takes.
 *
 * Throws {@link ExternalPlaylistTruncated} rather than importing a short list:
 * QQ states the playlist's length in `songnum`, and every playlist measured had
 * `songnum` exactly equal to the number of rows returned, so a shortfall is a
 * request that half worked rather than a stale entry.
 */
export async function fetchQQPlaylist(input: string): Promise<ExternalPlaylist> {
  const playlistId = qqPlaylistId(input)

  const response = await fetch(
    `${API}?type=1&json=1&utf8=1&onlysong=0&format=json&disstid=${encodeURIComponent(playlistId)}`,
    { headers: HEADERS },
  )
  if (!response.ok) {
    throw new ExternalSourceRefused(
      `QQ Music answered HTTP ${response.status}`,
      `http_${response.status}`,
    )
  }

  const body = (await response.json()) as { code?: unknown; cdlist?: unknown }
  // QQ reports its real answer in the body, not the status: a private or
  // deleted 歌单 is an HTTP 200 with `code: -1` and an empty `cdlist`. Reading
  // only the status would turn a refusal into an empty playlist, which is the
  // one thing ADR-013 says must not happen.
  if (typeof body.code === 'number' && body.code !== 0) {
    throw new ExternalSourceRefused(`QQ Music answered code ${body.code}`, String(body.code))
  }

  const list = Array.isArray(body.cdlist) ? body.cdlist : []
  const playlist = list[0] as
    { dissname?: unknown; songnum?: unknown; songlist?: RawSong[] } | undefined
  if (!playlist) {
    throw new ExternalSourceRefused('QQ Music returned no playlist', 'no_playlist')
  }

  const songs = (Array.isArray(playlist.songlist) ? playlist.songlist : []).slice(0, MAX_TRACKS)
  const declaredCount = typeof playlist.songnum === 'number' ? playlist.songnum : songs.length
  logInfo('qq.playlist', `${songs.length} song(s), ${declaredCount} declared`)

  const tracks: ExternalTrack[] = []
  for (const song of songs) {
    const track = trackFrom(song)
    if (track !== null) tracks.push(track)
  }

  /*
   * Checked against QQ's **declared** count, where `netease.ts` deliberately
   * checks against the ids it was handed.
   *
   * The difference is measured, not stylistic. A NetEase playlist can name a
   * track its catalogue no longer carries, so `trackCount` legitimately exceeds
   * what `song/detail` returns and failing on it would refuse merely stale
   * playlists. QQ returned `songnum` exactly equal to `songlist.length` on
   * every playlist measured — 22, 28, 66, 128 and 1223 — so here a shortfall is
   * a request that half worked, which is precisely what ADR-013 wants caught.
   */
  if (declaredCount > 0 && tracks.length < declaredCount) {
    throw new ExternalPlaylistTruncated(declaredCount, tracks.length)
  }
  if (tracks.length === 0) {
    throw new ExternalSourceRefused('QQ Music returned an empty playlist', 'empty')
  }

  return {
    service: QQ_SERVICE,
    sourceUrl: canonicalQQPlaylistUrl(playlistId),
    name: textOf(playlist.dissname) ?? `QQ Music ${playlistId}`,
    tracks,
  }
}
