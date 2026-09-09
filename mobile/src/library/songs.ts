import { File } from 'expo-file-system'

import type { Song } from '../api/types'
import { logInfo, logWarn } from '../diagnostics/log'
import { randomHex } from '../random'
import { openLibraryDb } from './db'
import { removeSongFromAllPlaylists, removeSongsFromAllPlaylists } from './playlists'
import {
  audioFileFor,
  coverFileFor,
  deleteAudio,
  deleteCover,
  ensureLibraryDirectory,
} from './files'

/**
 * Putting a song on the device, and reading it back (#159).
 *
 * I chose a **clean start** (2026-07-30): nothing migrates down from the
 * server. The device library begins empty and fills as things are imported, so
 * this is the only way a song ever gets here.
 *
 * ## The row is written before the audio arrives
 *
 * Metadata first, `file_uri` null, then the download, then the file is recorded.
 * That order is deliberate and is why the column is nullable:
 *
 * - a failed download leaves a **visible, retryable row** rather than nothing —
 *   the user can see the song did not finish, which is the difference between a
 *   bug they can report and one they cannot;
 * - the library can list songs that are known but not yet downloaded, which is
 *   what "adding…" looks like;
 * - and `file_uri` set is then a *fact about the disk*, never a hope.
 *
 * A partial file is cleaned up on failure, so `file_uri IS NOT NULL` never
 * points at half a song.
 */

/**
 * A row as stored: the API `Song`'s fields, plus this device's own identity for
 * it and where the audio ended up.
 *
 * `id` is **local and minted here** (#246), not the server's. The server's id,
 * when the song came from one, is `server_song_id` — an ordinary nullable
 * column. A song this device fetched itself has none, which is the whole point:
 * the server stops being the issuer of identity for the user's library.
 */
export interface LocalSong extends Omit<Song, 'id'> {
  id: string
  server_song_id: number | null
  file_uri: string | null
  file_size: number | null
  /** Where this song's cover art is on this device, or null (#218). Null is an
   *  ordinary state, not a failure — plenty of sources have no artwork. */
  cover_uri: string | null
}

/** 16 bytes is plenty for a per-device key and keeps the filename short. */
const LOCAL_ID_BYTES = 16

export function mintLocalSongId(): string {
  return randomHex(LOCAL_ID_BYTES)
}

/** The local row for a server song, if this device already has it. */
export async function getLocalSongByServerId(serverId: number): Promise<LocalSong | null> {
  const db = await openLibraryDb()
  return db.getFirstAsync<LocalSong>('SELECT * FROM songs WHERE server_song_id = ?', [serverId])
}

/**
 * Record a song that came from the server, returning this device's id for it.
 *
 * Upserts on `server_song_id` rather than on the primary key, because the
 * primary key is now ours and the server's id is what identifies the *same
 * song* across imports. That is what keeps the handover idempotent: importing a
 * track twice updates one row instead of creating a second copy under a fresh
 * local id.
 */
export async function saveSongMetadata(song: Song): Promise<string> {
  const db = await openLibraryDb()
  const existing = await getLocalSongByServerId(song.id)
  const localId = existing?.id ?? mintLocalSongId()

  // *Do not* touch file_uri: re-importing a song whose audio is already here
  // must not forget where it is.
  await db.runAsync(
    `INSERT INTO songs
       (id, server_song_id, title, artist, album, duration, source_url,
        source_platform, added_at, loudness_lufs, peak_dbfs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_song_id) DO UPDATE SET
       title = excluded.title,
       artist = excluded.artist,
       album = excluded.album,
       duration = excluded.duration,
       source_url = excluded.source_url,
       source_platform = excluded.source_platform,
       loudness_lufs = excluded.loudness_lufs,
       peak_dbfs = excluded.peak_dbfs`,
    [
      localId,
      song.id,
      song.title,
      song.artist,
      song.album,
      song.duration,
      song.source_url,
      song.source_platform,
      song.added_at,
      song.loudness_lufs,
      song.peak_dbfs,
    ],
  )

  return localId
}

/**
 * Record a song this device fetched itself (#246).
 *
 * The counterpart to `saveSongMetadata`, and the difference is the whole point:
 * there is no `server_song_id`, because there is no server row. Keyed instead
 * on `source_url`, which is what identifies the same video across imports —
 * without that, adding the same link twice would make two rows and download it
 * twice.
 */
export async function saveDeviceSongMetadata(song: {
  title: string
  artist: string
  duration: number | null
  source_url: string
  source_platform: string
  /** YouTube's own figure (#246). The server measured this with ffmpeg; the
   *  device gets it with the metadata and never has to. */
  loudness_lufs?: number | null
}): Promise<string> {
  const db = await openLibraryDb()
  /*
   * Keyed on `source_url` **and nothing else** (#310).
   *
   * This used to add `AND server_song_id IS NULL`, on the reasoning that a
   * device row and a server row are different things. They are not: they are
   * the same video, and a video the library already holds must not arrive
   * twice. With that clause, a track that came in through the server path
   * earlier got a *second* row on the next device import — the library showing
   * the same song twice, and deleting the duplicate playlist not fixing it,
   * because the rows were real.
   *
   * Since v6 a UNIQUE index enforces it, so this lookup is the fast path rather
   * than the guarantee. That matters: the check-then-insert here is not atomic,
   * and two imports running over the same video could both find nothing.
   */
  const existing = await db.getFirstAsync<LocalSong>('SELECT * FROM songs WHERE source_url = ?', [
    song.source_url,
  ])
  const localId = existing?.id ?? mintLocalSongId()

  await db.runAsync(
    `INSERT INTO songs
       (id, server_song_id, title, artist, album, duration, source_url,
        source_platform, added_at, loudness_lufs, peak_dbfs)
     VALUES (?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       artist = excluded.artist,
       duration = excluded.duration,
       loudness_lufs = excluded.loudness_lufs`,
    [
      localId,
      song.title,
      song.artist,
      song.duration,
      song.source_url,
      song.source_platform,
      // The device's own clock: nothing issued this row but us.
      new Date().toISOString(),
      song.loudness_lufs ?? null,
    ],
  )

  return localId
}

