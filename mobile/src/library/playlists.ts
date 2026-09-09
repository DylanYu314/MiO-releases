import { randomHex } from '../random'
import { openLibraryDb, withLibraryTransaction } from './db'
import type { LocalSong } from './songs'

/**
 * Playlists and favourites, on the device (#219).
 *
 * The last thing the server still owned about the library. Since #216 the songs
 * are local, so a favourite was a *server* row pointing at a song id the server
 * may never have heard of — and a device-fetched song could not be favourited
 * or added to a playlist at all.
 *
 * ## The invariants, and who enforces them now
 *
 * The backend enforced these; the schema does it here, which is stronger:
 *
 * - **Positions are dense and 0-based.** Removing renumbers.
 * - **Favourites is a playlist with `kind = 'favourites'`**, created by the
 *   migration, and it cannot be renamed or deleted.
 * - **A song appears at most once in a playlist**, which is a UNIQUE index
 *   rather than a check anybody has to remember.
 */

const ID_BYTES = 16
/**
 * The `kind` of the one playlist the library maintains itself.
 *
 * Exported since #324. There used to be a second copy of this string —
 * `FAVOURITES_KIND` in `src/api/playlists.ts` — documented as "the backend's
 * kind", and the two playlist screens imported *that* one to compare against
 * rows read from **this** device. It happened to work because the values
 * matched; it described a server the library stopped using at #159.
 */
export const FAVOURITES = 'favourites'

export interface LocalPlaylist {
  id: string
  name: string
  kind: string
  /** Set when a server playlist import produced this one (#225); null for a
   *  playlist made on the device. */
  server_playlist_id?: number | null
  created_at: string
  updated_at: string
  item_count: number
}

export interface LocalPlaylistItem {
  id: string
  position: number
  song: LocalSong
}

/** Refused because the backend refuses it too: favourites is not a user
 *  playlist and renaming or deleting it would leave the app with none. */
export class FavouritesIsProtected extends Error {
  constructor(action: string) {
    super(`Favourites cannot be ${action}`)
    this.name = 'FavouritesIsProtected'
  }
}

function now(): string {
  return new Date().toISOString()
}

export async function listPlaylists(): Promise<LocalPlaylist[]> {
  const db = await openLibraryDb()
  return db.getAllAsync<LocalPlaylist>(
    `SELECT p.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS item_count
     FROM playlists p
     -- Favourites first, then newest. The server sorted by name; pinning
     -- favourites is what the screen actually wants and saves it re-sorting.
     ORDER BY (p.kind = 'favourites') DESC, p.created_at DESC`,
  )
}

export async function getPlaylist(playlistId: string): Promise<LocalPlaylist | null> {
  const db = await openLibraryDb()
  return db.getFirstAsync<LocalPlaylist>(
    `SELECT p.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS item_count
     FROM playlists p WHERE p.id = ?`,
    [playlistId],
  )
}

/** The favourites playlist. Created by the migration, so this never has to
 *  decide whether it exists — the reason the backend seeds it too. */
export async function favouritesPlaylist(): Promise<LocalPlaylist> {
  const db = await openLibraryDb()
  const row = await db.getFirstAsync<LocalPlaylist>(
    `SELECT p.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS item_count
     FROM playlists p WHERE p.kind = ?`,
    [FAVOURITES],
  )
  if (!row) throw new Error('The favourites playlist is missing')
  return row
}

export async function createPlaylist(name: string): Promise<string> {
  const db = await openLibraryDb()
  const id = randomHex(ID_BYTES)
  const timestamp = now()
  await db.runAsync(
    `INSERT INTO playlists (id, name, kind, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)`,
    [id, name.trim(), timestamp, timestamp],
  )
  return id
}

/**
 * The local playlist for a playlist **import**, created once.
 *
 * Keyed so that reopening a finished import does not build a second copy — the
 * same job `songs.server_song_id` does, and the reason that column exists.
 *
 * ## Its own column, because an import id is not a playlist id (#308)
 *
 * This used to write the import's id into `playlists.server_playlist_id`, the
 * column the *handover* fills with a server **playlist** id. One UNIQUE column,
 * two unrelated numbering schemes: import #7 and server playlist #7 collided
 * onto one row. v6 adds `server_import_id` and this writes there.
 *
 * Rows written before v6 are left where they are — nothing records which kind
 * of id a value was, so they cannot be sorted out afterwards. An import that
 * already built a playlist may therefore build one more, once.
 */
