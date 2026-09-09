/**
 * Playlist imports and their track matches, on the device (#610).
 *
 * The storage half of moving review-based imports off the server (#608). The
 * *hooks* that read this are #611; this file is only the rows.
 *
 * Mirrors `backend/app/models.py`'s `PlaylistImport` and `TrackMatch` closely
 * enough that `MatchReview.tsx` does not have to learn a new shape — the review
 * screen is 632 lines and none of it is about where the rows live.
 *
 * ## Three server columns are deliberately absent
 *
 * `account_id`, `client_matches` and `owner_install_id`. See the v10 migration
 * in `db.ts` for why each one stops meaning anything on a device.
 *
 * ⚠️ **Statuses are the lower-case *wire* spellings** — `'needs_review'`, not
 * the `NEEDS_REVIEW` the backend's own table holds. That is what mobile has
 * always received and what the review screen compares against.
 */

import { randomHex } from '../random'
import { openLibraryDb, withLibraryTransaction } from './db'
import { createPlaylist } from './playlists'

const ID_BYTES = 16

/** Where a review-based import came from. */
export type ImportService = 'spotify' | 'netease' | 'qq' | 'kugou' | 'youtube'

export type LocalImportStatus =
  'queued' | 'fetching' | 'matching' | 'review' | 'importing' | 'done' | 'failed'

export type LocalTrackMatchStatus =
  | 'pending'
  | 'auto_matched'
  | 'needs_review'
  | 'no_match'
  | 'accepted'
  | 'rejected'
  | 'imported'
  | 'failed'

/** One scored alternative for a track. Stored as JSON on the row. */
export interface LocalMatchCandidate {
  url: string
  title: string
  uploader: string | null
  duration: number | null
  thumbnail?: string | null
  /** Machine score 0..1, or null for a candidate that was never scored — a
   *  YouTube-playlist entry is its own candidate (ADR-010). */
  score: number | null
  /** Which platform produced it (#551), so a mixed list is readable. */
  source?: string
}

export interface LocalPlaylistImport {
  id: string
  service: ImportService
  external_playlist_id: string
  name: string
  status: LocalImportStatus
  track_count: number | null
  matched_count: number
  import_total: number | null
  imported_count: number
  failed_count: number
  error: string | null
  playlist_id: string | null
  created_at: string
  updated_at: string
}

export interface LocalTrackMatch {
  id: string
  playlist_import_id: string
  position: number
  external_id: string | null
  title: string
  artist: string
  album: string | null
  duration_s: number | null
  candidates: LocalMatchCandidate[]
  chosen_url: string | null
  confidence: number | null
  status: LocalTrackMatchStatus
  song_id: string | null
  error: string | null
}

/** One track as the fetcher hands it over, before anything has been searched. */
export interface TrackToMatch {
  external_id?: string | null
  title: string
  artist: string
  album?: string | null
  duration_s?: number | null
}

/** The stored row, before `candidates` is parsed back out of its JSON. */
type TrackMatchRow = Omit<LocalTrackMatch, 'candidates'> & { candidates: string }

function now(): string {
  return new Date().toISOString()
}

/**
 * Parse a stored `candidates` blob.
 *
 * ⚠️ **Tolerant on purpose.** A row whose JSON cannot be read is a row whose
 * *alternatives* are lost, which is a degraded review screen; throwing here
 * would instead make the whole import unopenable and lose the tracks as well.
 * The server's column had a default of `[]` for the same reason.
 */
function parseCandidates(raw: string): LocalMatchCandidate[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as LocalMatchCandidate[]) : []
  } catch {
    return []
  }
}

function hydrate(row: TrackMatchRow): LocalTrackMatch {
  return { ...row, candidates: parseCandidates(row.candidates) }
}