/**
 * Record the loudness of a track that is already here (#308).
 *
 * A targeted `UPDATE` rather than another `saveDeviceSongMetadata`, and the
 * difference matters: that function's UPSERT rewrites title, artist and
 * duration as well, so calling it again after a download replaces whatever the
 * user (or the server's matcher) had with YouTube's own values. That is the
 * same mechanism that silently renames a track when a failed one is retried
 * (#309); there is no reason for the loudness to reach for it.
 */
export async function setSongLoudness(localId: string, loudnessLufs: number | null): Promise<void> {
  if (loudnessLufs === null) return
  const db = await openLibraryDb()
  await db.runAsync('UPDATE songs SET loudness_lufs = ? WHERE id = ?', [loudnessLufs, localId])
}

/**
 * Fetch audio straight from its source onto the device (#246).
 *
 * Distinct from `downloadSongAudio`, which addresses the server's endpoint and
 * needs the install header. This takes any URL and no headers, because the URL
 * YouTube hands out is already the credential.
 *
 * Loudness is not measured here. The server ran `ebur128` at import (G4) and
 * nothing on the device replaces it, so a song fetched this way plays
 * uncorrected until that is answered — an accepted, recorded gap on #246, not
 * an oversight.
 */
/**
 * The ceiling on what to ask for when YouTube does not state a size.
 *
 * Only a fallback: `content_length` is normally present, and the first chunk's
 * `Content-Range` states the total anyway, so this is what bounds the very
 * first request and nothing else.
 */
const MAX_EXPECTED_BYTES = 256 * 1024 * 1024

/**
 * How much of the file one request asks for (#454).
 *
 * ## Why the download is chunked at all
 *
 * The 2026-08-09 device pass ran #442's range probe on two real tracks and both
 * questions came back yes:
 *
 *     12m28s:  fresh=206 contentRange=bytes 6505785-13011570/13011571 second=206
 *     2h54m:   fresh=206 contentRange=bytes 93551853-187103706/187103707 second=206
 *
 * A freshly extracted URL serves a **mid-file range**, and the same URL serves a
 * **second request**. That is measured, on the phone, over the residential
 * connection that actually downloads — the only network whose answer counts
 * (#177). It retires the "one bounded request" shape below, and with it three
 * separate faults at once:
 *
 * 1. **googlevideo closes a long stream early.** Track 46 failed three times at
 *    79.8%, 97.6% and 98.6% of 13,011,571 bytes — the last two with minutes of
 *    budget to spare. No timeout can fix a server hanging up; a ranged request
 *    for the missing 183 KB finishes it in a second.
 * 2. **A long track does not fit in memory.** `arrayBuffer()` holds the whole
 *    body: ~85 MB for an hour, 187 MB for the compilation that was tested.
 *    A chunk bounds it to the size below whatever the track is.
 * 3. **A stall could not be told from a slow connection**, because a single
 *    request reports no progress until it ends. Every chunk that lands is a
 *    progress point, which is what makes {@link chunkTimeoutMs} a *stall*
 *    timeout rather than a total one.
 *
 * ## Why two megabytes
 *
 * Small enough that a chunk still lands inside its budget on the connection
 * I actually measured — 35 kB/s, which moves 2 MiB in about a minute — and
 * large enough that a 13 MB track is seven requests rather than a hundred.
 *
 * ## ⚠️ This was briefly 512 KiB, and the reason was wrong (#649 → #651)
 *
 * A size sweep looked conclusive — `768K:206  1024K:403  2048K:403` — and was
 * read as "googlevideo refuses large ranges". **It is not a size rule.** Those
 * URLs were `ANDROID_VR` ones, which had begun serving only the *first ~1 MiB*
 * and refusing everything after; a 2 MiB request starting at byte 0 **ends**
 * past that cap, which is indistinguishable from a size limit until you move
 * the start. The reading that broke the theory came straight after: a second
 * 512 KiB chunk, starting at 524288 and only 512 KiB long, was refused too.
 *
 * The cap was the cause and the chunk size never was. `VISIONOS` (#651) is not
 * capped and serves a 2 MiB range without complaint, so this returns to the
 * value #454 chose for a reason that still holds. A smaller chunk was never
 * defence against the cap either, because the cap counts **cumulative** bytes
 * per URL, not bytes per request.
 *
 * ⚠️ Both derived bounds read this constant, so they scale by construction:
 * {@link maxRequestsFor} allows four requests per chunk, and
 * {@link chunkTimeoutMs} sizes the per-chunk deadline from it.
 */
export const CHUNK_BYTES = 2 * 1024 * 1024

/**
 * How long a *chunk* may take before the connection is treated as dead (#454,
 * replacing the whole-file budget added after the 2026-08-09 pass).
 *
 * **Nothing on the device's download path had a timeout.** `apiFetch` has had
 * one since it was written — *"a stalled connection must fail rather than hang
 * forever behind a spinner"* — and the paths that replaced the server never got
 * one. Android froze the app mid-download, the sockets died, and the promises
 * **never settled**: the import never advanced, never failed, never finished.
 *
 * The first answer was a total budget, and it was wrong in the way a total
 * budget is always wrong — my objection, which was right: *"what if a track
 * failed because of other reason, and we set 15 minute ceiling, then we would
 * have to wait so long"*. One number cannot tell a slow connection from a dead
 * one, so it is wrong for whichever of the two it was not sized for. Five
 * minutes then cut four healthy downloads off at three quarters.
 *
 * The old docblock named the honest fix and said it was unavailable:
 *
 * > The honest fix would be a **stall** timeout — give up when no bytes arrive
 * > for a while — and that needs download progress, which on this path we
 * > cannot have.
 *
 * Chunking is that progress. Each chunk gets its own budget and every chunk
 * that lands resets it, so a dead socket fails in about a minute *whatever the
 * file size*, and a slow-but-working download is never cut off at all — which
 * is what lets an hour-long track finish.
 */
