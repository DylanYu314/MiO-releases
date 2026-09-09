import { useConnection } from '../src/api/connection'
import { resetListImportProgress, useListImportProgress } from '../src/api/listImportProgress'
import { useDiagnostics } from '../src/diagnostics/log'
import {
  importGooglePlaylistOnDevice,
  resetGoogleImportGuard,
  watchUrlFor,
} from '../src/library/googleImport'

/**
 * Fetching a private YouTube playlist onto the device (#106).
 *
 * The loop itself is small, because `importToDevice` already does every
 * per-track step — that is the whole design. What is worth pinning is the four
 * things a *list* adds to a single link, and each of them has cost this project
 * a device pass on the server-import path already:
 *
 * - the playlist ends up in the playlist's order, whatever order the audio
 *   lands in;
 * - a video that fails is a video that fails, not an import that stops (#369);
 * - what is already here is skipped, counted separately, and kept out of the
 *   progress arithmetic (#398);
 * - the run's own state never lies about whether it is running.
 */

const mockFetchItems = jest.fn()
const mockImportToDevice = jest.fn()
const mockPlaylistFor = jest.fn()
const mockAddSongs = jest.fn()
const mockFullyOnDevice = jest.fn()
const mockLocalIds = jest.fn()
const mockStartTask = jest.fn()
const mockStopTask = jest.fn()

jest.mock('../src/api/google', () => ({
  fetchGooglePlaylistItems: (...args: unknown[]) => mockFetchItems(...args),
}))
jest.mock('../src/library/deviceImport', () => ({
  importToDevice: (...args: unknown[]) => mockImportToDevice(...args),
}))
jest.mock('../src/library/playlists', () => ({
  playlistForGooglePlaylist: (...args: unknown[]) => mockPlaylistFor(...args),
  addSongsToPlaylist: (...args: unknown[]) => mockAddSongs(...args),
}))
jest.mock('../src/library/songs', () => ({
  sourcesFullyOnDevice: (...args: unknown[]) => mockFullyOnDevice(...args),
  localIdsForSources: (...args: unknown[]) => mockLocalIds(...args),
}))
jest.mock('../../mobile/modules/mio-foreground-task', () => ({
  startForegroundTask: (...args: unknown[]) => mockStartTask(...args),
  stopForegroundTask: (...args: unknown[]) => mockStopTask(...args),
  isForegroundTaskRunning: () => true,
}))

// `failureKind` is deliberately **not** mocked: the retry decision is its
// `isWorthRetrying`, and a stub would make every failure retryable or none.

const PLAYLIST = { id: 'PLprivate', title: 'Late night' }

function items(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    video_id: `vid${index}`,
    title: `Track ${index}`,
    channel_title: 'An Artist',
  }))
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick'] })
  resetGoogleImportGuard()
  resetListImportProgress()
  // Module-level, and `append` drops an identical entry inside its repeat
  // window — so one test's entries make the next one's disappear.
  useDiagnostics.setState({ entries: [] })

  mockFetchItems.mockReset().mockResolvedValue(items(3))
  mockImportToDevice
    .mockReset()
    .mockImplementation(async (url: string) => ({ local_id: `local-${url.slice(-1)}` }))
  mockPlaylistFor.mockReset().mockResolvedValue('playlist-1')
  mockAddSongs.mockReset().mockResolvedValue(1)
  mockFullyOnDevice.mockReset().mockResolvedValue(new Set())
  mockLocalIds.mockReset().mockResolvedValue(new Map())
  mockStartTask.mockReset().mockReturnValue('ok')
  mockStopTask.mockReset()

  useConnection.setState({
    serverUrl: 'https://mio.test/api',
    accessKey: 'a-key',
    usingDefaultServer: true,
    loaded: true,
  })
})

afterEach(() => {
  jest.useRealTimers()
})

/**
 * Drive the run's timers until it settles.
 *
 * The pace between downloads and the retry backoff are both real time, so
 * nothing progresses without this. The inner microtask flush matters as much as
 * the clock: a retried video awaits several promises between two timers, and
 * one flush per tick leaves the chain part-way through — a run that has plainly
 * finished then reports half of what it did.
 */
