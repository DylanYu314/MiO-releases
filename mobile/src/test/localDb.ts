import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

/**
 * A real SQLite database for suites whose subject moved onto the device (#611).
 *
 * ## Why real, and why shared
 *
 * `node:sqlite` is the same engine the phone runs, so the real migrations and
 * the real `playlistImports.ts` execute unchanged. `playlists.test.tsx` reached
 * that conclusion first and wrote this adapter inline; #611 made eight more
 * suites need it, and eight hand-copied adapters would drift — one of them
 * would end up modelling the SQL rather than running it, which is precisely
 * what a fake does wrong.
 *
 * ## Use
 *
 * `jest.mock` factories are hoisted above every declaration, so the database
 * handle has to be reachable from inside one. The name must begin with `mock`
 * — jest exempts only those from its out-of-scope guard:
 *
 * ⚠️ And `sqliteAdapter` must be pulled in **inside** the factory with
 * `requireActual`, not from the file's imports — a factory may not reference an
 * out-of-scope binding at all, and the `mock` prefix is the only exemption.
 *
 * ```ts
 * let mockDb: DatabaseSync
 * jest.mock('../src/library/db', () => {
 *   const actual = jest.requireActual('../src/library/db')
 *   const { sqliteAdapter } = jest.requireActual('../src/test/localDb')
 *   return { ...actual, openLibraryDb: async () => sqliteAdapter(() => mockDb) }
 * })
 * beforeEach(() => { mockDb = freshLibraryDb() })
 * ```
 *
 * ⚠️ Pair it with `__resetLibraryTransactions()` in `beforeEach`: the
 * transaction queue in `db.ts` is module state and outlives a test.
 */

/** The `expo-sqlite` surface the library modules actually call. */
export interface LibraryDbLike {
  runAsync: (sql: string, params?: SQLInputValue[]) => Promise<unknown>
  getAllAsync: <T>(sql: string, params?: SQLInputValue[]) => Promise<T[]>
  getFirstAsync: <T>(sql: string, params?: SQLInputValue[]) => Promise<T | null>
  withTransactionAsync: (task: () => Promise<void>) => Promise<void>
}

/**
 * Adapt a `node:sqlite` handle to the async shape `openLibraryDb` returns.
 *
 * Takes a **getter** rather than the database itself so a suite can replace the
 * handle in `beforeEach` without re-registering the mock — the hoisted factory
 * runs once, and closing over the first database would silently give every test
 * after the first a stale one.
 */