const DOWNLOAD_SETUP_MS = 20_000

/**
 * 20 kB/s — the floor a chunk is paced at.
 *
 * It was 40 kB/s, described as *"below this the connection is not one a
 * download should be waiting on"*, and the device disagreed: the four tracks
 * that failed on 2026-08-09 were arriving at ~35 kB/s and I wanted them.
 * A rate assumed to be unusable was in fact the rate, so it moves.
 *
 * Halving it is only safe because this now paces a **chunk**. Under the old
 * total budget, a lower floor meant a dead connection held a big file for
 * proportionally longer; against a fixed 2 MiB it is a flat ~2 minutes however
 * long the track is.
 */
const SLOWEST_USEFUL_BYTES_PER_SECOND = 20_000

/** Head-room on a measured rate, since a connection that averaged 35 kB/s will
 *  not hold exactly that. */
const MEASURED_SLACK = 1.4

/**
 * How many consecutive requests may deliver nothing before the download fails.
 *
 * The one case a ranged retry must **not** paper over: a URL that has stopped
 * serving answers 206 with an empty body forever, and a loop that retried it
 * would be exactly the hang #411 removed. A chunk that delivers even one byte
 * is progress and resets this.
 */
const MAX_EMPTY_CHUNKS = 3

/**
 * How many times a mid-file refusal may be answered with a fresh URL.
 *
 * #246 measured a stream URL serving one request and refusing the next
 * (*"403 at byte 1048576"*); #442's probe measured a URL serving two. Both
 * readings are real and they contradict each other, which is the whole reason
 * this exists: rather than betting on either, a refusal *after* bytes have
 * landed asks the caller for a new URL and carries on from the same offset —
 * the case the probe's first question proved works.
 */
const MAX_REFRESHES = 2

/**
 * A hard cap on requests, so the loop provably terminates.
 *
 * Every other bound here is about *time*. This one is about a server that
 * answers quickly and uselessly — dribbling a few hundred bytes per range
 * forever would satisfy both the chunk budget and the empty-chunk guard. Four
 * requests per chunk is generous enough that no honest download approaches it.
 */
function maxRequestsFor(total: number | null): number {
  return Math.ceil((total ?? MAX_EXPECTED_BYTES) / CHUNK_BYTES) * 4 + 8
}

/**
 * A download that ended short of what YouTube promised.
 *
 * Its own type because the *number* it carries is the finding, and since #439
 * the next attempt is sized from it. It survives chunking because chunking does
 * not make every truncation recoverable: it makes them recoverable **while
 * bytes are still arriving**. When they stop, this is still what happened, and
 * the rate it measured is still the useful part.
 */
export class DownloadWasShort extends Error {
  constructor(
    readonly received: number,
    readonly expected: number,
    readonly elapsedMs: number,
  ) {
    super(`Download was short: ${received} of ${expected} bytes`)
    this.name = 'DownloadWasShort'
  }

  /** Bytes per second actually achieved, or null if it is not worth trusting.
   *
   *  A handful of bytes in a moment says nothing about a connection; the floor
   *  is there so a near-instant truncation cannot mint a wide budget. */
  get observedBytesPerSecond(): number | null {
    if (this.elapsedMs < 5_000 || this.received < 512 * 1024) return null
    return this.received / (this.elapsedMs / 1000)
  }
}

/**
 * How long one chunk may take.
 *
 * Sized from the chunk rather than the file, which is the whole change: this
 * number no longer has anything to do with how long the track is.
 *
 * `observedBytesPerSecond` is only ever supplied by a retry after a
 * {@link DownloadWasShort} — that is, after the connection has demonstrated it
 * is alive — and it can only ever *widen* the budget. A connection measured
 * faster than the floor does not get a shorter fuse for being good at its job.
 */
export function chunkTimeoutMs(observedBytesPerSecond?: number | null): number {
  const floor = DOWNLOAD_SETUP_MS + (CHUNK_BYTES / SLOWEST_USEFUL_BYTES_PER_SECOND) * 1000
  if (!observedBytesPerSecond || observedBytesPerSecond <= 0) return floor
  const measured =
    DOWNLOAD_SETUP_MS + (CHUNK_BYTES / observedBytesPerSecond) * 1000 * MEASURED_SLACK
  return Math.max(floor, measured)
}

/** Where the next chunk should come from, when the current URL stops serving. */
export interface AudioSource {
  url: string
  headers: Record<string, string>
  /**
   * What the new source says the file's size is.
   *
   * Checked against the size the download started with, and a mismatch fails
   * the download rather than resuming. A re-extraction can legitimately come
   * back with a *different format* from a different client, and appending its
   * bytes to a half-downloaded one would produce a file that is the right
   * length and unplayable — a corruption no test on this device would catch.
   */
  contentLength: number | null
}

/** The total size, read out of a `Content-Range` like `bytes 0-2097151/13011571`. */
export function totalFromContentRange(header: string | null): number | null {
  const match = /\/\s*(\d+)\s*$/.exec(header ?? '')
  if (!match) return null
  const total = Number(match[1])
  return Number.isFinite(total) && total > 0 ? total : null
}

export interface DownloadOptions {
  /** What YouTube stated, when it stated anything. */
  contentLength?: number | null
  /** Bytes per second a previous attempt actually achieved, from
   *  {@link DownloadWasShort}. Widens each chunk's budget, and only a retry
   *  that watched bytes arrive can supply it. */
  observedBytesPerSecond?: number | null
  /** Asked for a fresh URL when the current one refuses a chunk mid-file.
   *  Omitted, a mid-file refusal simply fails — which is what happened before
   *  chunking existed, so nothing is worse for not passing it. */
  refresh?: () => Promise<AudioSource>
}