export async function playlistForServerImport(importId: number, name: string): Promise<string> {
  const db = await openLibraryDb()
  const existing = await db.getFirstAsync<{ id: string }>(
    'SELECT id FROM playlists WHERE server_import_id = ?',
    [importId],
  )
  if (existing) return existing.id

  const id = randomHex(ID_BYTES)
  const timestamp = now()
  await db.runAsync(
    `INSERT INTO playlists (id, name, kind, created_at, updated_at, server_import_id)
     VALUES (?, ?, 'user', ?, ?, ?)`,
    [id, name.trim(), timestamp, timestamp, importId],
  )
  return id
}

/**
 * The local playlist for one **Google** playlist, created once (#106).
 *
 * The same job `playlistForServerImport` does, keyed on YouTube's own id — and
 * its own column, for the reason v6 exists: a Google playlist id is a string
 * YouTube issued, and the two `server_*` columns hold integers this project's
 * server issued. Sharing a UNIQUE column between two numbering schemes is the
 * fault v6 had to rebuild a table to undo.
 *
 * **Re-importing is the point.** A private playlist is a living list, so
 * running the import again to pick up what has been added since is ordinary
 * use — and it must fill in the playlist already on the phone rather than
 * leave two named the same. The name is *not* rewritten here: renaming the
 * local copy is the user's to do, and a re-import is not a request to undo it.
 */
export async function playlistForGooglePlaylist(
  googlePlaylistId: string,
  name: string,
): Promise<string> {
  const db = await openLibraryDb()
  const existing = await db.getFirstAsync<{ id: string }>(
    'SELECT id FROM playlists WHERE google_playlist_id = ?',
    [googlePlaylistId],
  )
  if (existing) return existing.id

  const id = randomHex(ID_BYTES)
  const timestamp = now()
  await db.runAsync(
    `INSERT INTO playlists (id, name, kind, created_at, updated_at, google_playlist_id)
     VALUES (?, ?, 'user', ?, ?, ?)`,
    [id, name.trim(), timestamp, timestamp, googlePlaylistId],
  )
  return id
}

/**
 * The local playlist for a Bilibili favourites folder, made if it is not here.
 *
 * `playlistForGooglePlaylist`'s twin (v8, #492), and everything in that one's
 * docblock applies: its own column rather than a shared one, because a
 * `media_id` is a number Bilibili issued and the `server_*` columns hold
 * integers this project's server issued — sharing a UNIQUE column between two
 * numbering schemes is the fault v6 had to rebuild a table to undo.
 *
 * **Re-importing is the point.** A favourites folder is a living list, so
 * running the import again to pick up what has been added since is ordinary
 * use, and it must fill in the playlist already on the phone rather than leave
 * two named the same. The name is *not* rewritten: renaming the local copy is
 * the user's to do, and a re-import is not a request to undo it.
 */
export async function playlistForBilibiliFav(mediaId: string, name: string): Promise<string> {
  const db = await openLibraryDb()
  const existing = await db.getFirstAsync<{ id: string }>(
    'SELECT id FROM playlists WHERE bilibili_fav_id = ?',
    [mediaId],
  )
  if (existing) return existing.id

  const id = randomHex(ID_BYTES)
  const timestamp = now()
  await db.runAsync(
    `INSERT INTO playlists (id, name, kind, created_at, updated_at, bilibili_fav_id)
     VALUES (?, ?, 'user', ?, ?, ?)`,
    [id, name.trim(), timestamp, timestamp, mediaId],
  )
  return id
}

/**
 * The playlist a multi-part Bilibili video imports into (#575, schema v9).
 *
 * Find-or-create on `bilibili_video_id`, for the reason v7, v8 and this all
 * share: importing four parts today and the other twenty-nine next week must
 * fill in the same playlist rather than build a second one beside it.
 *
 * Keyed on the `bvid` rather than the name, because an uploader can rename a
 * video and a name match would then quietly start a new playlist.
 */
