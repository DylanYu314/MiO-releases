import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import { MIGRATIONS, __resetLibraryTransactions } from '../src/library/db'
import {
  addTracks,
  chooseMatch,
  countMatchesByStatus,
  createImport,
  deleteImport,
  getImport,
  getMatch,
  listImports,
  listMatches,
  setMatchCandidates,
  pageMatches,
  setMatchStatus,
  updateImport,
} from '../src/library/playlistImports'

/**
 * Playlist imports on the device — schema v10 (#610).
 *
 * ## Driven by real SQLite, not a fake
 *
 * `node:sqlite` is the same engine the phone runs, so the real migration and
 * the real `playlistImports.ts` run unchanged. The things worth testing here
 * are SQL facts — a UNIQUE index that stops a resumed run duplicating a track,
 * a count derived from rows rather than from a promise — and a fake would
 * encode my reading of the SQL instead of the database's. Same reasoning as
 * `playlists.test.tsx`.
 */

// `mock`-prefixed so the hoisted `jest.mock` factory may reference it.
let mockDb: DatabaseSync

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

/** Build a database at a given schema version by running that many migrations. */
function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const migration of MIGRATIONS.slice(0, version)) db.exec(migration)
  return db
}

beforeEach(() => {
  __resetLibraryTransactions()
  mockDb = databaseAt(MIGRATIONS.length)
})

function tableNames(db: DatabaseSync): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
      name: string
    }[]
  ).map((row) => row.name)
}

describe('the v10 migration', () => {
  it('is the tenth, so the device schema is at v10', () => {
    // A control on every other test in this file: they build "the current
    // schema" from MIGRATIONS.length, which proves nothing about v10 existing.
    expect(MIGRATIONS).toHaveLength(10)
  })

  it('adds both tables to a fresh install', () => {
    expect(tableNames(mockDb)).toEqual(
      expect.arrayContaining(['playlist_imports', 'track_matches']),
    )
  })

  it('is additive — a v9 library keeps its songs and playlists', () => {
    const db = databaseAt(9)
    db.prepare(
      `INSERT INTO songs (id, title, artist, source_url, source_platform, added_at)
       VALUES ('s1', 'Kept', 'Someone', 'https://y/1', 'youtube', '2026-01-01')`,
    ).run()
    db.prepare(
      `INSERT INTO playlists (id, name, kind, created_at, updated_at)
       VALUES ('p1', 'Kept playlist', 'user', '2026-01-01', '2026-01-01')`,
    ).run()

    db.exec(MIGRATIONS[9])

    expect(db.prepare(`SELECT title FROM songs WHERE id = 's1'`).get()).toEqual({ title: 'Kept' })
    expect(db.prepare(`SELECT name FROM playlists WHERE id = 'p1'`).get()).toEqual({
      name: 'Kept playlist',
    })
    expect(tableNames(db)).toEqual(expect.arrayContaining(['playlist_imports', 'track_matches']))
  })

  it('can be re-run without throwing, as a resumed migration would', () => {
    expect(() => mockDb.exec(MIGRATIONS[9])).not.toThrow()
  })
})

describe('imports', () => {
  it('round-trips a row', async () => {
    const id = await createImport({
      service: 'spotify',
      externalPlaylistId: 'abc123',
      name: 'Road trip',
    })

    const stored = await getImport(id)
    expect(stored).toMatchObject({
      id,
      service: 'spotify',
      external_playlist_id: 'abc123',
      name: 'Road trip',
      status: 'queued',
      matched_count: 0,
      imported_count: 0,
      failed_count: 0,
      playlist_id: null,
    })
  })

  it('lists newest first', async () => {
    const first = await createImport({ service: 'qq', externalPlaylistId: '1', name: 'One' })
    // `created_at` is an ISO string, so two rows written in the same millisecond
    // would tie and make the assertion depend on insertion order instead.
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = await createImport({ service: 'kugou', externalPlaylistId: '2', name: 'Two' })

    expect((await listImports()).map((row) => row.id)).toEqual([second, first])
  })

  it('patches only the columns it is given, and moves updated_at', async () => {
    const id = await createImport({ service: 'netease', externalPlaylistId: '9', name: 'Mix' })
    const before = await getImport(id)
    await new Promise((resolve) => setTimeout(resolve, 2))

    await updateImport(id, { status: 'review', matched_count: 3 })

    const after = await getImport(id)
    expect(after).toMatchObject({ status: 'review', matched_count: 3, name: 'Mix' })
    expect(after?.updated_at).not.toBe(before?.updated_at)
  })

  it('does not write at all for an empty patch', async () => {
    const id = await createImport({ service: 'spotify', externalPlaylistId: 'x', name: 'X' })
    const before = await getImport(id)
    await new Promise((resolve) => setTimeout(resolve, 2))

    await updateImport(id, {})

    expect((await getImport(id))?.updated_at).toBe(before?.updated_at)
  })

  it('deletes its matches with it', async () => {
    const id = await createImport({ service: 'spotify', externalPlaylistId: 'x', name: 'X' })
    const other = await createImport({ service: 'spotify', externalPlaylistId: 'y', name: 'Y' })
    await addTracks(id, [{ title: 'A', artist: 'B' }])
    await addTracks(other, [{ title: 'C', artist: 'D' }])

    await deleteImport(id)

    expect(await getImport(id)).toBeNull()
    expect(await listMatches(id)).toEqual([])
    // The other import is untouched — a subquery that deleted by the wrong key
    // would take both.
    expect(await listMatches(other)).toHaveLength(1)
  })
})