/**
 * Fetch a song's audio onto this device, one range at a time.
 *
 * The file is built up on disk with `append`, so the only thing held in JS
 * memory is the chunk in flight. Failure deletes the partial file: a
 * half-written song recorded as present reads as a corrupt library rather than
 * a failed download, and `file_uri` must stay a fact about the disk.
 */
/**
 * What googlevideo actually said when it refused (#647).
 *
 * ## Why this exists
 *
 * The 403 at byte 0 has been seen five times since 2026-08-17 and every report
 * of it carries the same nine words, because that is all this file ever kept:
 * a status and an offset. On 2026-08-20 it was finally pinned down to something
 * *inside the app* — at the same second, on the same phone and the same public
 * address, `curl` fetched the identical video 6/6 while MiO was refused on all
 * four clients across a process restart. Six mechanisms were refuted by
 * measurement (IP family, visitor id, volume, edge host, video popularity,
 * `User-Agent`) and the refusal itself has never been read.
 *
 * So this stops guessing better and makes the failure say more — the #303 rule,
 * where five builds of guessing were beaten by one build that only added a
 * name.
 *
 * ## What it deliberately does not carry
 *
 * Not the video id and not the stream URL (#354, and `scrub()` would replace
 * the URL anyway). The **host** is a fact about Google's edge, not about the
 * track. `ip=` is the *user's own address*, so only its family is recorded —
 * enough to catch a v4/v6 mismatch, useless to anyone else.
 */
async function describeRefusal(response: Response, url: string): Promise<string> {
  const parts: string[] = []
  try {
    // Bare host, no scheme: `scrub()` replaces anything with a `://` in it.
    const parsed = new URL(url)
    parts.push(`host=${parsed.host.replace(/\.googlevideo\.com$/, '')}`)
    const bound = parsed.searchParams.get('ip')
    if (bound) parts.push(`boundTo=${bound.includes(':') ? 'ipv6' : 'ipv4'}`)
    if (parsed.searchParams.get('gcr')) parts.push('gcr=yes')
    const expire = Number(parsed.searchParams.get('expire') ?? 0)
    if (expire) parts.push(`expiresIn=${Math.round(expire - Date.now() / 1000)}s`)
  } catch {
    // A URL we cannot parse is not a reason to lose the status we came for.
  }
  const type = response.headers.get('content-type')
  if (type) parts.push(`type=${type}`)
  try {
    // googlevideo explains itself in the body sometimes, and nobody has looked.
    const body = (await response.text()).trim().replace(/\s+/g, ' ').slice(0, 120)
    if (body) parts.push(`body="${body}"`)
  } catch {
    // Already consumed, or no body. The headers above are still worth having.
  }
  return parts.join(' ')
}