async function settle(iterations = 40) {
  for (let i = 0; i < iterations; i++) {
    for (let flush = 0; flush < 30; flush++) await Promise.resolve()
    jest.advanceTimersByTime(2000)
  }
}

async function runImport(onLibraryChanged?: () => void) {
  const promise = importGooglePlaylistOnDevice(PLAYLIST, onLibraryChanged)
  await settle()
  return promise
}

/** Which local ids reached the playlist, in the order they were added. */
const addedIds = () => mockAddSongs.mock.calls.flatMap((call) => call[1] as string[])

describe('importing a private playlist onto the device', () => {
  it('fetches every video itself and puts them in a playlist', async () => {
    const result = await runImport()

    expect(mockImportToDevice).toHaveBeenCalledTimes(3)
    // The **watch** URL, which is also the library's identity for the video.
    expect(mockImportToDevice).toHaveBeenCalledWith(watchUrlFor('vid0'), { source: 'import' })
    // `source: 'import'` is what puts these in the import page's own
    // `DeviceAddList` rather than the add-link page's (#318).
    expect(result).toEqual({
      saved: 3,
      failed: 0,
      alreadyHere: 0,
      local_playlist_id: 'playlist-1',
    })
  })

  it('keeps the playlist in the playlist order, whatever order the audio lands in', async () => {
    // The first video is slow and the second is instant, which with two workers
    // is the ordinary case rather than a contrived one.
    mockImportToDevice.mockImplementation(async (url: string) => {
      if (url.endsWith('vid0')) await new Promise((resolve) => setTimeout(resolve, 5000))
      return { local_id: `local-${url.slice(-1)}` }
    })

    await runImport()

    expect(addedIds()).toEqual(['local-0', 'local-1', 'local-2'])
  })

  it('fails a video without stopping the import', async () => {
    mockImportToDevice.mockImplementation(async (url: string) => {
      if (url.endsWith('vid1')) throw new Error('Download returned no bytes')
      return { local_id: `local-${url.slice(-1)}` }
    })

    const result = await runImport()

    expect(result).toMatchObject({ saved: 2, failed: 1 })
    // And the two that worked are still in the playlist, in order, with no gap
    // left where the failed one was.
    expect(addedIds()).toEqual(['local-0', 'local-2'])
  })

  it('retries a failure that waiting could fix', async () => {
    let attempts = 0
    mockImportToDevice.mockImplementation(async (url: string) => {
      if (!url.endsWith('vid0')) return { local_id: 'other' }
      attempts += 1
      // Classified `timed_out`, which `isWorthRetrying` says yes to.
      if (attempts < 2) throw new Error('Download timed out after 300s')
      return { local_id: 'local-0' }
    })

    const result = await runImport()

    expect(attempts).toBe(2)
    expect(result).toMatchObject({ saved: 3, failed: 0 })
  })

  it('does not retry a video that is simply not available here', async () => {
    // #400: `Kvv5CpePWk0` was region-locked and every client was telling the
    // truth. Three attempts and six seconds of backoff cannot reach a video
    // that is not offered, so patience is only performed.
    const unavailable = new Error('no audio format')
    unavailable.name = 'VideoUnavailable'
    let attempts = 0
    mockImportToDevice.mockImplementation(async (url: string) => {
      if (!url.endsWith('vid0')) return { local_id: 'other' }
      attempts += 1
      throw unavailable
    })

    const result = await runImport()

    expect(attempts).toBe(1)
    expect(result).toMatchObject({ failed: 1 })
  })
})

