import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import { MIGRATIONS } from '../src/library/db'
import {
  addSongsToPlaylist,
  createPlaylist,
  deletePlaylist,
  favouriteSongIds,
  favouritesPlaylist,
  FavouritesIsProtected,
  listPlaylistItems,
  listPlaylists,
  playlistForBilibiliFav,
  playlistForGooglePlaylist,
  removePlaylistItems,
  removeSongFromAllPlaylists,
  removeSongsFromAllPlaylists,
  playlistForBilibiliVideo,
  renamePlaylist,
  reorderPlaylist,
  setFavourite,
} from '../src/library/playlists'

/**
 * Playlists and favourites on the device (#219), driven against **real SQLite**.
 *
 * A hand-written SQL mock would be the wrong tool here. The behaviour worth
 * testing *is* the SQL: dense positions, the UNIQUE indexes, and a reorder that
 * has to move rows out of the way before moving them back because a single pass
 * collides with itself. A mock that interprets those statements would be
 * proving my interpretation, not the database's.
 *
 * Node 22's `node:sqlite` is the same engine the phone runs, so the dialect
 * being exercised is the real one.
 */

// `mock`-prefixed so the `jest.mock` factory may reference it: the factory is
// hoisted above every declaration and jest exempts only names starting with
// "mock" from its out-of-scope guard (a convention in this repo).
let mockDb: DatabaseSync

/** A thin async adapter, so `playlists.ts` talks to real SQLite unchanged. */
jest.mock('../src/library/db', () => {
  const actual = jest.requireActual('../src/library/db')
  return {
    ...actual,
    openLibraryDb: async () => ({
      runAsync: async (sql: string, params: SQLInputValue[] = []) =>
        mockDb.prepare(sql).run(...params),
      getAllAsync: async (sql: string, params: SQLInputValue[] = []) =>
        mockDb.prepare(sql).all(...params),
      getFirstAsync: async (sql: string, params: SQLInputValue[] = []) =>
        mockDb.prepare(sql).get(...params) ?? null,
      withTransactionAsync: async (task: () => Promise<void>) => {
        mockDb.exec('BEGIN')
        try {
          await task()
          mockDb.exec('COMMIT')
        } catch (error) {
          mockDb.exec('ROLLBACK')
          throw error
        }
      },
    }),
  }
})

function addSong(id: string, title = `Song ${id}`) {
  mockDb
    .prepare(
      // A source URL per song, since v6: `songs.source_url` is UNIQUE, because
      // two rows for one video is what #310 was. A shared placeholder here made
      // every fixture song the same track.
      `INSERT INTO songs (id, server_song_id, title, artist, source_url, source_platform, added_at)
     VALUES (?, NULL, ?, 'A', ?, 'Youtube', '2026-07-31T00:00:00Z')`,
    )
    .run(id, title, `https://youtube.com/watch?v=${id}`)
}

/** Positions as stored, in order — the invariant most of these are about. */
function positions(playlistId: string): number[] {
  return (
    mockDb
      .prepare('SELECT position FROM playlist_items WHERE playlist_id = ? ORDER BY position')
      .all(playlistId) as { position: number }[]
  ).map((row) => row.position)
}

beforeEach(() => {
  mockDb = new DatabaseSync(':memory:')
  for (const migration of MIGRATIONS) mockDb.exec(migration)
  for (const id of ['s1', 's2', 's3', 's4']) addSong(id)
})

describe('favourites', () => {
  it('exists from the start and is listed first', async () => {
    await createPlaylist('Road Trip')

    const all = await listPlaylists()
    // Pinned rather than sorted by name: it is the one playlist every screen
    // wants at the top, and sorting it there in SQL saves each of them doing it.
    expect(all[0].kind).toBe('favourites')
    expect(all.map((playlist) => playlist.name)).toEqual(['Favourites', 'Road Trip'])
  })

  it('cannot be renamed or deleted', async () => {
    const favourites = await favouritesPlaylist()

    // The backend refuses both with a 400; the rule survives the move.
    await expect(renamePlaylist(favourites.id, 'Nope')).rejects.toThrow(FavouritesIsProtected)
    await expect(deletePlaylist(favourites.id)).rejects.toThrow(FavouritesIsProtected)
  })

  it('hearts and unhearts a song', async () => {
    await setFavourite('s1', true)
    await setFavourite('s2', true)
    expect(await favouriteSongIds()).toEqual(['s1', 's2'])

    await setFavourite('s1', false)
    expect(await favouriteSongIds()).toEqual(['s2'])
  })

  it('hearting twice is not two hearts', async () => {
    await setFavourite('s1', true)
    await setFavourite('s1', true)

    expect(await favouriteSongIds()).toEqual(['s1'])
  })

  it('unhearting something that was never hearted is quiet', async () => {
    await expect(setFavourite('s1', false)).resolves.toBeUndefined()
  })

  it('works for a song the device fetched itself', async () => {
    // The whole reason this moved: `s1` has no `server_song_id`, so the server
    // could not have held this relationship at all.
    await setFavourite('s1', true)

    expect(await favouriteSongIds()).toEqual(['s1'])
  })
})