export async function playlistForBilibiliVideo(bvid: string, name: string): Promise<string> {
  const db = await openLibraryDb()
  const existing = await db.getFirstAsync<{ id: string }>(
    'SELECT id FROM playlists WHERE bilibili_video_id = ?',
    [bvid],
  )
  if (existing) return existing.id

  const id = randomHex(ID_BYTES)
  const timestamp = now()
  await db.runAsync(
    `INSERT INTO playlists (id, name, kind, created_at, updated_at, bilibili_video_id)
     VALUES (?, ?, 'user', ?, ?, ?)`,
    [id, name, timestamp, timestamp, bvid],
  )
  return id
}

export async function renamePlaylist(playlistId: string, name: string): Promise<void> {
  const playlist = await getPlaylist(playlistId)
  if (playlist?.kind === FAVOURITES) throw new FavouritesIsProtected('renamed')

  const db = await openLibraryDb()
  await db.runAsync('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?', [
    name.trim(),
    now(),
    playlistId,
  ])
}

export async function deletePlaylist(playlistId: string): Promise<void> {
  const playlist = await getPlaylist(playlistId)
  if (playlist?.kind === FAVOURITES) throw new FavouritesIsProtected('deleted')

  const db = await openLibraryDb()
  // Explicit rather than a cascade: SQLite honours foreign keys only when
  // `PRAGMA foreign_keys` is on, which is off by default and per-connection.
  await withLibraryTransaction(db, async () => {
    await db.runAsync('DELETE FROM playlist_items WHERE playlist_id = ?', [playlistId])
    await db.runAsync('DELETE FROM playlists WHERE id = ?', [playlistId])
  })
}

/**
 * Delete several playlists at once (#570).
 *
 * ## What this does not do
 *
 * **It does not touch the songs.** A playlist is a list of references; deleting
 * it removes the references and leaves the music on the device. That is already
 * true of {@link deletePlaylist} and it is the property most worth stating,
 * because "delete" means *gone* everywhere else in this app — the library's own
 * delete takes the audio with it, and the two verbs sit two taps apart.
 *
 * ## Favourites is refused for the whole batch
 *
 * Not skipped. A batch that quietly dropped one of the things it was asked to
 * delete and reported success would be worse than an error: the user would have
 * to count the rows to find out. The screen keeps Favourites out of the list it
 * offers, so reaching this is a bug rather than a user's mistake, and it should
 * behave like one.
 */
export async function deletePlaylists(playlistIds: readonly string[]): Promise<number> {
  if (playlistIds.length === 0) return 0

  for (const playlistId of playlistIds) {
    const playlist = await getPlaylist(playlistId)
    if (playlist?.kind === FAVOURITES) throw new FavouritesIsProtected('deleted')
  }

  const db = await openLibraryDb()
  let removed = 0
  for (const chunk of chunked(playlistIds, SQLITE_VARIABLE_LIMIT)) {
    const places = chunk.map(() => '?').join(',')
    await withLibraryTransaction(db, async () => {
      // Explicit rather than a cascade, for the reason the singular form gives:
      // SQLite honours foreign keys only when `PRAGMA foreign_keys` is on,
      // which is off by default and per-connection.
      await db.runAsync(`DELETE FROM playlist_items WHERE playlist_id IN (${places})`, [...chunk])
      const result = await db.runAsync(`DELETE FROM playlists WHERE id IN (${places})`, [...chunk])
      removed += result.changes ?? 0
    })
  }
  return removed
}

/** A playlist's songs, in order. */
export async function listPlaylistItems(playlistId: string): Promise<LocalPlaylistItem[]> {
  const db = await openLibraryDb()
  const rows = await db.getAllAsync<LocalSong & { item_id: string; position: number }>(
    `SELECT s.*, i.id AS item_id, i.position
     FROM playlist_items i
     JOIN songs s ON s.id = i.song_id
     WHERE i.playlist_id = ?
     ORDER BY i.position`,
    [playlistId],
  )
  return rows.map(({ item_id, position, ...song }) => ({ id: item_id, position, song }))
}