describe('tracks', () => {
  it('stores them in order, as pending', async () => {
    const id = await createImport({ service: 'spotify', externalPlaylistId: 'x', name: 'X' })
    await addTracks(id, [
      { title: 'First', artist: 'A', duration_s: 100 },
      { title: 'Second', artist: 'B', album: 'Album', external_id: 'ext2' },
    ])

    const matches = await listMatches(id)
    expect(matches.map((m) => [m.position, m.title, m.status])).toEqual([
      [0, 'First', 'pending'],
      [1, 'Second', 'pending'],
    ])
    expect(matches[1]).toMatchObject({ album: 'Album', external_id: 'ext2', duration_s: null })
    expect(matches[0]).toMatchObject({ album: null, external_id: null, duration_s: 100 })
  })

  /**
   * ⚠️ #585's shape: `list_playlist` dropped entries it could not read and
   * recorded the survivors as the playlist's size, so an eighteen-track import
   * reported "4/4 done". The count has to come from the rows.
   */
  it('sets track_count from the rows actually stored, not from a claim', async () => {
    const id = await createImport({
      service: 'netease',
      externalPlaylistId: 'x',
      name: 'X',
      // The fetcher claims eighteen...
      trackCount: 18,
    })
    expect((await getImport(id))?.track_count).toBe(18)

    // ...and hands over four.
    await addTracks(id, [
      { title: 'A', artist: 'a' },
      { title: 'B', artist: 'b' },
      { title: 'C', artist: 'c' },
      { title: 'D', artist: 'd' },
    ])

    expect((await getImport(id))?.track_count).toBe(4)
  })

  it('refuses a second row at the same position, so a resumed run cannot duplicate', async () => {
    const id = await createImport({ service: 'spotify', externalPlaylistId: 'x', name: 'X' })
    await addTracks(id, [{ title: 'A', artist: 'a' }])

    await expect(addTracks(id, [{ title: 'A again', artist: 'a' }])).rejects.toThrow()
    expect(await listMatches(id)).toHaveLength(1)
  })

  it('lets two imports use the same positions', async () => {
    const first = await createImport({ service: 'spotify', externalPlaylistId: 'x', name: 'X' })
    const second = await createImport({ service: 'qq', externalPlaylistId: 'y', name: 'Y' })
    await addTracks(first, [{ title: 'A', artist: 'a' }])

    await expect(addTracks(second, [{ title: 'B', artist: 'b' }])).resolves.toBe(1)
  })

  it('filters by status, and counts by it', async () => {
    const id = await createImport({ service: 'spotify', externalPlaylistId: 'x', name: 'X' })
    await addTracks(id, [
      { title: 'A', artist: 'a' },
      { title: 'B', artist: 'b' },
      { title: 'C', artist: 'c' },
    ])
    const [a, b] = await listMatches(id)
    await setMatchStatus(a.id, 'imported', { song_id: 'song-1' })
    await setMatchStatus(b.id, 'failed', { error: 'refused' })

    expect((await listMatches(id, 'pending')).map((m) => m.title)).toEqual(['C'])
    expect(await countMatchesByStatus(id)).toEqual({ imported: 1, failed: 1, pending: 1 })
    expect(await getMatch(a.id)).toMatchObject({ status: 'imported', song_id: 'song-1' })
    expect(await getMatch(b.id)).toMatchObject({ status: 'failed', error: 'refused' })
  })
})

