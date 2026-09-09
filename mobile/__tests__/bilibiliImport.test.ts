import { useListImportProgress } from '../src/api/listImportProgress'
import {
  bilibiliImportKey,
  importBilibiliFavOnDevice,
  resetBilibiliImportGuard,
} from '../src/library/bilibiliImport'

/**
 * Importing a Bilibili favourites folder onto the device (#492, slice 3).
 *
 * ## What is actually new here
 *
 * Almost nothing, and that is the design. The loop is `runListImport` and its
 * behaviour is pinned twice already — by `googlePlaylistImport.test.ts`
 * (unedited through the extraction) and by `listImport.test.ts` (a spec built
 * from nothing Google-shaped). Repeating "a failed track does not stop the run"
 * here would be a third copy of an assertion, which is the same mistake as a
 * third copy of the loop.
 *
 * So this covers only the three things `bilibiliImport.ts` adds:
 *
 * - the URLs come from `fetchFavList`, in folder order;
 * - the run is keyed `bilibili:<media_id>`, namespaced so a shared guard cannot
 *   confuse it with a YouTube playlist;
 * - **`skipped` is carried out of the listing** — the number that explains why
 *   a folder Bilibili calls 55 imports 52, and the one thing here that would be
 *   silently wrong if the fetch were repeated or the field dropped.
 */

const mockFetchFavList = jest.fn()
const mockImportToDevice = jest.fn()
const mockPlaylistFor = jest.fn()
const mockAddSongs = jest.fn()
const mockFullyOnDevice = jest.fn()
const mockLocalIds = jest.fn()

jest.mock('../src/library/bilibiliFav', () => ({
  fetchFavList: (...args: unknown[]) => mockFetchFavList(...args),
}))
jest.mock('../src/library/deviceImport', () => ({
  importToDevice: (...args: unknown[]) => mockImportToDevice(...args),
}))
jest.mock('../src/library/playlists', () => ({
  playlistForBilibiliFav: (...args: unknown[]) => mockPlaylistFor(...args),
  addSongsToPlaylist: (...args: unknown[]) => mockAddSongs(...args),
}))
jest.mock('../src/library/songs', () => ({
  sourcesFullyOnDevice: (...args: unknown[]) => mockFullyOnDevice(...args),
  localIdsForSources: (...args: unknown[]) => mockLocalIds(...args),
}))
jest.mock('../../mobile/modules/mio-foreground-task', () => ({
  startForegroundTask: () => 'ok',
  stopForegroundTask: () => undefined,
  isForegroundTaskRunning: () => true,
}))

const FOLDER = { mediaId: '486002245', title: 'Late night' }

/** A folder as `fetchFavList` reduces it: entries already filtered, with the
 *  count of what it dropped. */
function favList(count: number, skipped = 0) {
  return {
    mediaId: FOLDER.mediaId,
    title: FOLDER.title,
    uploader: 'An Artist',
    declaredCount: count + skipped,
    skipped,
    entries: Array.from({ length: count }, (_, index) => ({
      url: `https://www.bilibili.com/video/BV${index}`,
      bvid: `BV${index}`,
      title: `Track ${index}`,
      uploader: 'An Artist',
      durationSeconds: 200,
      coverUrl: null,
    })),
  }
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick'] })
  resetBilibiliImportGuard()
  useListImportProgress.setState({ runs: {} })

  mockFetchFavList.mockReset().mockResolvedValue(favList(3))
  mockImportToDevice
    .mockReset()
    .mockImplementation(async (url: string) => ({ local_id: `local-${url.slice(-1)}` }))
  mockPlaylistFor.mockReset().mockResolvedValue('playlist-bili')
  mockAddSongs.mockReset().mockResolvedValue(1)
  mockFullyOnDevice.mockReset().mockResolvedValue(new Set())
  mockLocalIds.mockReset().mockResolvedValue(new Map())
})

afterEach(() => {
  jest.useRealTimers()
})

/** The pace between downloads is real time. See the Google suite for why the
 *  microtask flush matters as much as the clock. */
async function settle(iterations = 40) {
  for (let i = 0; i < iterations; i++) {
    for (let flush = 0; flush < 30; flush++) await Promise.resolve()
    jest.advanceTimersByTime(2000)
  }
}

async function run() {
  const promise = importBilibiliFavOnDevice(FOLDER)
  await settle()
  return promise
}

it('fetches every entry the folder listed, in folder order', async () => {
  await run()

  expect(mockFetchFavList).toHaveBeenCalledWith('486002245')
  expect(mockImportToDevice.mock.calls.map((call) => call[0])).toEqual([
    'https://www.bilibili.com/video/BV0',
    'https://www.bilibili.com/video/BV1',
    'https://www.bilibili.com/video/BV2',
  ])
})

it('puts them in the playlist kept for this folder', async () => {
  await run()

  expect(mockPlaylistFor).toHaveBeenCalledWith('486002245', 'Late night')
  expect(mockAddSongs.mock.calls[0][0]).toBe('playlist-bili')
})

it('reports the entries the folder holds that cannot be fetched', async () => {
  // 52 fetchable of a folder Bilibili calls 55. Without this the arithmetic
  // reads as three lost songs.
  mockFetchFavList.mockResolvedValue(favList(3, 2))

  const result = await run()

  expect(result).toEqual({
    saved: 3,
    failed: 0,
    alreadyHere: 0,
    skipped: 2,
    local_playlist_id: 'playlist-bili',
  })
})

it('reads the folder once, not twice, to learn what it skipped', async () => {
  // §2.1 measured a real rate ceiling on Bilibili. A second listing call to
  // recover one number would be the easiest possible way to double the cost.
  mockFetchFavList.mockResolvedValue(favList(3, 1))

  await run()

  expect(mockFetchFavList).toHaveBeenCalledTimes(1)
})

it('publishes progress under a namespaced key', async () => {
  await run()

  const key = bilibiliImportKey('486002245')
  expect(key).toBe('bilibili:486002245')
  // Namespaced because the in-progress guard is shared with every other source
  // and a `media_id` is bare digits.
  expect(useListImportProgress.getState().runs[key]).toMatchObject({
    saved: 3,
    running: false,
  })
  expect(useListImportProgress.getState().runs['486002245']).toBeUndefined()
})

it('joins a run already going instead of starting a second pass', async () => {
  const first = importBilibiliFavOnDevice(FOLDER)

  await expect(importBilibiliFavOnDevice(FOLDER)).resolves.toBeNull()

  await settle()
  await first
  expect(mockFetchFavList).toHaveBeenCalledTimes(1)
})

it('lets a failed listing through rather than reporting an import that is not happening', async () => {
  // A dead session, or a folder that is not readable. Different from a video
  // failing, and the screen says so.
  mockFetchFavList.mockRejectedValue(new Error('not logged in'))

  await expect(importBilibiliFavOnDevice(FOLDER)).rejects.toThrow('not logged in')

  expect(useListImportProgress.getState().runs[bilibiliImportKey('486002245')]).toBeUndefined()
})