/**
 * Append songs, skipping any already there.
 *
 * Silently skipping rather than failing: adding a playlist's worth of songs
 * where two overlap should add the rest, not refuse the lot. The UNIQUE index
 * is what makes "already there" a fact rather than a race.
 */
export async function addSongsToPlaylist(playlistId: string, songIds: string[]): Promise<number> {
  const db = await openLibraryDb()
  let added = 0

  await withLibraryTransaction(db, async () => {
    const last = await db.getFirstAsync<{ next: number }>(
      'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM playlist_items WHERE playlist_id = ?',
      [playlistId],
    )
    let position = last?.next ?? 0

    for (const songId of songIds) {
      const existing = await db.getFirstAsync<{ id: string }>(
        'SELECT id FROM playlist_items WHERE playlist_id = ? AND song_id = ?',
        [playlistId, songId],
      )
      if (existing) continue

      await db.runAsync(
        'INSERT INTO playlist_items (id, playlist_id, song_id, position) VALUES (?, ?, ?, ?)',
        [randomHex(ID_BYTES), playlistId, songId, position],
      )
      position += 1
      added += 1
    }

    if (added > 0) {
      await db.runAsync('UPDATE playlists SET updated_at = ? WHERE id = ?', [now(), playlistId])
    }
  })

  return added
}

/** Renumber from 0 with no gaps — the invariant the UNIQUE index protects. */
async function renumber(
  db: Awaited<ReturnType<typeof openLibraryDb>>,
  playlistId: string,
): Promise<void> {
  const rows = await db.getAllAsync<{ id: string }>(
    'SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY position',
    [playlistId],
  )
  // Two passes, out of the way and back. A single pass collides with itself:
  // moving item 3 to position 1 hits the row already there, and the UNIQUE
  // index rejects it rather than letting a duplicate through.
  for (const [index, row] of rows.entries()) {
    await db.runAsync('UPDATE playlist_items SET position = ? WHERE id = ?', [-(index + 1), row.id])
  }
  for (const [index, row] of rows.entries()) {
    await db.runAsync('UPDATE playlist_items SET position = ? WHERE id = ?', [index, row.id])
  }
}

export async function removePlaylistItems(playlistId: string, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return
  const db = await openLibraryDb()

  await withLibraryTransaction(db, async () => {
    for (const itemId of itemIds) {
      await db.runAsync('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?', [
        itemId,
        playlistId,
      ])
    }
    await renumber(db, playlistId)
    await db.runAsync('UPDATE playlists SET updated_at = ? WHERE id = ?', [now(), playlistId])
  })
}

/**
 * Reorder by the complete list of item ids, in their new order.
 *
 * The whole list, as the server's endpoint demanded: anything less makes
 * "where does everything else go" ambiguous, and a partial list is far more
 * likely to be a bug than an intention.
 */
export async function reorderPlaylist(playlistId: string, itemIds: string[]): Promise<void> {
  const db = await openLibraryDb()

  await withLibraryTransaction(db, async () => {
    const current = await db.getAllAsync<{ id: string }>(
      'SELECT id FROM playlist_items WHERE playlist_id = ?',
      [playlistId],
    )
    const currentIds = new Set(current.map((row) => row.id))
    const sameSet =
      currentIds.size === itemIds.length && itemIds.every((itemId) => currentIds.has(itemId))
    if (!sameSet) {
      throw new Error('Reorder must list exactly the playlist’s current items')
    }

    for (const [index, itemId] of itemIds.entries()) {
      await db.runAsync('UPDATE playlist_items SET position = ? WHERE id = ?', [
        -(index + 1),
        itemId,
      ])
    }
    for (const [index, itemId] of itemIds.entries()) {
      await db.runAsync('UPDATE playlist_items SET position = ? WHERE id = ?', [index, itemId])
    }
    await db.runAsync('UPDATE playlists SET updated_at = ? WHERE id = ?', [now(), playlistId])
  })
}

