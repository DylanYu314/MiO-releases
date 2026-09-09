import { DATABASE_NAME, __resetLibraryDb, migrate, openLibraryDb } from '../src/library/db'

/**
 * The on-device schema (#159).
 *
 * expo-sqlite is native, so this drives a fake that records what was run and
 * tracks `user_version` the way SQLite does. That is enough for the logic worth
 * testing — which migrations run, in what order, and whether re-running is a
 * no-op — and it is the logic whose failure mode is a device that will not open
 * its own library.
 */

interface FakeDb {
  version: number
  executed: string[]
  execAsync: (sql: string) => Promise<void>
  getFirstAsync: <T>(sql: string) => Promise<T | null>
  withTransactionAsync: (task: () => Promise<void>) => Promise<void>
  transactions: number
}

function fakeDb(startingVersion = 0): FakeDb {
  const db: FakeDb = {
    version: startingVersion,
    executed: [],
    transactions: 0,
    execAsync: async (sql: string) => {
      const bump = /PRAGMA user_version = (\d+)/.exec(sql)
      if (bump) db.version = Number(bump[1])
      else db.executed.push(sql)
    },
    getFirstAsync: async <T>(sql: string) => {
      if (sql.includes('user_version')) return { user_version: db.version } as T
      return null
    },
    withTransactionAsync: async (task: () => Promise<void>) => {
      db.transactions += 1
      await task()
    },
  }
  return db
}

// Named `mockOpen`, not `openMock`: a jest.mock factory is hoisted above every
// declaration in the file and may not reference an outer binding — except one
// whose name starts with `mock`, which is the documented escape hatch.
const mockOpen = jest.fn()
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: (...args: unknown[]) => mockOpen(...args),
}))

beforeEach(() => {
  __resetLibraryDb()
  mockOpen.mockReset()
})

describe('the on-device library schema (#159)', () => {
  it('creates the schema on a device that has never had one', async () => {
    const db = fakeDb(0)

    const version = await migrate(db as never)

    expect(db.executed.join('\n')).toContain('CREATE TABLE IF NOT EXISTS songs')
    expect(db.version).toBe(version)
    expect(version).toBeGreaterThan(0)
  })

  it('does nothing on a device that is already up to date', async () => {
    const upToDate = await migrate(fakeDb(0) as never)
    const db = fakeDb(upToDate)

    await migrate(db as never)

    // Re-running a migration is how a shipped schema gets corrupted; the version
    // is the only thing stopping it.
    expect(db.executed).toEqual([])
    expect(db.transactions).toBe(0)
  })

  it('runs each migration inside a transaction with its version bump', async () => {
    // A crash between the schema change and the number recording it would leave
    // the two disagreeing, and the next launch would run it again.
    const db = fakeDb(0)

    const version = await migrate(db as never)

    expect(db.transactions).toBe(version)
  })

  it('stores the library where it will not be evicted', () => {
    // A cache location is one Android may empty for space, which is correct for
    // things that can be refetched and wrong for someone's music.
    expect(DATABASE_NAME).toBe('mio-library.db')
  })

  it('opens once when two callers race on first launch', async () => {
    mockOpen.mockResolvedValue(fakeDb(0))

    const [first, second] = await Promise.all([openLibraryDb(), openLibraryDb()])

    // The promise is cached, not the handle — otherwise both callers open the
    // database and both run the migration.
    expect(mockOpen).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
  })
})

describe('a failed open does not poison the session', () => {
  it('tries again on the next call', async () => {
    // The shape that made a single unlucky moment break the library,
    // playlists and favourites until the app was restarted — with nothing
    // telling the user that restarting was the fix.
    mockOpen.mockRejectedValueOnce(new Error('database is locked'))
    mockOpen.mockResolvedValueOnce(fakeDb())

    await expect(openLibraryDb()).rejects.toThrow('database is locked')

    // Caching the promise is what makes two callers share one open; caching a
    // *rejected* one is what has to be undone.
    await expect(openLibraryDb()).resolves.toBeDefined()
    expect(mockOpen).toHaveBeenCalledTimes(2)
  })

  it('still shares one open between racing callers when it succeeds', async () => {
    mockOpen.mockResolvedValue(fakeDb())

    await Promise.all([openLibraryDb(), openLibraryDb()])

    // The reason the promise is cached at all: first launch must not run the
    // migrations twice.
    expect(mockOpen).toHaveBeenCalledTimes(1)
  })
})