export async function downloadAudioFromUrl(
  localId: string,
  url: string,
  headers: Record<string, string> = {},
  { contentLength, observedBytesPerSecond, refresh }: DownloadOptions = {},
): Promise<File> {
  ensureLibraryDirectory()
  const destination = audioFileFor(localId)

  let source: AudioSource = { url, headers, contentLength: contentLength ?? null }
  /** What we are downloading towards. Learned from `Content-Range` when YouTube
   *  did not state it, which is the only way an unstated size is ever known. */
  let total = contentLength ?? null
  let received = 0
  let emptyChunks = 0
  let refreshes = 0
  let requests = 0
  /** Chunks the server closed early, which chunking then asked for again. */
  let shortChunks = 0
  const startedAt = Date.now()

  try {
    // `received === total` ends it. Everything else in this loop is a bound.
    while (total === null || received < total) {
      if (requests++ >= maxRequestsFor(total)) {
        throw new Error(`Download made no headway: ${received} of ${total ?? '?'} bytes`)
      }

      // The last chunk is short on purpose: asking past the end is answered
      // with 416 by some servers and the remainder by others, and only one of
      // those is a download.
      const stopAt =
        total === null ? received + CHUNK_BYTES : Math.min(received + CHUNK_BYTES, total)
      const end = stopAt - 1
      const requested = stopAt - received

      /*
       * The abort covers the **body**, not just the headers, and that is the
       * case that actually happened: a frozen app's socket answers its headers
       * and then stops, so `arrayBuffer()` is where the wait becomes permanent.
       * One controller across both is what makes the chunk bounded.
       */
      const controller = new AbortController()
      const limit = chunkTimeoutMs(observedBytesPerSecond)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, limit)

      let chunk: Uint8Array
      /** Set when the server ignored the range and answered the whole file. */
      let wholeBody = false
      try {
        const response = await fetch(source.url, {
          headers: { ...source.headers, Range: `bytes=${received}-${end}` },
          signal: controller.signal,
        })

        if (!response.ok) {
          // Read before anything branches, because both branches lose it
          // otherwise — and the recovered case is as informative as the fatal
          // one (#647).
          logWarn(
            'download.refused',
            `status=${response.status} at byte ${received} ${await describeRefusal(response, source.url)}`,
          )
          /*
           * A refusal *after* bytes have landed is the case #442 went and
           * measured: the URL is spent, not the video. A fresh one serves the
           * same range, so the download continues from where it stopped
           * instead of throwing away what it already has.
           */
          if (received > 0 && refresh && refreshes < MAX_REFRESHES) {
            refreshes += 1
            clearTimeout(timer)
            source = await freshSource(refresh, total)
            continue
          }
          // Status and offset, always: the offset is what finally identified
          // this in #246, and it is what separates "the URL is spent" from
          // "the video is refused".
          throw new Error(`Download refused with status ${response.status} at byte ${received}`)
        }

        // The size, when nobody stated one. This is the only way an unstated
        // size is ever learned, and it is why a 200 is a different case below.
        total ??= totalFromContentRange(response.headers.get('Content-Range'))

        /*
         * A 200 means the server ignored `Range` and is sending the whole file
         * from byte 0 — the pre-chunking shape, and the honest fallback when
         * ranges are not on offer. It is only safe as the *first* request:
         * appending a second copy of the file to a partial one would produce a
         * song of plausible length that does not play.
         */
        if (response.status === 200) {
          if (received > 0) {
            throw new Error(`Download restarted from byte 0 with ${received} bytes already written`)
          }
          wholeBody = true
        }

        chunk = new Uint8Array(await response.arrayBuffer())
      } catch (error) {
        // Named, not left as a bare `AbortError`: "the connection stopped" and
        // "the request was cancelled" are the same exception and very different
        // findings, and the next person reading a log deserves the difference.
        if (timedOut) {
          throw new Error(
            `Download timed out after ${Math.round(limit / 1000)}s at byte ${received}`,
          )
        }
        throw error
      } finally {
        clearTimeout(timer)
      }

      if (chunk.byteLength === 0) {
        // A URL that has stopped serving answers 206 with nothing, forever.
        if (++emptyChunks >= MAX_EMPTY_CHUNKS) break
        continue
      }
      emptyChunks = 0
      // Short of the window asked for, with a stated total still to go: the
      // server closed the stream early and the next request picks up the rest.
      // Counted rather than logged here, because a per-chunk line on a 187 MB
      // track is ninety entries saying the same thing.
      if (total != null && chunk.byteLength < requested && received + chunk.byteLength < total) {
        shortChunks += 1
      }

      // `append` from the second chunk on. The first overwrites, so a retry
      // after a failed download never lands on top of the previous corpse.
      destination.write(chunk, { append: received > 0 })
      received += chunk.byteLength

      /*
       * Two ways to reach the end. A 200 was the whole entity, so there is
       * nothing further to ask for — short of the stated size or not, and if it
       * *is* short that is a truncation the check below names. Without a stated
       * size, a 206 answering less than it was asked for has run out of file.
       * With one, the `while` condition ends this instead, because a short 206
       * there is a stream closing early and worth asking about again.
       */
      if (wholeBody || (total === null && chunk.byteLength < requested)) break
    }

    if (received === 0) throw new Error('Download returned no bytes')

    // Short of what YouTube promised means a truncated song that would play and
    // then stop. Better to fail and keep the row retryable — and to carry the
    // numbers, because the next attempt is sized from them.
    if (total != null && received < total) {
      throw new DownloadWasShort(received, total, Date.now() - startedAt)
    }
  } catch (error) {
    // A half-written file recorded as present reads as a corrupt library rather
    // than a failed download.
    deleteAudio(localId)
    throw error
  }

  /*
   * **What chunking actually saved** (#467).
   *
   * The recovery was silent, so a track that finished told you nothing about
   * whether it had needed rescuing — my *"maybe just luck this time"* was
   * unanswerable, and correctly so. `short=` is the number of times googlevideo
   * closed the stream early and a ranged request finished the job; `refreshed=`
   * is the number of times a spent URL was replaced mid-file.
   *
   * Only written when something was recovered. A line saying "nothing went
   * wrong" on every one of 136 tracks is noise that buries the ones that matter,
   * and `append` would de-duplicate it anyway.
   */
  if (shortChunks > 0 || refreshes > 0) {
    logInfo(
      'download.recovered',
      `short=${shortChunks} refreshed=${refreshes} chunks=${requests}` +
        ` of=${total ?? '?'} in ${Math.round((Date.now() - startedAt) / 100) / 10}s`,
    )
  }

  await markDownloaded(localId, destination.uri, destination.size)
  return destination
}

/**
 * A fresh URL for the rest of the file, or a refusal to use it.
 *
 * The size check is the point. Resuming onto a different format is worse than
 * failing: it produces a file of the right length that does not play, and
 * nothing downstream would notice.
 */
async function freshSource(
  refresh: () => Promise<AudioSource>,
  total: number | null,
): Promise<AudioSource> {
  const next = await refresh()
  if (total != null && next.contentLength != null && next.contentLength !== total) {
    throw new Error(
      `Download cannot resume: source changed size from ${total} to ${next.contentLength} bytes`,
    )
  }
  return next
}

/**
 * Copy a file the user picked into the library, and record it (#325).
 *
 * The third way audio arrives, after `downloadAudioFromUrl` (the device fetches
 * it) and `downloadSongAudio` (the server serves it) — and the only one where
 * the bytes were already on the phone. It is a sibling of those two rather than
 * a special case: same order, same cleanup, same `markDownloaded` at the end,
 * so a row's `file_uri` still means exactly what it means everywhere else.
 *
 * **Copied, never moved, and never merely referenced.** Two reasons, and both
 * were decided rather than assumed:
 *
 * - *Referencing* the original would put the library at the mercy of a file the
 *   user can delete, rename, or hold on an SD card they remove — and on Android
 *   a picked `content://` URI is a *grant*, which the system can revoke. A
 *   library that forgets tracks when someone tidies their Downloads folder is
 *   not the local-first library #159 is about.
 * - *Moving* it would delete the user's own file, which nothing here has any
 *   business doing. The cost is disk, which the Settings screen already reports.
 */
export async function copyAudioIntoLibrary(
  localId: string,
  source: File,
  destination: File,
): Promise<File> {
  ensureLibraryDirectory()

  try {
    // Overwriting on purpose: a previous attempt that failed after the copy is
    // a state the user can retry, and refusing here would make it permanent.
    await source.copy(destination, { overwrite: true })
  } catch (error) {
    // The same reasoning as the two downloads: a half-written file recorded as
    // present reads as a corrupt library rather than a failed import.
    deleteAudio(localId, destination.uri)
    throw error
  }

  await markDownloaded(localId, destination.uri, destination.size)
  return destination
}

