import AsyncStorage from '@react-native-async-storage/async-storage'

import {
  finishedImport,
  forgetFinishedImport,
  forgetFinishedImports,
  rememberFinishedImport,
} from '../src/library/finishedImports'

/**
 * The record that stops a finished import running again (#308, #311).
 *
 * Exercised against the real AsyncStorage mock and real timers, because
 * `playlistImport.test.ts` cannot: it runs on fake timers to drive the pacing
 * between tracks, and AsyncStorage resolves through the timer queue, so a real
 * read there never settles.
 */

const RESULT = {
  saved: 12,
  failed: 1,
  duplicates: 0,
  gaveUp: false,
  local_playlist_id: 'playlist-1',
}

beforeEach(async () => {
  await AsyncStorage.clear()
})

describe('remembering what an import did', () => {
  it('knows nothing about an import that has never run', async () => {
    expect(await finishedImport('5')).toBeNull()
  })

  it('remembers an import, with what it managed', async () => {
    await rememberFinishedImport('5', RESULT)

    expect(await finishedImport('5')).toMatchObject({ importId: '5', saved: 12, failed: 1 })
  })

  it('does not confuse one import with another', async () => {
    await rememberFinishedImport('5', RESULT)

    expect(await finishedImport('6')).toBeNull()
  })

  it('replaces an earlier record of the same import rather than keeping both', async () => {
    await rememberFinishedImport('5', RESULT)
    // A retry that fetched the track that failed last time. That is the truth
    // about this import now, and the old count is not.
    await rememberFinishedImport('5', { ...RESULT, saved: 13, failed: 0 })

    const record = await finishedImport('5')
    expect(record).toMatchObject({ saved: 13, failed: 0 })
    const stored: unknown[] = JSON.parse(
      (await AsyncStorage.getItem('mio-finished-imports')) ?? '[]',
    )
    expect(stored).toHaveLength(1)
  })

  it('keeps only the most recent twenty', async () => {
    for (let id = 1; id <= 25; id++) {
      await rememberFinishedImport(String(id), RESULT)
    }

    // Newest first, so the oldest fall off the end. Nobody scrolls back through
    // fifty imports, and this is a record rather than an archive.
    expect(await finishedImport('25')).not.toBeNull()
    expect(await finishedImport('1')).toBeNull()
  })

  it('survives storage holding something that is not a record', async () => {
    await AsyncStorage.setItem('mio-finished-imports', '{"not":"an array"}')

    // Treated as nothing rather than trusted: being wrong costs one repeated
    // import, and trusting a bad shape costs a screen that cannot render.
    expect(await finishedImport('5')).toBeNull()
    await expect(rememberFinishedImport('5', RESULT)).resolves.toBeUndefined()
    expect(await finishedImport('5')).not.toBeNull()
  })

  it('survives unreadable storage rather than failing the import', async () => {
    await AsyncStorage.setItem('mio-finished-imports', 'not json at all')

    expect(await finishedImport('5')).toBeNull()
  })

  it('can be cleared, which is what "import it again" means', async () => {
    await rememberFinishedImport('5', RESULT)

    await forgetFinishedImports()

    expect(await finishedImport('5')).toBeNull()
  })

  /**
   * The retry button (#370).
   *
   * The only route back to "2 of 136 failed" used to be re-creating the whole
   * import job — the server fetching the tracklist and matching all 136 again
   * to reach the same two. This record is what actually stands in the way, so
   * forgetting it *is* the retry.
   */
  it('can forget one import, which is what the retry button does', async () => {
    await rememberFinishedImport('5', RESULT)
    await rememberFinishedImport('6', RESULT)

    await forgetFinishedImport('5')

    expect(await finishedImport('5')).toBeNull()
    // And only that one: the retry is per import, and every other record is
    // what stops those imports running again on the next mount.
    expect(await finishedImport('6')).not.toBeNull()
  })

  it('says nothing about forgetting an import it never knew', async () => {
    await rememberFinishedImport('6', RESULT)

    await expect(forgetFinishedImport('5')).resolves.toBeUndefined()

    expect(await finishedImport('6')).not.toBeNull()
  })
})
