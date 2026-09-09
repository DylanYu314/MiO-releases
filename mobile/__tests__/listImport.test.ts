import {
  resetListImportGuards,
  runListImport,
  type ListImportProgress,
} from '../src/library/listImport'

/**
 * The device import loop, driven by a source that is not Google (#492).
 *
 * ## Why this exists next to `googlePlaylistImport.test.ts`
 *
 * That suite pins the loop's *behaviour* and did not change by one line when
 * the loop was lifted out of `googleImport.ts` — which is the evidence the
 * extraction changed nothing, and the only evidence worth having for a
 * refactor.
 *
 * It cannot, however, prove the loop is **generic**, because it drives it
 * through the Google adapter. A seam that still assumes YouTube would pass all
 * fourteen of those tests and fail the moment Bilibili used it. So this one
 * builds a spec out of nothing Google-shaped — arbitrary URLs, an arbitrary
 * playlist id, its own log prefix and its own progress sink — and checks the
 * four things the spec is supposed to control.
 */

const mockImportToDevice = jest.fn()
const mockAddSongs = jest.fn()
const mockFullyOnDevice = jest.fn()
const mockLocalIds = jest.fn()
const mockStartTask = jest.fn()
const mockStopTask = jest.fn()

jest.mock('../src/library/deviceImport', () => ({
  importToDevice: (...args: unknown[]) => mockImportToDevice(...args),
}))
jest.mock('../src/library/playlists', () => ({
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

/** Nothing here is a YouTube watch URL, deliberately. */
const URLS = [
  'https://www.bilibili.com/video/BV1aa',
  'https://www.bilibili.com/video/BV1bb',
  'https://www.bilibili.com/video/BV1cc',
]

/** Progress this run published, newest last. */
let published: { key: string; progress: ListImportProgress }[] = []

function spec(overrides: Partial<Parameters<typeof runListImport>[0]> = {}) {
  return {
    key: 'bilibili:fav-42',
    title: 'A folder',
    logPrefix: 'bilibiliImport',
    listUrls: async () => URLS,
    ensurePlaylist: async () => 'local-playlist-9',
    report: (key: string, progress: ListImportProgress) => published.push({ key, progress }),
    ...overrides,
  }
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick'] })
  resetListImportGuards()
  published = []

  mockImportToDevice
    .mockReset()
    .mockImplementation(async (url: string) => ({ local_id: `local-${url.slice(-2)}` }))
  mockAddSongs.mockReset().mockResolvedValue(1)
  mockFullyOnDevice.mockReset().mockResolvedValue(new Set())
  mockLocalIds.mockReset().mockResolvedValue(new Map())
  mockStartTask.mockReset().mockReturnValue('ok')
  mockStopTask.mockReset()
})

afterEach(() => {
  jest.useRealTimers()
})

/** The pace between downloads is real time, so nothing progresses without this.
 *  The microtask flush matters as much as the clock — see the Google suite. */
async function settle(iterations = 40) {
  for (let i = 0; i < iterations; i++) {
    for (let flush = 0; flush < 30; flush++) await Promise.resolve()
    jest.advanceTimersByTime(2000)
  }
}

async function run(overrides = {}) {
  const promise = runListImport(spec(overrides))
  await settle()
  return promise
}

it('fetches whatever URLs the spec hands it, with no idea what they are', async () => {
  const result = await run()

  expect(mockImportToDevice.mock.calls.map((call) => call[0])).toEqual(URLS)
  expect(result).toEqual({
    saved: 3,
    failed: 0,
    alreadyHere: 0,
    local_playlist_id: 'local-playlist-9',
  })
})

it('puts them in the playlist the spec chose, in the list order', async () => {
  await run()

  expect(mockAddSongs.mock.calls[0][0]).toBe('local-playlist-9')
  expect(mockAddSongs.mock.calls.flatMap((call) => call[1] as string[])).toEqual([
    'local-aa',
    'local-bb',
    'local-cc',
  ])
})

it('publishes progress through the spec, under the spec key', async () => {
  await run()

  expect(published.every((entry) => entry.key === 'bilibili:fav-42')).toBe(true)
  // First before any download — a long list shows its size immediately — and
  // last with the run retracted.
  expect(published[0].progress).toEqual({
    done: 0,
    total: 3,
    saved: 0,
    failed: 0,
    alreadyHere: 0,
    running: true,
  })
  expect(published[published.length - 1].progress).toEqual({
    done: 3,
    total: 3,
    saved: 3,
    failed: 0,
    alreadyHere: 0,
    running: false,
  })
})

it('names the run in the foreground notification from the spec title', async () => {
  await run()

  expect(mockStartTask).toHaveBeenCalledWith(
    expect.any(String),
    expect.stringContaining('A folder'),
  )
})

it('holds the guard per key, so two sources do not block each other', async () => {
  const first = runListImport(spec())
  // Same key: joined, not started again.
  await expect(runListImport(spec())).resolves.toBeNull()
  // Different key: its own run, even while the first is in flight.
  const other = runListImport(spec({ key: 'google:PLxyz' }))

  await settle()
  await first
  await expect(other).resolves.not.toBeNull()
})

it('releases the guard when the listing throws, so a retry is possible', async () => {
  const listUrls = jest.fn().mockRejectedValue(new Error('folder is private'))

  await expect(runListImport(spec({ listUrls }))).rejects.toThrow('folder is private')

  // Not stuck: a second attempt actually runs rather than returning null.
  await expect(run()).resolves.not.toBeNull()
})