describe('playlist contents', () => {
  it('appends in order, from zero', async () => {
    const id = await createPlaylist('Mix')
    await addSongsToPlaylist(id, ['s1', 's2', 's3'])

    expect(positions(id)).toEqual([0, 1, 2])
    expect((await listPlaylistItems(id)).map((item) => item.song.id)).toEqual(['s1', 's2', 's3'])
  })

  it('skips songs already there and adds the rest', async () => {
    const id = await createPlaylist('Mix')
    await addSongsToPlaylist(id, ['s1', 's2'])

    // Adding an overlapping playlist's worth should add the rest, not refuse
    // the lot.
    const added = await addSongsToPlaylist(id, ['s2', 's3'])

    expect(added).toBe(1)
    expect((await listPlaylistItems(id)).map((item) => item.song.id)).toEqual(['s1', 's2', 's3'])
    expect(positions(id)).toEqual([0, 1, 2])
  })

  it('carries the song itself, not just an id', async () => {
    const id = await createPlaylist('Mix')
    await addSongsToPlaylist(id, ['s1'])

    const items = await listPlaylistItems(id)
    expect(items[0].song.title).toBe('Song s1')
  })

  it('renumbers densely when something is removed from the middle', async () => {
    const id = await createPlaylist('Mix')
    await addSongsToPlaylist(id, ['s1', 's2', 's3', 's4'])
    const items = await listPlaylistItems(id)

    await removePlaylistItems(id, [items[1].id])

    // A gap would break the UNIQUE index's promise and make "move to position
    // 2" ambiguous.
    expect(positions(id)).toEqual([0, 1, 2])
    expect((await listPlaylistItems(id)).map((item) => item.song.id)).toEqual(['s1', 's3', 's4'])
  })

  it('reorders by the complete list', async () => {
    const id = await createPlaylist('Mix')
    await addSongsToPlaylist(id, ['s1', 's2', 's3'])
    const items = await listPlaylistItems(id)

    await reorderPlaylist(id, [items[2].id, items[0].id, items[1].id])

    // The two-pass write matters: moving these in one pass collides with the
    // rows already at those positions and the UNIQUE index rejects it.
    expect((await listPlaylistItems(id)).map((item) => item.song.id)).toEqual(['s3', 's1', 's2'])
    expect(positions(id)).toEqual([0, 1, 2])
  })

  it('refuses a partial reorder rather than guessing', async () => {
    const id = await createPlaylist('Mix')
    await addSongsToPlaylist(id, ['s1', 's2', 's3'])
    const items = await listPlaylistItems(id)

    // "Where does everything else go" has no good answer, and a short list is
    // far more likely to be a bug than an intention.
    await expect(reorderPlaylist(id, [items[0].id])).rejects.toThrow(/exactly/)
    expect(positions(id)).toEqual([0, 1, 2])
  })

  it('deleting a playlist takes its items with it', async () => {
    const id = await createPlaylist('Mix')
    await addSongsToPlaylist(id, ['s1', 's2'])

    await deletePlaylist(id)

    // Explicit, because SQLite ignores `ON DELETE CASCADE` unless
    // `PRAGMA foreign_keys` is on — which it is not, by default.
    expect(mockDb.prepare('SELECT COUNT(*) AS n FROM playlist_items').get()).toMatchObject({ n: 0 })
    expect(await listPlaylists()).toHaveLength(1)
  })
})