/** The song ids in favourites, for drawing the hearts. */
export async function favouriteSongIds(): Promise<string[]> {
  const db = await openLibraryDb()
  const favourites = await favouritesPlaylist()
  const rows = await db.getAllAsync<{ song_id: string }>(
    'SELECT song_id FROM playlist_items WHERE playlist_id = ?',
    [favourites.id],
  )
  return rows.map((row) => row.song_id)
}

/**
 * Which playlists already contain a song (#231).
 *
 * What lets the picker say "you already added this" rather than letting someone
 * add it twice and find out afterwards. Favourites is included — it is a
 * playlist row like any other — and the picker filters it out for its own
 * reasons, so the filtering stays where the decision is.
 */
export async function playlistIdsForSong(songId: string): Promise<string[]> {
  const db = await openLibraryDb()
  const rows = await db.getAllAsync<{ playlist_id: string }>(
    'SELECT DISTINCT playlist_id FROM playlist_items WHERE song_id = ?',
    [songId],
  )
  return rows.map((row) => row.playlist_id)
}

export async function setFavourite(songId: string, favourite: boolean): Promise<void> {
  const favourites = await favouritesPlaylist()
  if (favourite) {
    await addSongsToPlaylist(favourites.id, [songId])
    return
  }

  const db = await openLibraryDb()
  const item = await db.getFirstAsync<{ id: string }>(
    'SELECT id FROM playlist_items WHERE playlist_id = ? AND song_id = ?',
    [favourites.id, songId],
  )
  if (item) await removePlaylistItems(favourites.id, [item.id])
}

/** Every playlist entry for a song — what deleting a song has to clean up. */
export async function removeSongFromAllPlaylists(songId: string): Promise<void> {
  const db = await openLibraryDb()
  const affected = await db.getAllAsync<{ playlist_id: string }>(
    'SELECT DISTINCT playlist_id FROM playlist_items WHERE song_id = ?',
    [songId],
  )

  await withLibraryTransaction(db, async () => {
    await db.runAsync('DELETE FROM playlist_items WHERE song_id = ?', [songId])
    // Leaving a gap where the song was would break the dense-position
    // invariant for every playlist it happened to be in.
    for (const row of affected) {
      await renumber(db, row.playlist_id)
    }
  })
}

/**
 * The same, for many songs at once (#569).
 *
 * ## Why this exists rather than a loop over the singular form
 *
 * `renumber` is the expensive half, and the singular version runs it once per
 * **song**. Deleting forty songs out of one playlist renumbered that playlist
 * forty times — forty passes over the same rows to reach the same answer.
 *
 * Here the affected playlists are collected first and renumbered **once each**,
 * which is the whole of the win when a selection came out of one playlist. That
 * is the common case: it is how someone clears a playlist they no longer want.
 *
 * Chunked because SQLite's default host-parameter limit is 999, and "select
 * all" on a real library is past it. The limit is per statement, so chunking is
 * enough.
 */
export async function removeSongsFromAllPlaylists(songIds: readonly string[]): Promise<void> {
  // No early return for an empty list: `chunked` yields nothing, so the loop is
  // already a no-op and a guard here would be code no test could distinguish
  // from its absence. `removeLocalSongs` has one because *its* early return is
  // observable — it skips calling this at all.
  const db = await openLibraryDb()

  for (const chunk of chunked(songIds, SQLITE_VARIABLE_LIMIT)) {
    const places = chunk.map(() => '?').join(',')
    const affected = await db.getAllAsync<{ playlist_id: string }>(
      `SELECT DISTINCT playlist_id FROM playlist_items WHERE song_id IN (${places})`,
      [...chunk],
    )

    await withLibraryTransaction(db, async () => {
      await db.runAsync(`DELETE FROM playlist_items WHERE song_id IN (${places})`, [...chunk])
      // Once per playlist rather than once per song. Leaving a gap would break
      // the dense-position invariant, exactly as it would for one song.
      for (const row of affected) {
        await renumber(db, row.playlist_id)
      }
    })
  }
}

/** SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 999; these queries bind one
 *  parameter per id, and the margin costs nothing. */
const SQLITE_VARIABLE_LIMIT = 900

function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}