async function markDownloaded(songId: string, uri: string, size: number | null): Promise<void> {
  const db = await openLibraryDb()
  await db.runAsync('UPDATE songs SET file_uri = ?, file_size = ? WHERE id = ?', [
    uri,
    size,
    songId,
  ])
}

/**
 * Put a song's cover art on the device, if there is one (#218).
 *
 * **Never throws, and never blocks the song.** Everything about this is
 * best-effort by design: artwork is decoration, and a song whose audio arrived
 * but whose thumbnail 404'd is a complete song. Letting a cover failure
 * propagate would mean the caller deletes the audio and marks the import failed
 * over a missing JPEG — turning a cosmetic gap into a lost track.
 *
 * That is also why it is called *after* the audio is recorded rather than
 * alongside it. The song is already usable by the time this runs; if it fails,
 * nothing is rolled back and the row simply keeps `cover_uri` null.
 *
 * Re-running is safe and is how a missing cover is later filled in: a song that
 * already has one is skipped, so this costs one column read on the common path.
 */
/**
 * Crop a saved image to a centred square, or answer null (#335).
 *
 * ## Why the artwork needs this at all
 *
 * Every YouTube thumbnail is **16:9** — measured from the source, 480×270 — and
 * every place artwork is shown is **square**: the row's 48pt tile, the playing
 * panel's `aspectRatio: 1`, and Android's media notification. I reported the
 * lock-screen art as "a square cut in half, theme colour on the left, cropped
 * album image on the right", and confirmed the in-app tile has the same
 * proportions. `expo-audio` does nothing to the bitmap — `BitmapFactory.decodeStream`
 * and straight to the notification — so the shape of this file is the shape
 * Android gets.
 *
 * ## Why it is `require`d here rather than imported at the top
 *
 * `expo-image-manipulator` calls `requireNativeModule` at module scope, which
 * **throws** in a binary built before the package was added — which is every
 * build in existence today. A static import would therefore take the whole app
 * down at launch, from a file every screen reaches.
 *
 * That is #189's lesson through a different door: a native module that is not
 * there must degrade to "the feature is missing", never to "the app does not
 * start". So it is loaded lazily, inside a try, and a failure means the cover is
 * saved exactly as it arrives — which is today's behaviour.
 */
async function croppedToSquare(uri: string): Promise<Uint8Array | null> {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { ImageManipulator, SaveFormat } = require('expo-image-manipulator')
    /* eslint-enable @typescript-eslint/no-require-imports */

    const source = await ImageManipulator.manipulate(uri).renderAsync()
    const side = Math.min(source.width, source.height)
    // Already square — plenty of album art is. Re-encoding it would cost a
    // generation of JPEG quality for no change.
    if (source.width === source.height) return null

    const square = await ImageManipulator.manipulate(source)
      .crop({
        originX: (source.width - side) / 2,
        originY: (source.height - side) / 2,
        width: side,
        height: side,
      })
      .renderAsync()
    const saved = await square.saveAsync({ format: SaveFormat.JPEG, compress: 0.9 })

    const file = new File(saved.uri)
    return file.bytes()
  } catch {
    // No module, an image it cannot decode, anything: keep what we downloaded.
    return null
  }
}

export async function saveCover(
  localId: string,
  url: string | null | undefined,
  headers: Record<string, string> = {},
): Promise<string | null> {
  if (!url) return null

  try {
    const existing = await getLocalSong(localId)
    if (existing?.cover_uri) return existing.cover_uri

    const response = await fetch(url, { headers })
    // A 404 is the *expected* answer for a song the server has no art for, so
    // it is not worth a log line, let alone an error.
    if (!response.ok) return null

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0) return null

    ensureLibraryDirectory()
    const destination = coverFileFor(localId)
    destination.create({ overwrite: true })
    destination.write(bytes)

    // Cropped after it lands, not before: the download is the part that can
    // fail in interesting ways, and a square version of nothing is nothing. If
    // the crop works the file is replaced in place, so every reader — the row,
    // the panel, the lock screen — sees the same `cover_uri` either way.
    const square = await croppedToSquare(destination.uri)
    if (square) destination.write(square)

    const db = await openLibraryDb()
    await db.runAsync('UPDATE songs SET cover_uri = ? WHERE id = ?', [destination.uri, localId])
    return destination.uri
  } catch {
    // Deliberately swallowed. See the note above: no cover is a state the app
    // handles everywhere, and a thrown error here would cost the user a song.
    return null
  }
}

export interface DownloadContext {
  /** Where the server is, e.g. `https://mio.dlany.uk/api`. */
  serverUrl: string
  /** Whatever identifies this install; the audio endpoint 404s without it. */
  headers: Record<string, string>
}

/**
 * Fetch a song's audio onto the device and record where it landed.
 *
 * Returns the local file. Throws if the download fails — the caller decides
 * whether that is worth retrying, and the row survives either way so the failure
 * is visible in the library rather than silent.
 */
export async function downloadSongAudio(
  song: Song,
  context: DownloadContext,
  localId: string,
): Promise<File> {
  ensureLibraryDirectory()
  // Two different ids, and mixing them up is the easy mistake here: the file is
  // named by *this device's* id, the URL is addressed by the *server's*.
  const destination = audioFileFor(localId)

  try {
    await File.downloadFileAsync(`${context.serverUrl}/songs/${song.id}/audio`, destination, {
      headers: context.headers,
      // Re-downloading a song must not fail because a previous attempt left
      // something behind. Overwriting is the recoverable behaviour.
      idempotent: true,
    })
  } catch (error) {
    // A half-written file is worse than none: it would be recorded as present
    // and then fail to play, which reads as a corrupt library rather than a
    // failed download.
    deleteAudio(localId)
    throw error
  }

  await markDownloaded(localId, destination.uri, destination.size)
  return destination
}