export async function createImport(input: {
  service: ImportService
  externalPlaylistId: string
  name: string
  trackCount?: number | null
}): Promise<string> {
  const db = await openLibraryDb()
  const id = randomHex(ID_BYTES)
  const timestamp = now()
  await db.runAsync(
    `INSERT INTO playlist_imports
       (id, service, external_playlist_id, name, status, track_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
    [
      id,
      input.service,
      input.externalPlaylistId,
      input.name,
      input.trackCount ?? null,
      timestamp,
      timestamp,
    ],
  )
  return id
}

export async function getImport(importId: string): Promise<LocalPlaylistImport | null> {
  const db = await openLibraryDb()
  return db.getFirstAsync<LocalPlaylistImport>(`SELECT * FROM playlist_imports WHERE id = ?`, [
    importId,
  ])
}

/** Newest first, which is the order the imports list has always shown. */
export async function listImports(): Promise<LocalPlaylistImport[]> {
  const db = await openLibraryDb()
  return db.getAllAsync<LocalPlaylistImport>(
    `SELECT * FROM playlist_imports ORDER BY created_at DESC`,
  )
}

/**
 * Patch an import row. Every caller sets `updated_at`, so it is set here rather
 * than by each of them — the server's `onupdate` did the same job.
 */
export async function updateImport(
  importId: string,
  patch: Partial<
    Pick<
      LocalPlaylistImport,
      | 'status'
      | 'name'
      | 'track_count'
      | 'matched_count'
      | 'import_total'
      | 'imported_count'
      | 'failed_count'
      | 'error'
      | 'playlist_id'
    >
  >,
): Promise<void> {
  const columns = Object.keys(patch) as (keyof typeof patch)[]
  if (columns.length === 0) return
  const db = await openLibraryDb()
  const assignments = columns.map((column) => `${column} = ?`).join(', ')
  await db.runAsync(`UPDATE playlist_imports SET ${assignments}, updated_at = ? WHERE id = ?`, [
    ...columns.map((column) => patch[column] ?? null),
    now(),
    importId,
  ])
}

/**
 * Write the fetched tracklist as `pending` matches.
 *
 * ⚠️ **`track_count` is set from what was actually stored**, never from what
 * the fetcher claimed. #585 was exactly this: `list_playlist` dropped entries it
 * could not read and recorded the survivors as the playlist's size, so an
 * eighteen-track import reported "4/4 done". The count and the playlist are
 * different facts, and only one of them is a row you can point at.
 *
 * One transaction: a half-written tracklist would resume as a silently short
 * import.
 */
export async function addTracks(
  importId: string,
  tracks: readonly TrackToMatch[],
): Promise<number> {
  const timestamp = now()
  const db = await openLibraryDb()
  await withLibraryTransaction(db, async () => {
    for (const [position, track] of tracks.entries()) {
      await db.runAsync(
        `INSERT INTO track_matches
           (id, playlist_import_id, position, external_id, title, artist, album, duration_s,
            candidates, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 'pending')`,
        [
          randomHex(ID_BYTES),
          importId,
          position,
          track.external_id ?? null,
          track.title,
          track.artist,
          track.album ?? null,
          track.duration_s ?? null,
        ],
      )
    }
    await db.runAsync(
      `UPDATE playlist_imports
         SET track_count = (SELECT COUNT(*) FROM track_matches WHERE playlist_import_id = ?),
             updated_at = ?
       WHERE id = ?`,
      [importId, timestamp, importId],
    )
  })
  return tracks.length
}

export async function listMatches(
  importId: string,
  status?: LocalTrackMatchStatus,
): Promise<LocalTrackMatch[]> {
  const db = await openLibraryDb()
  const rows = status
    ? await db.getAllAsync<TrackMatchRow>(
        `SELECT * FROM track_matches WHERE playlist_import_id = ? AND status = ?
         ORDER BY position`,
        [importId, status],
      )
    : await db.getAllAsync<TrackMatchRow>(
        `SELECT * FROM track_matches WHERE playlist_import_id = ? ORDER BY position`,
        [importId],
      )
  return rows.map(hydrate)
}

export async function getMatch(matchId: string): Promise<LocalTrackMatch | null> {
  const db = await openLibraryDb()
  const row = await db.getFirstAsync<TrackMatchRow>(`SELECT * FROM track_matches WHERE id = ?`, [
    matchId,
  ])
  return row ? hydrate(row) : null
}

/** How many matches an import has in each status, for the progress counters. */
export async function countMatchesByStatus(importId: string): Promise<Record<string, number>> {
  const db = await openLibraryDb()
  const rows = await db.getAllAsync<{ status: string; total: number }>(
    `SELECT status, COUNT(*) AS total FROM track_matches
     WHERE playlist_import_id = ? GROUP BY status`,
    [importId],
  )
  return Object.fromEntries(rows.map((row) => [row.status, row.total]))
}

/** Record what a search found for one track, and what the scorer made of it. */
export async function setMatchCandidates(
  matchId: string,
  candidates: readonly LocalMatchCandidate[],
  status: LocalTrackMatchStatus,
): Promise<void> {
  const db = await openLibraryDb()
  const best = candidates.length > 0 ? candidates[0] : null
  await db.runAsync(
    `UPDATE track_matches SET candidates = ?, chosen_url = ?, confidence = ?, status = ?
     WHERE id = ?`,
    [
      JSON.stringify(candidates),
      // Only a match good enough to stand on its own is pre-chosen; the rest
      // are offered to the human, which is what `review` means.
      status === 'auto_matched' && best ? best.url : null,
      status === 'auto_matched' && best ? best.score : null,
      status,
      matchId,
    ],
  )
}

/**
 * The human's answer for one track.
 *
 * ⚠️ **`confidence` is derived here, not passed in.** It means *machine*
 * confidence, so it can only ever be the score of a candidate the scorer
 * actually produced: this looks the chosen URL up among the stored candidates
 * and stores that candidate's score, or `null` when the URL is not one of them
 * — which is exactly the hand-pasted case.
 *
 * Taking it as an argument, as the first version of this did, made the rule the
 * *caller's* to keep and left nothing able to fail when it stopped keeping it.
 * A guarantee beats a prohibition.
 */
export async function chooseMatch(matchId: string, chosenUrl: string | null): Promise<void> {
  const db = await openLibraryDb()
  if (chosenUrl === null) {
    await db.runAsync(
      `UPDATE track_matches SET chosen_url = NULL, confidence = NULL, status = 'rejected'
       WHERE id = ?`,
      [matchId],
    )
    return
  }
  const existing = await getMatch(matchId)
  const chosen = existing?.candidates.find((candidate) => candidate.url === chosenUrl)
  await db.runAsync(
    `UPDATE track_matches SET chosen_url = ?, confidence = ?, status = 'accepted' WHERE id = ?`,
    [chosenUrl, chosen?.score ?? null, matchId],
  )
}

export async function setMatchStatus(
  matchId: string,
  status: LocalTrackMatchStatus,
  patch: { song_id?: string | null; error?: string | null } = {},
): Promise<void> {
  const db = await openLibraryDb()
  await db.runAsync(`UPDATE track_matches SET status = ?, song_id = ?, error = ? WHERE id = ?`, [
    status,
    patch.song_id ?? null,
    patch.error ?? null,
    matchId,
  ])
}

/**
 * Delete an import and its matches.
 *
 * No `ON DELETE CASCADE`: SQLite honours foreign keys only when
 * `PRAGMA foreign_keys` is on, which is off by default and per-connection, so a
 * declared cascade that silently does nothing is worse than deleting by hand.
 * `playlists.ts` reached the same conclusion for the same reason.
 */
export async function deleteImport(importId: string): Promise<void> {
  const db = await openLibraryDb()
  await withLibraryTransaction(db, async () => {
    await db.runAsync(`DELETE FROM track_matches WHERE playlist_import_id = ?`, [importId])
    await db.runAsync(`DELETE FROM playlist_imports WHERE id = ?`, [importId])
  })
}

/** One page of matches, shaped like the server's `Page<T>` so the review
 *  screen's infinite query does not have to change (#611). */
export interface MatchPage {
  items: LocalTrackMatch[]
  total: number
  limit: number
  offset: number
}

/**
 * A page of matches, optionally filtered.
 *
 * SQLite could return all of them at once and the screen would work — but the
 * review list is an infinite query over a playlist that can be two hundred
 * tracks, and `MatchReview.tsx` is built around paging. Keeping the shape keeps
 * that file untouched, which is the whole test of whether this port drifted.
 */
export async function pageMatches(
  importId: string,
  status: LocalTrackMatchStatus | 'all',
  limit: number,
  offset: number,
): Promise<MatchPage> {
  const db = await openLibraryDb()
  const filtered = status !== 'all'
  const where = `WHERE playlist_import_id = ?${filtered ? ' AND status = ?' : ''}`
  const params = filtered ? [importId, status] : [importId]

  const counted = await db.getFirstAsync<{ total: number }>(
    `SELECT COUNT(*) AS total FROM track_matches ${where}`,
    params,
  )
  const rows = await db.getAllAsync<TrackMatchRow>(
    `SELECT * FROM track_matches ${where} ORDER BY position LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )
  return { items: rows.map(hydrate), total: counted?.total ?? 0, limit, offset }
}