describe('a second run over the same playlist', () => {
  it('skips what is already here, and does not count it as work', async () => {
    // Two of the three landed last time.
    mockFullyOnDevice.mockResolvedValue(new Set([watchUrlFor('vid0'), watchUrlFor('vid1')]))
    mockLocalIds.mockResolvedValue(
      new Map([
        [watchUrlFor('vid0'), 'local-0'],
        [watchUrlFor('vid1'), 'local-1'],
      ]),
    )

    const result = await runImport()

    expect(mockImportToDevice).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ saved: 1, alreadyHere: 2 })
    // The bar is about *this run's work*, so a one-video catch-up says "1 of 1"
    // rather than opening at "0 of 3" and racing (#398).
    expect(useListImportProgress.getState().runs[PLAYLIST.id]).toMatchObject({
      done: 1,
      total: 1,
      alreadyHere: 2,
    })
  })

  it('still puts the ones already here into the playlist', async () => {
    // The videos are on the device; the *playlist* may be new, and a playlist
    // missing the songs the user can see in their library is the same bug as
    // not downloading them.
    mockFullyOnDevice.mockResolvedValue(new Set([watchUrlFor('vid0')]))
    mockLocalIds.mockResolvedValue(new Map([[watchUrlFor('vid0'), 'already-here']]))

    await runImport()

    expect(addedIds()).toContain('already-here')
  })

  it('never asks the library to re-save metadata for a video it already holds', async () => {
    // `saveDeviceSongMetadata` is an UPSERT that rewrites title and artist, so
    // looking an existing row up with it would rename the user's song to the
    // raw video title on every re-import (#309's mechanism). The read-only
    // lookup is the one this loop is allowed to use.
    mockFullyOnDevice.mockResolvedValue(new Set([watchUrlFor('vid0')]))
    mockLocalIds.mockResolvedValue(new Map([[watchUrlFor('vid0'), 'already-here']]))

    await runImport()

    expect(mockLocalIds).toHaveBeenCalled()
    expect(mockImportToDevice).not.toHaveBeenCalledWith(watchUrlFor('vid0'), expect.anything())
  })
})

describe('the run as a whole', () => {
  it('turns a second start into joining the first', async () => {
    const first = importGooglePlaylistOnDevice(PLAYLIST)
    // Claimed before the first await, so this cannot slip in behind it.
    const second = importGooglePlaylistOnDevice(PLAYLIST)

    await settle()
    await first

    expect(await second).toBeNull()
    expect(mockImportToDevice).toHaveBeenCalledTimes(3)
  })

  it('asks Android not to freeze it, and lets go however it ends', async () => {
    await runImport()

    expect(mockStartTask).toHaveBeenCalled()
    expect(mockStopTask).toHaveBeenCalled()
  })

  it('lets a failed listing through rather than showing an import that is not happening', async () => {
    // The account, the key or the quota — which the screen names with
    // `googleFailure`. Nothing was published, so no screen shows a bar.
    mockFetchItems.mockRejectedValue(new Error('quota spent'))

    await expect(importGooglePlaylistOnDevice(PLAYLIST)).rejects.toThrow('quota spent')

    expect(useListImportProgress.getState().runs[PLAYLIST.id]).toBeUndefined()
    expect(mockStartTask).not.toHaveBeenCalled()
  })

  it('stops saying "running" even when the run ends by throwing', async () => {
    // A throw *after* publishing — the playlist write, the flush, the callback
    // into React Query — would otherwise leave a spinner in a store that
    // outlives the screen, for a run that is not happening.
    mockAddSongs.mockRejectedValue(new Error('NativeDatabase is closed'))

    await expect(runImport()).rejects.toThrow()

    expect(useListImportProgress.getState().runs[PLAYLIST.id]).toMatchObject({ running: false })
    expect(mockStopTask).toHaveBeenCalled()
  })

  it('does not lose songs from the playlist when one write fails and the next works', async () => {
    // SQLite transaction collisions are real on this path (#437), and a lost
    // playlist write is invisible: the songs are in the library, so nothing
    // looks wrong except a playlist that is quietly short.
    mockAddSongs
      .mockRejectedValueOnce(new Error('cannot start a transaction within a transaction'))
      .mockResolvedValue(1)

    const result = await runImport()

    expect(result).toMatchObject({ saved: 3, failed: 0 })
    expect(addedIds()).toEqual(expect.arrayContaining(['local-0', 'local-1', 'local-2']))
  })

  it('tells the caller the library changed, whether a video landed or not', async () => {
    // A row appearing and a row disappearing are the same event to a cache
    // (#411): `importToDevice` removes the row it made for a video whose audio
    // never arrived, and the library caches with `staleTime: Infinity`.
    mockImportToDevice.mockImplementation(async (url: string) => {
      if (url.endsWith('vid1')) throw new Error('Download returned no bytes')
      return { local_id: `local-${url.slice(-1)}` }
    })
    const changed = jest.fn()

    await runImport(changed)

    expect(changed).toHaveBeenCalledTimes(3)
  })
})
