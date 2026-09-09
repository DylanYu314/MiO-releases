import { __resetLibraryTransactions, withLibraryTransaction } from '../src/library/db'

/**
 * Two transactions must never overlap on the one shared connection (#437).
 *
 * The 2026-08-09 device pass printed this twice during a 135-track import:
 *
 *     playlistImport.trackThrew #106: cannot start a transaction within a transaction
 *     playlistImport.trackThrew  #54: cannot rollback - no transaction is active
 *
 * `openLibraryDb` hands every caller the **same** database object, and
 * `withTransactionAsync` issues `BEGIN`/`COMMIT` on it. SQLite has no nested
 * transactions, so two overlapping callers are an error rather than a wait —
 * and the second message is the first one's `COMMIT` landing after the failed
 * `BEGIN` already unwound things. One track lost per collision.
 *
 * The fake below **refuses a nested `BEGIN` the way SQLite does**, because a
 * fake that simply allows it cannot show the bug at all — the whole reason this
 * shipped is that nothing in the test suite modelled the constraint.
 */

/** A database that behaves like SQLite about nesting, and nothing else. */
function fakeDb() {
  const db = {
    inTransaction: false,
    completed: 0,
    /** Highest number of transactions open at once. Must never exceed 1. */
    peak: 0,
    withTransactionAsync: async (task: () => Promise<void>) => {
      if (db.inTransaction) throw new Error('cannot start a transaction within a transaction')
      db.inTransaction = true
      db.peak = Math.max(db.peak, 1)
      try {
        await task()
      } finally {
        db.inTransaction = false
        db.completed += 1
      }
    },
  }
  return db
}

/** A task that yields, so an unserialised caller would interleave with it. */
const yielding = async () => {
  for (let tick = 0; tick < 5; tick++) await Promise.resolve()
}

describe('transactions on the shared connection', () => {
  beforeEach(() => {
    // The queue is module state and outlives a test: without this a rejected
    // transaction from one test is the head of the next test's chain.
    __resetLibraryTransactions()
  })

  it('runs concurrent transactions one after another rather than colliding', async () => {
    const db = fakeDb()

    // Exactly the shape the import loop produces: two workers, each writing.
    await Promise.all([
      withLibraryTransaction(db, yielding),
      withLibraryTransaction(db, yielding),
      withLibraryTransaction(db, yielding),
    ])

    expect(db.completed).toBe(3)
    expect(db.peak).toBe(1)
  })

  it('lets the next transaction through after one fails', async () => {
    const db = fakeDb()

    const failed = withLibraryTransaction(db, async () => {
      throw new Error('this track is beyond help')
    })
    const after = withLibraryTransaction(db, yielding)

    await expect(failed).rejects.toThrow('this track is beyond help')
    // A failed transaction must not poison the queue behind it — the next
    // caller is a different track and has done nothing wrong.
    await expect(after).resolves.toBeUndefined()
    expect(db.completed).toBe(2)
  })

  it('the fake can actually show the bug', async () => {
    // Guards the guard. A fake that permits nesting would make both tests above
    // pass against the broken code, which is exactly how this shipped.
    const db = fakeDb()
    await db.withTransactionAsync(async () => {
      await expect(db.withTransactionAsync(async () => {})).rejects.toThrow(
        'cannot start a transaction within a transaction',
      )
    })
  })
})