describe('deleting a song', () => {
  it('removes it from every playlist and closes the gaps', async () => {
    const a = await createPlaylist('A')
    const b = await createPlaylist('B')
    await addSongsToPlaylist(a, ['s1', 's2', 's3'])
    await addSongsToPlaylist(b, ['s2', 's4'])
    await setFavourite('s2', true)

    await removeSongFromAllPlaylists('s2')

    // A row pointing at a song that no longer exists renders as a gap the user
    // cannot remove — and leaves the positions non-dense in every playlist it
    // was in.
    expect((await listPlaylistItems(a)).map((item) => item.song.id)).toEqual(['s1', 's3'])
    expect(positions(a)).toEqual([0, 1])
    expect((await listPlaylistItems(b)).map((item) => item.song.id)).toEqual(['s4'])
    expect(positions(b)).toEqual([0])
    expect(await favouriteSongIds()).toEqual([])
  })

  it('does the same for a whole batch, closing the gaps once (#569)', async () => {
    /*
     * The batch form exists because the singular one renumbers per **song**:
     * clearing forty tracks out of one playlist renumbered it forty times to
     * reach the answer one pass gives.
     *
     * What must not change is the result. Positions stay dense, in every
     * playlist, exactly as they do one at a time — asserted here rather than
     * assumed, because "faster" is worthless if it leaves a playlist the user
     * cannot reorder.
     */
    const a = await createPlaylist('A')
    const b = await createPlaylist('B')
    await addSongsToPlaylist(a, ['s1', 's2', 's3', 's4'])
    await addSongsToPlaylist(b, ['s2', 's4'])

    await removeSongsFromAllPlaylists(['s2', 's3'])

    // Two removed from the middle of A, and the positions still run 0,1 — the
    // dense-position invariant, after one renumbering pass instead of two.
    expect((await listPlaylistItems(a)).map((item) => item.song.id)).toEqual(['s1', 's4'])
    expect(positions(a)).toEqual([0, 1])
    // And B, which shared only one of them, is renumbered too rather than left
    // with a hole at position 0.
    expect((await listPlaylistItems(b)).map((item) => item.song.id)).toEqual(['s4'])
    expect(positions(b)).toEqual([0])
  })

  it('leaves every playlist alone for an empty batch', async () => {
    // The guard that stops `IN ()` — a syntax error — ever being built, and
    // stops a no-op renumbering every playlist in the library.
    const a = await createPlaylist('A')
    await addSongsToPlaylist(a, ['s1', 's2'])

    await removeSongsFromAllPlaylists([])

    expect((await listPlaylistItems(a)).map((item) => item.song.id)).toEqual(['s1', 's2'])
  })
})

describe('the playlist a multi-part video imports into (#575)', () => {
  it('creates it once and finds it again', async () => {
    // Importing four parts today and the other twenty-nine next week must fill
    // in the same playlist rather than build a second one beside it.
    const first = await playlistForBilibiliVideo('BV1r84y1e77t', 'The Whole Album')
    const again = await playlistForBilibiliVideo('BV1r84y1e77t', 'The Whole Album')

    expect(again).toBe(first)
    expect(await listPlaylists()).toHaveLength(2) // it, and Favourites
  })

  it('keys on the video, not on the name', async () => {
    // An uploader can rename a video, and a name match would then quietly
    // start a second playlist for the same album.
    const first = await playlistForBilibiliVideo('BV1r84y1e77t', 'The Whole Album')
    const renamed = await playlistForBilibiliVideo(
      'BV1r84y1e77t',
      'The Whole Album (2026 remaster)',
    )

    expect(renamed).toBe(first)
  })

  it('does not share a playlist with a favourites folder of the same id', async () => {
    // They are different id spaces that happen to both be "Bilibili" — which
    // is why v9 is its own column rather than reusing `bilibili_fav_id`.
    const video = await playlistForBilibiliVideo('486002245', 'A video')
    const folder = await playlistForBilibiliFav('486002245', 'A folder')

    expect(folder).not.toBe(video)
  })
})

describe('the playlist a Bilibili folder imports into (#492)', () => {
  it('makes one the first time, and finds the same one after that', async () => {
    // The whole reason `bilibili_fav_id` exists (v8). A favourites folder is a
    // living list, so re-importing to pick up what has been added since is the
    // ordinary way to use this — and it must fill in the playlist already on
    // the phone rather than leave two named the same.
    const first = await playlistForBilibiliFav('486002245', 'Late night')
    const second = await playlistForBilibiliFav('486002245', 'Late night')

    expect(second).toBe(first)
    expect(await listPlaylists()).toHaveLength(2) // favourites, plus this one
  })

  it('does not rename the local copy on a re-import', async () => {
    const id = await playlistForBilibiliFav('486002245', 'Late night')
    await renamePlaylist(id, 'My mix')

    await playlistForBilibiliFav('486002245', 'Late night')

    // Renaming the local copy is the user's to do, and a re-import is not a
    // request to undo it.
    const playlists = await listPlaylists()
    expect(playlists.find((playlist) => playlist.id === id)?.name).toBe('My mix')
  })

  it('keeps two different folders apart', async () => {
    const one = await playlistForBilibiliFav('486002245', 'Late night')
    const two = await playlistForBilibiliFav('999', 'Other')

    expect(two).not.toBe(one)
  })

  it('is not confused by a Google playlist whose id is the same string', async () => {
    // Two columns rather than one shared `source_id`, so this cannot collide
    // even though both ids are strings.
    const bilibili = await playlistForBilibiliFav('12345', 'From Bilibili')
    const google = await playlistForGooglePlaylist('12345', 'From YouTube')

    expect(google).not.toBe(bilibili)
  })
})