/** Everything needed to make a song playable offline, in the right order.
 *
 *  Returns this device's id for the song, which is what everything local keys
 *  on from here. */
export async function saveSongToDevice(song: Song, context: DownloadContext): Promise<string> {
  const localId = await saveSongMetadata(song)
  await downloadSongAudio(song, context, localId)
  /**
   * The cover comes last, and its failure is not the song's (#218).
   *
   * After the audio on purpose: by this line the song is playable and recorded,
   * so nothing this does can cost the user a track. `saveCover` swallows its own
   * errors for the same reason — the server answers 404 for any song it has no
   * art for, which is an ordinary outcome rather than a problem.
   *
   * The install header has to ride along: `/cover` is owned like everything else
   * since #170, which is precisely why the OS could never fetch it itself.
   */
  await saveCover(localId, `${context.serverUrl}/songs/${song.id}/cover`, context.headers)
  return localId
}

/** The device's library, newest first — the same default the server list uses. */
export async function listLocalSongs(): Promise<LocalSong[]> {
  const db = await openLibraryDb()
  return db.getAllAsync<LocalSong>('SELECT * FROM songs ORDER BY added_at DESC, id DESC')
}

/**
 * Which of these sources the device actually holds the audio for (#308).
 *
 * The import record's "imported" and "failed" lists used to come from the
 * server's `TrackMatch.status`, which stopped meaning anything the moment
 * confirm began sending `download: false` (#270): the server accepts matches
 * and downloads nothing, so it never marks a track imported and both lists were
 * always empty however well the import went.
 *
 * The device is the only thing that knows now, and `file_uri` is the whole
 * answer — it is already what `isPlayable` means.
 *
 * One statement rather than one per track: a playlist can be forty long, and
 * forty awaited round-trips to SQLite to draw a list is a stutter.
 */
export async function sourcesWithAudio(sourceUrls: readonly string[]): Promise<Set<string>> {
  if (sourceUrls.length === 0) return new Set()
  const db = await openLibraryDb()
  const placeholders = sourceUrls.map(() => '?').join(', ')
  const rows = await db.getAllAsync<{ source_url: string }>(
    `SELECT source_url FROM songs
     WHERE file_uri IS NOT NULL AND source_url IN (${placeholders})`,
    [...sourceUrls],
  )
  return new Set(rows.map((row) => row.source_url))
}

/**
 * Which of these sources need **no network at all** (#398).
 *
 * Audio *and* artwork, which is a stricter question than `sourcesWithAudio` and
 * a different one from "is it playable". A playlist import walks every accepted
 * track on every run and back-fills a cover for anything imported before #308 —
 * one extraction per track — so a row with audio and no cover is still work, and
 * counting it as done is what makes a retry look stalled.
 *
 * One statement rather than one per track, for the reason above it: a forty-long
 * playlist is forty awaited round-trips to SQLite otherwise.
 */
export async function sourcesFullyOnDevice(sourceUrls: readonly string[]): Promise<Set<string>> {
  if (sourceUrls.length === 0) return new Set()
  const db = await openLibraryDb()
  const placeholders = sourceUrls.map(() => '?').join(', ')
  const rows = await db.getAllAsync<{ source_url: string }>(
    `SELECT source_url FROM songs
     WHERE file_uri IS NOT NULL AND cover_uri IS NOT NULL AND source_url IN (${placeholders})`,
    [...sourceUrls],
  )
  return new Set(rows.map((row) => row.source_url))
}

/**
 * This device's id for each of these sources, where it holds one (#106).
 *
 * **Read-only, and that is the whole reason it exists.**
 * `saveDeviceSongMetadata` would also hand back the id, and it is an UPSERT: it
 * rewrites title, artist and duration from whatever the caller passed. A
 * playlist import that used it to look up a track already in the library would
 * rename that track to the raw video title every time the import was re-run —
 * the same mechanism that quietly renamed a retried track in #309.
 *
 * Missing sources are simply absent from the map, so a caller reads "does this
 * library hold it" and "what is it called here" from one query.
 */
export async function localIdsForSources(
  sourceUrls: readonly string[],
): Promise<Map<string, string>> {
  if (sourceUrls.length === 0) return new Map()
  const db = await openLibraryDb()
  const placeholders = sourceUrls.map(() => '?').join(', ')
  const rows = await db.getAllAsync<{ id: string; source_url: string }>(
    `SELECT id, source_url FROM songs WHERE source_url IN (${placeholders})`,
    [...sourceUrls],
  )
  return new Map(rows.map((row) => [row.source_url, row.id]))
}

export async function getLocalSong(songId: string): Promise<LocalSong | null> {
  const db = await openLibraryDb()
  return db.getFirstAsync<LocalSong>('SELECT * FROM songs WHERE id = ?', [songId])
}

/** Remove a song from the device — the row and the audio together.
 *
 *  The file goes first: a row with no file is a recoverable state the schema
 *  already models, while a file with no row is invisible and unreclaimable. */
/**
 * Undo a row we created for audio that never arrived (#309).
 *
 * *"one song that displays as not downloaded yet is also being added in
 * the library, it shouldn't happen if it's not downloaded."* The library means
 * *music I have*; a row with no file is a promise the library cannot keep.
 *
 * **Guarded on `file_uri` being null**, and the guard is the whole safety of
 * this: a re-import of a track that is already here takes the same failure path
 * when its *cover* or a later step fails, and deleting that row would take away
 * a song the user has had for weeks along with its bytes. Only a row with
 * nothing behind it is removed.
 *
 * Where the user can see the failure instead is the record on the page they
 * added it from — `useDeviceAdds` (#318) for a link or a search, and the
 * import's own "Failed" list for a playlist, which since #308 means exactly
 * "the device does not have this audio".
 */