describe('paging the matches', () => {
  async function threeTracks(): Promise<string> {
    const id = await createImport({ service: 'spotify', externalPlaylistId: 'x', name: 'X' })
    await addTracks(id, [
      { title: 'A', artist: 'a' },
      { title: 'B', artist: 'b' },
      { title: 'C', artist: 'c' },
    ])
    return id
  }

  it('pages in position order and reports the true total', async () => {
    const id = await threeTracks()

    const first = await pageMatches(id, 'all', 2, 0)
    expect(first.items.map((m) => m.title)).toEqual(['A', 'B'])
    expect(first).toMatchObject({ total: 3, limit: 2, offset: 0 })

    const second = await pageMatches(id, 'all', 2, 2)
    expect(second.items.map((m) => m.title)).toEqual(['C'])
    expect(second.total).toBe(3)
  })

  /**
   * ⚠️ Added because a mutation survived: making `pageMatches` ignore its status
   * filter broke nothing. The review screen's tabs are that filter, so an
   * unfiltered page would quietly show every track under "No match".
   */
  it('filters by status, and counts only what matches the filter', async () => {
    const id = await threeTracks()
    const [a, b] = await listMatches(id)
    await setMatchStatus(a.id, 'no_match')
    await setMatchStatus(b.id, 'accepted')

    const page = await pageMatches(id, 'no_match', 50, 0)
    expect(page.items.map((m) => m.title)).toEqual(['A'])
    // The total has to be the filtered one, or the infinite query asks for a
    // page that does not exist and the list never settles.
    expect(page.total).toBe(1)
  })

  it('hydrates candidates on a page as it does on a single row', async () => {
    const id = await threeTracks()
    const [a] = await listMatches(id)
    await setMatchCandidates(
      a.id,
      [{ url: 'https://y/1', title: 'T', uploader: null, duration: 1, score: 0.9 }],
      'auto_matched',
    )

    const page = await pageMatches(id, 'all', 50, 0)
    expect(page.items[0].candidates).toHaveLength(1)
    expect(page.items[0].candidates[0].url).toBe('https://y/1')
  })
})

describe('candidates', () => {
  const candidates = [
    {
      url: 'https://y/1',
      title: 'Best',
      uploader: 'A - Topic',
      duration: 200,
      score: 0.91,
      source: 'youtube',
    },
    {
      url: 'https://y/2',
      title: 'Next',
      uploader: 'B',
      duration: 205,
      score: 0.62,
      source: 'youtube',
    },
  ]

  async function oneMatch(): Promise<string> {
    const id = await createImport({ service: 'spotify', externalPlaylistId: 'x', name: 'X' })
    await addTracks(id, [{ title: 'A', artist: 'a' }])
    return (await listMatches(id))[0].id
  }

  it('round-trips through JSON', async () => {
    const matchId = await oneMatch()
    await setMatchCandidates(matchId, candidates, 'auto_matched')

    expect((await getMatch(matchId))?.candidates).toEqual(candidates)
  })

  it('pre-chooses only an auto match', async () => {
    const matchId = await oneMatch()
    await setMatchCandidates(matchId, candidates, 'auto_matched')

    expect(await getMatch(matchId)).toMatchObject({
      status: 'auto_matched',
      chosen_url: 'https://y/1',
      confidence: 0.91,
    })
  })

  it('leaves a reviewable match unchosen, so the human decides', async () => {
    const matchId = await oneMatch()
    await setMatchCandidates(matchId, candidates, 'needs_review')

    expect(await getMatch(matchId)).toMatchObject({
      status: 'needs_review',
      chosen_url: null,
      confidence: null,
    })
  })

  it('survives a blob it cannot parse, losing the alternatives and not the track', async () => {
    const matchId = await oneMatch()
    mockDb.prepare(`UPDATE track_matches SET candidates = ? WHERE id = ?`).run('{not json', matchId)

    const match = await getMatch(matchId)
    expect(match?.candidates).toEqual([])
    expect(match?.title).toBe('A')
  })

  it('survives valid JSON that is not an array', async () => {
    const matchId = await oneMatch()
    mockDb.prepare(`UPDATE track_matches SET candidates = ? WHERE id = ?`).run('{"a":1}', matchId)

    expect((await getMatch(matchId))?.candidates).toEqual([])
  })
})

describe("the human's answer", () => {
  async function reviewable(): Promise<string> {
    const id = await createImport({ service: 'spotify', externalPlaylistId: 'x', name: 'X' })
    await addTracks(id, [{ title: 'A', artist: 'a' }])
    const matchId = (await listMatches(id))[0].id
    await setMatchCandidates(
      matchId,
      [{ url: 'https://y/1', title: 'T', uploader: null, duration: 1, score: 0.7 }],
      'needs_review',
    )
    return matchId
  }

  it('accepts a candidate and takes its score from the candidate', async () => {
    const matchId = await reviewable()
    await chooseMatch(matchId, 'https://y/1')

    expect(await getMatch(matchId)).toMatchObject({
      status: 'accepted',
      chosen_url: 'https://y/1',
      confidence: 0.7,
    })
  })

  /**
   * ⚠️ `confidence` means **machine** confidence. A hand-pasted URL was never
   * measured, so keeping the replaced candidate's score would attach a number
   * to something nothing scored — the rule the server's endpoint follows.
   */
  it('nulls confidence for a URL that is not one of the candidates', async () => {
    const matchId = await reviewable()
    await chooseMatch(matchId, 'https://y/pasted-by-hand')

    expect(await getMatch(matchId)).toMatchObject({
      status: 'accepted',
      chosen_url: 'https://y/pasted-by-hand',
      confidence: null,
    })
  })

  it('rejects the track when nothing is chosen', async () => {
    const matchId = await reviewable()
    await chooseMatch(matchId, null)

    expect(await getMatch(matchId)).toMatchObject({
      status: 'rejected',
      chosen_url: null,
      confidence: null,
    })
  })
})