export function sqliteAdapter(current: () => DatabaseSync): LibraryDbLike {
  return {
    runAsync: async (sql: string, params: SQLInputValue[] = []) =>
      current()
        .prepare(sql)
        .run(...params),
    getAllAsync: async <T>(sql: string, params: SQLInputValue[] = []) =>
      current()
        .prepare(sql)
        .all(...params) as T[],
    getFirstAsync: async <T>(sql: string, params: SQLInputValue[] = []) =>
      (current()
        .prepare(sql)
        .get(...params) ?? null) as T | null,
    withTransactionAsync: async (task: () => Promise<void>) => {
      const db = current()
      db.exec('BEGIN')
      try {
        await task()
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

/**
 * A database with every migration applied.
 *
 * ⚠️ Reads `MIGRATIONS` through `requireActual`, because the suites using this
 * are the ones mocking `../src/library/db` — importing it normally would hand
 * back their own mock and build an empty schema.
 */
let open: DatabaseSync | null = null

export function freshLibraryDb(upTo?: number): DatabaseSync {
  const { MIGRATIONS } = jest.requireActual<{ MIGRATIONS: readonly string[] }>('../library/db')
  /*
   * ⚠️ Close the previous one.
   *
   * These are called from `beforeEach`, so a suite of forty tests opens forty
   * in-memory databases and, without this, never closes any of them. Each is a
   * live handle: the tests still pass, and jest then reports "a worker process
   * has failed to exit gracefully" — the same *symptom* as the `gcTime` trap in
   * this repo's conventions and a different cause, which is exactly why it is worth naming
   * here rather than assuming it is that one.
   */
  open?.close()
  const db = new DatabaseSync(':memory:')
  open = db
  for (const migration of MIGRATIONS.slice(0, upTo ?? MIGRATIONS.length)) db.exec(migration)
  return db
}

/**
 * Write import fixtures straight into the tables (#611).
 *
 * The screen suites used to hand `MatchReview` its rows by answering
 * `GET /playlist-imports/{id}/matches`. The rows come from SQLite now, so the
 * fixtures go in the same shape to the same place — which keeps every call site
 * in those suites unchanged, and that is the point: a diff in the *assertions*
 * would mean the port changed behaviour, and a diff in the *fixtures* would
 * only mean the rows moved.
 *
 * Synchronous, because `node:sqlite` is, and because the tests call it before
 * `await render(...)` rather than inside an effect.
 */
export function seedImport(
  db: DatabaseSync,
  importId: string,
  fields: Record<string, unknown> = {},
): void {
  /*
   * ⚠️ Whitelisted, not spread wholesale.
   *
   * The fixtures in these suites are *server* `PlaylistImport` objects, and
   * they still carry `account_id` and `client_matches` — columns v10 drops on
   * purpose (#610). Passing them straight through makes SQLite refuse the whole
   * insert with "no column named account_id", which reads like a schema bug
   * rather than a fixture one.
   */
  const known = [
    'service',
    'external_playlist_id',
    'name',
    'status',
    'track_count',
    'matched_count',
    'import_total',
    'imported_count',
    'failed_count',
    'error',
    'playlist_id',
    'created_at',
    'updated_at',
  ]
  const accepted = Object.fromEntries(
    Object.entries(fields).filter(([column]) => known.includes(column)),
  )
  const row = {
    id: importId,
    service: 'spotify',
    external_playlist_id: 'pl1',
    name: 'Road trip',
    status: 'review',
    track_count: null,
    matched_count: 0,
    import_total: null,
    imported_count: 0,
    failed_count: 0,
    error: null,
    playlist_id: null,
    created_at: '2026-08-19T00:00:00Z',
    updated_at: '2026-08-19T00:00:00Z',
    ...accepted,
  }
  const columns = Object.keys(row)
  db.prepare(
    `INSERT OR REPLACE INTO playlist_imports (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...(Object.values(row) as SQLInputValue[]))
}

/** Track rows for an import, in the order given. */
export function seedMatches(
  db: DatabaseSync,
  importId: string,
  matches: Record<string, unknown>[],
): void {
  matches.forEach((match, index) => {
    const row = {
      id: String(match.id ?? index + 1),
      playlist_import_id: importId,
      /*
       * ⚠️ The **array order**, never the fixture's own `position`.
       *
       * These fixtures are built from one `match()` helper whose default is
       * `position: 0`, so three overridden rows all claim position 0 — and the
       * UNIQUE index on `(playlist_import_id, position)` then makes
       * `INSERT OR REPLACE` collapse them into the last one. Silently: the
       * screen simply renders one row and the test says "cannot find text".
       */
      position: index,
      external_id: match.external_id ?? null,
      title: match.title ?? `Track ${index}`,
      artist: match.artist ?? 'An Artist',
      album: match.album ?? null,
      duration_s: match.duration_s ?? null,
      // Stored as JSON, exactly as the column holds it.
      candidates: JSON.stringify(match.candidates ?? []),
      chosen_url: match.chosen_url ?? null,
      confidence: match.confidence ?? null,
      status: match.status ?? 'needs_review',
      song_id: match.song_id ?? null,
      error: match.error ?? null,
    }
    const columns = Object.keys(row)
    db.prepare(
      `INSERT OR REPLACE INTO track_matches (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
    ).run(...(Object.values(row) as SQLInputValue[]))
  })
}