export async function removeSongIfEmpty(songId: string): Promise<void> {
  const existing = await getLocalSong(songId)
  if (!existing || existing.file_uri) return
  await removeLocalSong(songId)
  /*
   * Said out loud, because the next time this is wrong nobody should have to
   * guess (#309 follow-up).
   *
   * I saw a failed track still in my library after an import, and reading
   * the code cannot distinguish the two candidates: this never ran, or it ran
   * and the list on screen was a stale React Query cache. The project has been
   * wrong twice in a row by diagnosing from reading, so this puts the diagnostic
   * in before the fix rather than after it — a device report either has these
   * lines matching the failures or it does not, and that settles it.
   *
   * The id, never the title or the url (#354).
   */
  logInfo('songs.emptyRowRemoved', songId)
}

/**
 * Rows the last run left mid-download, swept at launch (#369).
 *
 * Every path that fetches audio writes the row first — it is what the download
 * needs an id for — and removes it again if the audio does not arrive. What
 * none of them can do is clean up after being *killed*: Android suspends a
 * backgrounded app's JavaScript and eventually stops the process, and a row
 * written a moment before that survives forever with nothing behind it. I
 * saw the result as songs in the library that would not play.
 *
 * The same argument as `markInterrupted` (#318), and the same moment: there is
 * no point at which the app can write this down, because the process is gone.
 * A row with no file at launch is an interrupted one, and launch is the only
 * place that can be said — nothing is downloading yet, so there is no live row
 * this can take away.
 *
 * Returns how many it removed, which is what makes it testable and what the
 * diagnostics log records.
 */
export async function removeIncompleteSongs(): Promise<number> {
  const db = await openLibraryDb()
  const orphans = await db.getAllAsync<{ id: string }>(
    'SELECT id FROM songs WHERE file_uri IS NULL',
  )
  // One at a time and through `removeLocalSong`, not a bulk DELETE: playlist
  // entries have to go with it or every playlist holding one loses its dense
  // 0-based positions, and the cover is bytes nothing would ever find again.
  for (const orphan of orphans) {
    await removeLocalSong(orphan.id)
  }
  return orphans.length
}

export async function removeLocalSong(songId: string): Promise<void> {
  // Playlist entries go first (#219). A row in `playlist_items` pointing at a
  // song that no longer exists would render as a gap the user cannot remove,
  // and would break the dense-position invariant of every playlist it is in.
  await removeSongFromAllPlaylists(songId)

  // Read the recorded location first: rows migrated from v1 have files named by
  // the old server id, so recomputing the path would miss them and leak the
  // bytes with no row left to find them by.
  const existing = await getLocalSong(songId)
  deleteAudio(songId, existing?.file_uri)
  // The cover goes with the song. "Delete" means gone, the same rule the
  // server's `DELETE /songs/{id}` follows — and an orphaned JPEG is bytes
  // nothing will ever find again, since the row was its only index.
  deleteCover(songId, existing?.cover_uri)
  const db = await openLibraryDb()
  await db.runAsync('DELETE FROM songs WHERE id = ?', [songId])
}

/**
 * Remove several songs in one pass (#569).
 *
 * *"when I select all the tracks, and click delete, they are being
 * deleted one by one"*. He was watching it happen, and the deletes were not
 * what cost the time — `DELETE FROM songs` is one statement whatever the
 * count. It was the work around each one:
 *
 * - `removeSongFromAllPlaylists` renumbers every playlist a song was in, so
 *   forty songs out of one playlist renumbered it forty times;
 * - the caller invalidated the library query per song, so the screen re-read
 *   SQLite and rebuilt the whole list between each one.
 *
 * This does the playlist work once per affected playlist
 * ({@link removeSongsFromAllPlaylists}) and the row deletion in one statement
 * per chunk; the single invalidation is the caller's to do.
 *
 * ## ⚠️ Files go outside the transaction, deliberately
 *
 * A filesystem is not transactional — rolling the database back would not bring
 * a file back — and a file that refuses to delete must **not** cost the user
 * the other forty-nine rows. The row is what the library shows, so an orphaned
 * file is a smaller problem than a row somebody believes is gone. Failures are
 * counted and returned rather than thrown, so a caller can say "48 of 50"
 * instead of claiming a success it did not have.
 */
export async function removeLocalSongs(songIds: readonly string[]): Promise<RemovalReport> {
  if (songIds.length === 0) return { removed: 0, fileFailures: 0 }

  // Playlist entries first, for the same reason the singular form does it: a
  // `playlist_items` row pointing at a song that no longer exists renders as a
  // gap the user cannot remove.
  await removeSongsFromAllPlaylists(songIds)

  const db = await openLibraryDb()
  let fileFailures = 0

  for (const songId of songIds) {
    // The recorded location, read before anything is deleted: rows migrated
    // from v1 name their file by the old server id, so recomputing the path
    // would miss them and leak the bytes with no row left to find them by.
    const existing = await getLocalSong(songId)
    try {
      deleteAudio(songId, existing?.file_uri)
      deleteCover(songId, existing?.cover_uri)
    } catch {
      fileFailures += 1
    }
  }

  let removed = 0
  for (const chunk of chunkedIds(songIds, SQLITE_VARIABLE_LIMIT)) {
    const places = chunk.map(() => '?').join(',')
    const result = await db.runAsync(`DELETE FROM songs WHERE id IN (${places})`, [...chunk])
    removed += result.changes ?? 0
  }

  return { removed, fileFailures }
}

export interface RemovalReport {
  /** Rows actually deleted. Lower than the count asked for when a song had
   *  already gone — not an error, just not a claim worth making. */
  removed: number
  /** Songs whose audio or cover could not be removed. The row went anyway. */
  fileFailures: number
}

/** SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 999; this binds one
 *  parameter per id, and the margin costs nothing. */
const SQLITE_VARIABLE_LIMIT = 900

function* chunkedIds(items: readonly string[], size: number): Generator<string[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}