/** How many tracks confirming would actually download: the matcher was
 *  confident and the user left it alone, or the user said yes. */
export async function importableCount(importId: string): Promise<number> {
  const counts = await countMatchesByStatus(importId)
  return (counts.auto_matched ?? 0) + (counts.accepted ?? 0)
}

/** Set the same status on several matches at once — the only way a hundred-track
 *  playlist is reviewable on a phone at all. */
export async function setMatchStatuses(
  matchIds: readonly string[],
  status: LocalTrackMatchStatus,
): Promise<void> {
  if (matchIds.length === 0) return
  const db = await openLibraryDb()
  await withLibraryTransaction(db, async () => {
    for (const matchId of matchIds) {
      await db.runAsync(`UPDATE track_matches SET status = ? WHERE id = ?`, [status, matchId])
    }
  })
}

/**
 * Put failed tracks back in the queue (#223).
 *
 * Only the ones recorded as failed — the successful tracks keep their songs, so
 * this is not a second import of the whole playlist. Their error is cleared
 * with them, or the row would carry a reason for a failure that is no longer
 * true.
 */
export async function retryFailedMatches(importId: string): Promise<number> {
  const db = await openLibraryDb()
  const failed = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM track_matches WHERE playlist_import_id = ? AND status = 'failed'`,
    [importId],
  )
  await db.runAsync(
    `UPDATE track_matches SET status = 'accepted', error = NULL
     WHERE playlist_import_id = ? AND status = 'failed'`,
    [importId],
  )
  await updateImport(importId, { status: 'importing', failed_count: 0 })
  return failed.length
}

/**
 * The import that already exists for this playlist, if there is one.
 *
 * What makes re-importing a living playlist fill in the one already here rather
 * than build a second beside it — the same argument the `google_playlist_id`,
 * `bilibili_fav_id` and `bilibili_video_id` columns make for playlists (v7–v9).
 */
export async function findImport(
  service: ImportService,
  externalPlaylistId: string,
): Promise<LocalPlaylistImport | null> {
  const db = await openLibraryDb()
  return db.getFirstAsync<LocalPlaylistImport>(
    `SELECT * FROM playlist_imports WHERE service = ? AND external_playlist_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    [service, externalPlaylistId],
  )
}

/**
 * The local playlist this import fills, creating it on first use.
 *
 * Replaces `playlistForServerImport`, which keyed a playlist to the **server's
 * integer** import id via `playlists.server_import_id` — a column local imports
 * cannot use, because their ids are TEXT (#610).
 *
 * ⚠️ **This needs no new column on `playlists`.** v10 already carries
 * `playlist_imports.playlist_id`, so the link exists in the other direction,
 * and re-importing a living playlist reuses the row that `findImport` turns up
 * rather than building a second one beside it — the same argument v7–v9 make
 * with `google_playlist_id`, `bilibili_fav_id` and `bilibili_video_id`.
 */
export async function playlistForImport(importId: string, name: string): Promise<string> {
  const existing = await getImport(importId)
  if (existing?.playlist_id) {
    const db = await openLibraryDb()
    const playlist = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM playlists WHERE id = ?`,
      [existing.playlist_id],
    )
    // A playlist the user deleted by hand leaves a dangling id. Making a fresh
    // one is the only sane answer; refusing to import would punish them for
    // tidying up.
    if (playlist) return playlist.id
  }
  const playlistId = await createPlaylist(name)
  await updateImport(importId, { playlist_id: playlistId })
  return playlistId
}
