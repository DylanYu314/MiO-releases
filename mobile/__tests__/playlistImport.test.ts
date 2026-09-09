import { useConnection } from '../src/api/connection'
import { useImportProgress, resetImportProgress } from '../src/api/importProgress'
import { useDiagnostics } from '../src/diagnostics/log'
import { resetTrackStates, useTrackStates } from '../src/api/trackStates'
import { importPlaylistOnDevice, resetPlaylistImportGuard } from '../src/library/playlistImport'

/**
 * Importing a reviewed playlist onto the device (#268).
 *
 * The behaviour worth pinning is the **ordering**: every accepted track gets
 * its row and its place in the playlist *before* any audio is attempted. That
 * is what I asked for — a track that cannot be fetched is not kept on the
 * server for later, but the user has to be able to see what the import
 * contained in order to go and find it by hand.
 *
 * It is also what makes the run resumable at no cost: the tracks still to fetch
 * are the rows with no file.
 */

const mockExtract = jest.fn()
const mockBilibiliExtract = jest.fn()
const mockRemoveIfEmpty = jest.fn()
const mockSaveMetadata = jest.fn()
const mockDownload = jest.fn()
const mockGetLocal = jest.fn()
const mockPlaylistFor = jest.fn()
const mockListMatches = jest.fn()
const mockAddSongs = jest.fn()
const mockSaveCover = jest.fn()
const mockSetLoudness = jest.fn()
const mockSourcesFullyOnDevice = jest.fn()
const mockFinishedImport = jest.fn()
const mockRemember = jest.fn()
const mockUpdateImport = jest.fn()

jest.mock('../src/library/extract', () => ({
  extractAudio: (...args: unknown[]) => mockExtract(...args),
  // The real class: the loop asks `instanceof` to decide whether retrying can
  // possibly help (#400), and a stubbed one would answer no to everything.
  VideoUnavailable: jest.requireActual('../src/library/extract').VideoUnavailable,
  // The real chain: since #555 the loop routes through `extractorFor`, whose
  // YouTube branch reports `CLIENT_CHAIN.length` as its attempt budget. A
  // stubbed one would silently change how many clients a track is worth.
  CLIENT_CHAIN: jest.requireActual('../src/library/extract').CLIENT_CHAIN,
}))
/**
 * The other extractor (#555).
 *
 * `platformOf` is deliberately **not** mocked: which extractor a URL routes to
 * is the thing under test, so the real matcher has to be the one deciding.
 */
jest.mock('../src/library/bilibili', () => ({
  extractBilibiliAudio: (...args: unknown[]) => mockBilibiliExtract(...args),
  reportRefusal: jest.fn(),
  sourceUrlFor: jest.requireActual('../src/library/bilibili').sourceUrlFor,
}))
jest.mock('../src/library/songs', () => ({
  // The **real** class: the loop asks `instanceof` to decide whether a client
  // refused us or merely ran out of time, and a stubbed one makes `instanceof`
  // throw inside the very catch being tested — the same trap #400 hit.
  DownloadWasShort: jest.requireActual('../src/library/songs').DownloadWasShort,
  removeSongIfEmpty: (...args: unknown[]) => mockRemoveIfEmpty(...args),
  saveDeviceSongMetadata: (...args: unknown[]) => mockSaveMetadata(...args),
  downloadAudioFromUrl: (...args: unknown[]) => mockDownload(...args),
  getLocalSong: (...args: unknown[]) => mockGetLocal(...args),
  saveCover: (...args: unknown[]) => mockSaveCover(...args),
  setSongLoudness: (...args: unknown[]) => mockSetLoudness(...args),
  sourcesFullyOnDevice: (...args: unknown[]) => mockSourcesFullyOnDevice(...args),
}))
/**
 * The durable record, mocked — for a reason worth knowing.
 *
 * These tests run on fake timers to drive the pacing between tracks, and
 * AsyncStorage's own mock resolves through the timer queue. A real read at the
 * top of the run therefore never settles and the import hangs, which looks
 * exactly like the loop being broken. `finishedImports.test.ts` exercises the
 * real thing on real timers.
 */
jest.mock('../src/library/finishedImports', () => ({
  finishedImport: (...args: unknown[]) => mockFinishedImport(...args),
  rememberFinishedImport: (...args: unknown[]) => mockRemember(...args),
}))
const mockStartTask = jest.fn()
const mockStopTask = jest.fn()
const mockTaskRunning = jest.fn()
jest.mock('../../mobile/modules/mio-foreground-task', () => ({
  startForegroundTask: (...args: unknown[]) => mockStartTask(...args),
  stopForegroundTask: (...args: unknown[]) => mockStopTask(...args),
  isForegroundTaskRunning: (...args: unknown[]) => mockTaskRunning(...args),
}))
jest.mock('../src/library/playlists', () => ({
  addSongsToPlaylist: (...args: unknown[]) => mockAddSongs(...args),
}))
/*
 * ⚠️ The **storage** is mocked, deliberately, and this is not laziness.
 *
 * Since #611 the accepted matches come from SQLite rather than from
 * `GET /playlist-imports/{id}/matches`. This suite is about the *download
 * loop* — retries, pacing, ordering, the foreground task — and driving a real
 * database through 1500 lines of it would test the loop through a second
 * subject. `playlistImportsDb.test.ts` covers the rows against real SQLite;
 * here they are fixtures, exactly as the HTTP responses were.
 */
jest.mock('../src/library/playlistImports', () => ({
  playlistForImport: (...args: unknown[]) => mockPlaylistFor(...args),
  listMatches: (...args: unknown[]) => mockListMatches(...args),
  updateImport: (...args: unknown[]) => mockUpdateImport(...args),
}))

function match(position: number, overrides: Record<string, unknown> = {}) {
  return {
    id: String(position + 1),
    position,
    title: `Track ${position}`,
    artist: 'An Artist',
    album: null,
    duration_s: 200,
    chosen_url: `https://youtu.be/track${position}`,
    status: 'accepted',
    song_id: null,
    error: null,
    ...overrides,
  }
}

/** The accepted matches this run will be given. Named as it was when they
 *  arrived over HTTP, because every caller reads the same way. */
function respondWithMatches(items: unknown[]) {
  mockListMatches.mockResolvedValue(items)
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick'] })
  resetPlaylistImportGuard()
  resetImportProgress()
  resetTrackStates()
  // Module-level, and `append` drops an identical entry inside
  // `REPEAT_WINDOW_MS` — so one test's entries make the next one's disappear.
  useDiagnostics.setState({ entries: [] })
  mockExtract.mockReset().mockResolvedValue({
    audio_url: 'https://googlevideo.example/a',
    http_headers: {},
    content_length: 4096,
    cover_url: 'https://i.ytimg.com/vi/abc/hq.jpg',
    loudness_lufs: -9.5,
  })
  // Reset like every other mock. It was not, so its calls accumulated across
  // the whole file and "was this row taken away?" could only ever be answered
  // yes — which is the assertion #309's test makes.
  mockRemoveIfEmpty.mockReset().mockResolvedValue(undefined)
  mockBilibiliExtract.mockReset().mockResolvedValue({
    audio_url: 'https://upos.example/a',
    http_headers: {},
    content_length: 4096,
    cover_url: 'https://i0.hdslb.com/bfs/archive/abc.jpg',
    loudness_lufs: -11.5,
  })
  mockStartTask.mockReset().mockReturnValue('ok')
  mockTaskRunning.mockReset().mockReturnValue(true)
  mockStopTask.mockReset()
  mockSaveCover.mockReset().mockResolvedValue(null)
  // Nothing carried over, which is a fresh import — the case most of this file
  // is about. The tests that are about a *second* run say so explicitly.
  mockSourcesFullyOnDevice.mockReset().mockResolvedValue(new Set())
  mockSetLoudness.mockReset().mockResolvedValue(undefined)
  mockFinishedImport.mockReset().mockResolvedValue(null)
  mockRemember.mockReset().mockResolvedValue(undefined)
  mockUpdateImport.mockReset().mockResolvedValue(undefined)
  mockSaveMetadata
    .mockReset()
    .mockImplementation(async (song: { title: string }) => `local-${song.title}`)
  mockDownload.mockReset().mockResolvedValue({})
  mockGetLocal.mockReset().mockResolvedValue({ file_uri: null })
  mockPlaylistFor.mockReset().mockResolvedValue('playlist-1')
  mockAddSongs.mockReset().mockResolvedValue(1)
  // `apiFetch` needs a server: the *matches* still come from it, even though
  // the audio does not.
  useConnection.setState({
    serverUrl: 'https://mio.test/api',
    accessKey: null,
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
 * Both the pause between downloads and #369's retry backoff are real time, so
 * nothing progresses without this. The inner microtask flush matters as much as
 * the clock: a retried track awaits several promises between two timers, and
 * one `await Promise.resolve()` per tick leaves the chain part-way through — a
 * run that has plainly finished then reports half of what it did.
 */
async function settle(iterations = 60) {
  for (let i = 0; i < iterations; i++) {
    for (let flush = 0; flush < 30; flush++) await Promise.resolve()
    jest.advanceTimersByTime(2000)
  }
}

/** Runs the import to completion, driving the pacing timers as it goes. */
async function runImport(iterations?: number) {
  const promise = importPlaylistOnDevice('5', 'Road Trip')
  await settle(iterations)
  return promise
}

describe('importing a reviewed playlist onto the device (#268)', () => {
  it('records every accepted track before fetching any audio', async () => {
    respondWithMatches([match(0), match(1)])

    await runImport()

    // Metadata first, from what the server already matched. A track that
    // cannot be fetched is still one the user can see they are missing.
    expect(mockSaveMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      mockDownload.mock.invocationCallOrder[0],
    )
    expect(mockSaveMetadata.mock.calls[0][0]).toMatchObject({
      title: 'Track 0',
      // The watch URL the user accepted, not a stream URL.
      source_url: 'https://youtu.be/track0',
    })
  })

  it('puts them in the playlist in the import order', async () => {
    respondWithMatches([match(1), match(0)])

    await runImport()

    // Sorted by position, not by whatever order the page happened to arrive in.
    expect(mockAddSongs.mock.calls.map(([, ids]) => ids[0])).toEqual([
      'local-Track 0',
      'local-Track 1',
    ])
  })

  it('takes the row away again when the audio cannot be fetched (#309)', async () => {
    respondWithMatches([match(0)])
    mockExtract.mockRejectedValue(new Error('No client could provide audio'))

    const result = await runImport()

    expect(result).toMatchObject({ saved: 0, failed: 1 })
    /*
     * This test used to assert the opposite, and the reversal is my
     * (#309): "one song that displays as not downloaded yet is also being added
     * in the library, it shouldn't happen if it's not downloaded."
     *
     * The row is still *written* first — it is what the download needs an id
     * for — and removed when the audio does not arrive. Nothing is lost by
     * removing it: the import's own "Failed" list is built from the server's
     * matches, not from library rows, so the track is still named, linked and
     * retryable on the page it came from.
     */
    expect(mockSaveMetadata).toHaveBeenCalled()
    expect(mockRemoveIfEmpty).toHaveBeenCalledWith('local-Track 0')
  })

  it('skips a track already on the device, which is what makes it resumable', async () => {
    respondWithMatches([match(0), match(1)])
    mockGetLocal.mockImplementation(async (id: string) =>
      id === 'local-Track 0' ? { file_uri: 'file:///a.opus' } : { file_uri: null },
    )

    const result = await runImport()

    expect(result).toMatchObject({ saved: 2, failed: 0 })
    // Only the one without a file is fetched — so a stopped run continues
    // rather than starting over.
    expect(mockDownload).toHaveBeenCalledTimes(1)
  })

  /**
   * A timestamped record per track (#371).
   *
   * The loop logged only its failures, which left the diagnostics unable to
   * answer the question they were opened for: with an import minimised for two
   * minutes and the count unmoved on return, nothing on the phone said whether
   * the downloads had continued and the UI was stale, or whether the loop had
   * stopped despite `import.foregroundTask` reporting `ok`.
   */
  it('logs each track that lands, so a backgrounded run can be measured', async () => {
    respondWithMatches([match(0), match(1)])

    await runImport()

    const done = useDiagnostics
      .getState()
      .entries.filter((entry) => entry.event === 'playlistImport.trackDone')
    expect(done).toHaveLength(2)
    // Timestamped, because the timestamps are the entire measurement — spread
    // across the gap means it kept working, clustered at the moment of return
    // means it did not.
    expect(done[0].at).toEqual(expect.any(Number))
  })

  it('names no song in the log, whatever it is recording', async () => {
    // #322 shipped song titles to the server in breach of an invariant stated
    // in two files, and #354's `scrub()` is the enforcement. A new diagnostic is
    // not a reason to do it again.
    respondWithMatches([match(0)])

    await runImport()

    const done = useDiagnostics
      .getState()
      .entries.find((entry) => entry.event === 'playlistImport.trackDone')
    expect(done?.detail ?? '').not.toContain('Track 0')
  })

  it('carries on past a single failure', async () => {
    respondWithMatches([match(0), match(1), match(2)])
    mockExtract.mockImplementation(async (url: string) => {
      if (url.endsWith('track1')) throw new Error('nope')
      return { audio_url: 'https://x', http_headers: {}, content_length: 1 }
    })

    const result = await runImport()

    // Scattered failures across a long playlist are normal; the rest should
    // still arrive.
    expect(result).toMatchObject({ saved: 2, failed: 1, gaveUp: false })
  })

  it('ignores rejected matches and ones with nothing chosen', async () => {
    respondWithMatches([match(0, { status: 'rejected' }), match(1, { chosen_url: null }), match(2)])

    const result = await runImport()

    expect(result).toMatchObject({ saved: 1 })
    expect(mockSaveMetadata).toHaveBeenCalledTimes(1)
  })

  it('joins a run already going rather than starting a second', async () => {
    respondWithMatches([match(0)])

    const first = importPlaylistOnDevice('5', 'Road Trip')
    const second = await importPlaylistOnDevice('5', 'Road Trip')

    // The guard is claimed before the first await, so returning to the screen
    // mid-run cannot start a second pass over the same tracks.
    expect(second).toBeNull()
    await settle()
    await first
  })
})

/**
 * The six faults I hit importing a 13-track playlist (#308).
 *
 * Every one of them made the flow *look* like something it was not: stuck when
 * it was working, restarting when it was finished, and empty when the songs
 * were already on the device.
 */
describe('what a 13-track import was actually doing (#308)', () => {
  it('says which step a track is on, so a slow one is not a stuck one', async () => {
    respondWithMatches([match(0), match(1)])
    const progress: unknown[] = []

    const unsubscribe = useImportProgress.subscribe((state) => {
      const update = state.runs[5]
      if (update) progress.push(update)
    })
    await runImport()
    unsubscribe()

    // The bar sat on "0 of 13" for the whole of the first track — an
    // extraction, a whole-file download and a 1500 ms pace — because progress
    // was reported once, before the work, with a 0-based index.
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ done: 0, title: 'Track 0', phase: 'extracting' }),
        expect.objectContaining({ done: 0, title: 'Track 0', phase: 'downloading' }),
        expect.objectContaining({ done: 0, title: 'Track 0', phase: 'saving' }),
        // Both tracks are in flight at once since #369, so the second one is
        // named while nothing has finished — `done` counts finished work, and
        // two started is not one done.
        expect.objectContaining({ title: 'Track 1', phase: 'extracting' }),
      ]),
    )
  })

  it('keeps the artwork and the loudness the extraction already gave it', async () => {
    respondWithMatches([match(0)])

    await runImport()

    // Both were being thrown away — which is exactly why an imported track had
    // no thumbnail while the same video added by link did, and why imported
    // tracks played without loudness normalisation.
    expect(mockSaveCover).toHaveBeenCalledWith('local-Track 0', 'https://i.ytimg.com/vi/abc/hq.jpg')
    expect(mockSetLoudness).toHaveBeenCalledWith('local-Track 0', -9.5)
  })

  it('does not write the loudness before the audio has landed', async () => {
    respondWithMatches([match(0)])

    await runImport()

    expect(mockDownload.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetLoudness.mock.invocationCallOrder[0],
    )
  })

  it('announces each track as it lands, so the library can fill in live', async () => {
    respondWithMatches([match(0), match(1)])
    const saved: string[] = []

    const promise = importPlaylistOnDevice('5', 'Road Trip', (id: string) => saved.push(id))
    await settle()
    await promise

    // Nothing invalidated any query, ever, and the library caches with
    // `staleTime: Infinity` — which is why thirteen imported songs were nowhere
    // to be seen until the app restarted.
    expect(saved).toEqual(['local-Track 0', 'local-Track 1'])
  })

  it('records that it finished, so reopening does not run it again', async () => {
    respondWithMatches([match(0)])

    await runImport()

    expect(mockRemember).toHaveBeenCalledWith(
      '5',
      expect.objectContaining({ saved: 1, failed: 0 }),
      // The third argument is #452's per-track reasons — empty here, because
      // nothing failed.
      {},
    )
  })

  it('marks the import row done, which the server used to do (#655)', async () => {
    /*
     * #611 removed the server without replacing this write, so a confirmed
     * import stayed `importing` forever: the header read "Downloading" long
     * after the run had ended and `isImportTerminal` reported a finished import
     * as still going, on the list screen too.
     */
    respondWithMatches([match(0), match(1)])

    await runImport()

    expect(mockUpdateImport).toHaveBeenCalledWith('5', {
      status: 'done',
      imported_count: 2,
      failed_count: 0,
    })
  })

  it('carries the failure count into the row, not just the summary (#655)', async () => {
    // The other edge: a run where nothing landed still finishes, and the row
    // has to say so rather than reporting two imported tracks.
    respondWithMatches([match(0)])
    mockExtract.mockRejectedValue(new Error('nope'))

    await runImport()

    expect(mockUpdateImport).toHaveBeenCalledWith('5', {
      status: 'done',
      imported_count: 0,
      failed_count: 1,
    })
  })

  it('reports the remembered outcome instead of re-running the loop', async () => {
    respondWithMatches([match(0)])
    mockFinishedImport.mockResolvedValue({
      importId: 5,
      saved: 13,
      failed: 0,
      gaveUp: false,
      local_playlist_id: 'playlist-1',
      finishedAt: '2026-08-05T00:00:00Z',
    })
    const progress: { done: number; total: number }[] = []

    const unsubscribe = useImportProgress.subscribe((state) => {
      const update = state.runs[5]
      if (update) progress.push(update as unknown as { done: number; total: number })
    })
    const result = await importPlaylistOnDevice('5', 'Road Trip')
    unsubscribe()

    // "Every time I open this record it reloads 0/13 → 13/13." It re-paged
    // every match and re-added every playlist row in a fraction of a second,
    // which is fast enough to look like a fresh import and slow enough to see.
    expect(result).toMatchObject({ saved: 13 })
    expect(mockSaveMetadata).not.toHaveBeenCalled()
    expect(mockAddSongs).not.toHaveBeenCalled()
    expect(progress).toEqual([expect.objectContaining({ done: 13, total: 13 })])
  })
})

/**
 * An import that survives a bad track (#369).
 *
 * Three faults, all read out of the file rather than guessed: no retry at all,
 * a five-in-a-row limit that abandoned the whole playlist, and one download at
 * a time. What I read as an automatic re-download was none of them — it was
 * the loop resuming after Android suspended it.
 */
describe('an import that survives a bad track (#369)', () => {
  it('tries a track again rather than losing it to one bad moment', async () => {
    respondWithMatches([match(0)])
    // Fails once, then works — which is what almost every real failure is.
    mockExtract.mockRejectedValueOnce(new Error('connection reset'))

    const result = await runImport()

    expect(result).toMatchObject({ saved: 1, failed: 0 })
    expect(mockExtract).toHaveBeenCalledTimes(2)
    // And the row survives with it: the old `catch` removed it on the first
    // failure, which is how a transient error cost a track permanently.
    expect(mockRemoveIfEmpty).not.toHaveBeenCalled()
  })

  it('retires the client whose stream URL was refused, not the whole track', async () => {
    respondWithMatches([match(0)])
    mockExtract.mockResolvedValue({
      audio_url: 'https://googlevideo.example/a',
      http_headers: {},
      content_length: 4096,
      client: 'ANDROID_VR',
    })
    mockDownload.mockRejectedValueOnce(new Error('Download refused with status 403 at byte 0'))

    const result = await runImport()

    expect(result).toMatchObject({ saved: 1, failed: 0 })
    // A URL that 403s is as useless as no URL, so the second attempt has to ask
    // a *different* client — asking the same one again would retry the refusal.
    expect(mockExtract).toHaveBeenLastCalledWith('https://youtu.be/track0', {
      exclude: ['ANDROID_VR'],
    })
  })

  /**
   * The one failure retrying cannot help (#400).
   *
   * `Kvv5CpePWk0` was attempted three times, with backoff, against a video
   * whose `availableCountries` are AT, CH and DE. Patience was never going to
   * reach it.
   */
  it('stops immediately when YouTube says the video will not play', async () => {
    respondWithMatches([match(0)])
    const { VideoUnavailable } = jest.requireActual('../src/library/extract')
    mockExtract.mockRejectedValue(new VideoUnavailable('gone', 'UNPLAYABLE'))

    const result = await runImport()

    // One attempt, not three: the answer cannot change, and two more rounds of
    // doubling backoff are six seconds of performed patience per track.
    expect(mockExtract).toHaveBeenCalledTimes(1)
    expect(result?.failed).toBe(1)
  })

  /**
   * A row disappearing is a change too (2026-08-10 device pass).
   *
   * The callback fired only where a track succeeded, so the rows this loop
   * *deletes* — created for a track whose audio never arrived — went from SQLite
   * and stayed in a React Query cache that holds `staleTime: Infinity`. I
   * kept finding a failed track sitting in my library, and tapping it produced
   * a permanent error about a video that no longer exists.
   */
  it('tells the caller to refresh when a failed track is removed', async () => {
    respondWithMatches([match(0)])
    const { VideoUnavailable } = jest.requireActual('../src/library/extract')
    mockExtract.mockRejectedValue(new VideoUnavailable('gone', 'UNPLAYABLE'))
    const changed = jest.fn()

    const promise = importPlaylistOnDevice('5', 'Road Trip', changed)
    await settle()
    await promise

    expect(mockRemoveIfEmpty).toHaveBeenCalledWith('local-Track 0')
    // The id of the row that went, so a caller could scope the invalidation.
    expect(changed).toHaveBeenCalledWith('local-Track 0')
  })

  it('gives up on the track after a bounded number of attempts, never sooner', async () => {
    respondWithMatches([match(0)])
    mockExtract.mockRejectedValue(new Error('gone'))

    const result = await runImport()

    // Three, and then it is that track's problem rather than the import's.
    expect(mockExtract).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ saved: 0, failed: 1 })
  })

  it('finishes the whole playlist however many tracks fail', async () => {
    // Twenty, of which the first six fail — well past the old limit of five.
    respondWithMatches(Array.from({ length: 20 }, (_, i) => match(i)))
    mockExtract.mockImplementation(async (url: string) => {
      if (/track[0-5]$/.test(url)) throw new Error('refused')
      return { audio_url: 'https://x', http_headers: {}, content_length: 1 }
    })

    const result = await runImport(200)

    /*
     * The freeze I watched for three minutes was
     * `CONSECUTIVE_FAILURE_LIMIT = 5` abandoning the import. Six bad tracks is
     * a reason to give up on six tracks, not on the other fourteen — and the
     * number was one somebody picked, which is the deeper reason it is gone.
     */
    expect(result).toMatchObject({ saved: 14, failed: 6, gaveUp: false })
  })

  it('never records a run as having given up', async () => {
    respondWithMatches([match(0), match(1), match(2), match(3), match(4), match(5)])
    mockExtract.mockRejectedValue(new Error('refused'))

    await runImport(120)

    expect(mockRemember).toHaveBeenCalledWith(
      '5',
      expect.objectContaining({ gaveUp: false }),
      // Six failed tracks, each with a reason recorded against its URL (#452).
      expect.any(Object),
    )
  })

  it('downloads two at a time, but starts them no faster than it ever did', async () => {
    respondWithMatches([match(0), match(1), match(2), match(3)])
    let inFlight = 0
    let peak = 0
    mockDownload.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      // Long enough that a second download must overlap it to be concurrent.
      await new Promise((resolve) => setTimeout(resolve, 5000))
      inFlight -= 1
    })

    const result = await runImport()

    expect(result).toMatchObject({ saved: 4 })
    // Two, and deliberately not more: above that the progress line cannot name
    // the track in hand honestly.
    expect(peak).toBe(2)
  })

  it('keeps the playlist in import order even when the earlier row is slower to write', async () => {
    respondWithMatches([match(0), match(1)])
    /*
     * Track 0's row takes longer to write than track 1's.
     *
     * This is the scenario, and getting it wrong is what made an earlier
     * version of this test worthless: with every mock resolving in the same
     * microtask the two workers finish in the order they started whether
     * anything serialises them or not, so it passed with the ordering removed.
     * SQLite does not answer in a fixed time, and two tracks in flight is new
     * since #369 — a playlist whose songs come out shuffled is what that costs
     * if nothing holds the order.
     */
    mockSaveMetadata.mockImplementation(async (song: { title: string }) => {
      if (song.title === 'Track 0') await new Promise((resolve) => setTimeout(resolve, 3000))
      return `local-${song.title}`
    })

    await runImport()

    expect(mockAddSongs.mock.calls.map(([, ids]) => ids[0])).toEqual([
      'local-Track 0',
      'local-Track 1',
    ])
  })
})

/**
 * Showing what the import is actually doing (#370).
 *
 * "I look at the progress bar stuck and I don't know what's going on."
 */
describe('what the import says about itself (#370)', () => {
  it('counts tracks fetched, not the position in the list', async () => {
    respondWithMatches([match(0), match(1), match(2), match(3)])
    // Two of them are already here — a resumed run, which is the case that
    // read as a restart.
    mockSourcesFullyOnDevice.mockResolvedValue(
      new Set(['https://youtu.be/track0', 'https://youtu.be/track1']),
    )
    mockGetLocal.mockImplementation(async (id: string) =>
      id === 'local-Track 0' || id === 'local-Track 1'
        ? { file_uri: 'file:///a.opus', cover_uri: 'file:///a.jpg' }
        : { file_uri: null },
    )
    const progress: { done: number; total: number }[] = []
    const unsubscribe = useImportProgress.subscribe((state) => {
      const update = state.runs[5]
      if (update) progress.push(update as unknown as (typeof progress)[number])
    })

    await runImport()
    unsubscribe()

    /*
     * `done: index` was the whole of investigation 4. A resumed run honestly
     * walks from position 0 again, skipping everything on disk, so the bar
     * honestly showed 0 — and I read it as 136 tracks being downloaded a
     * second time. Nothing was ever re-downloaded.
     *
     * The list index reaches 3 here, so a bar still publishing it would break
     * the ceiling below even though only two tracks are ever fetched.
     */
    expect(progress.every((update) => update.done <= 2)).toBe(true)
    expect(progress.at(-1)).toMatchObject({ done: 2, total: 2 })
  })

  /**
   * Why a 56-track import makes a 55-track playlist (from the 2026-08-09 pass).
   *
   * I counted it as a lost track. Nothing was lost: two accepted matches
   * pointed at the same video, `songs.source_url` is UNIQUE since v6, and
   * `addSongsToPlaylist` skips a song the playlist already holds — so one video
   * is one song. The device was right and said nothing, which is the
   * combination this iteration exists to remove.
   */
  it('counts two matches on one video as a duplicate, not a loss', async () => {
    // Two tracks, one video: what the matcher does when a playlist holds a
    // single and its album version.
    respondWithMatches([match(0), match(1, { chosen_url: 'https://youtu.be/track0' })])
    mockSaveMetadata.mockImplementation(async (song: { source_url: string }) =>
      song.source_url === 'https://youtu.be/track0' ? 'local-shared' : 'local-other',
    )
    // The second add finds the song already in the playlist and skips it, which
    // is what the real `addSongsToPlaylist` returns 0 for.
    mockAddSongs.mockImplementation(async () => (mockAddSongs.mock.calls.length === 1 ? 1 : 0))

    const result = await runImport()

    expect(result?.duplicates).toBe(1)
    // Still saved: the audio is on the device, as one song, which is what one
    // video is. The playlist is one shorter and now has a reason.
    expect(result?.saved).toBe(2)
  })

  it('reports nothing about duplicates when there are none', async () => {
    // Or the line explaining a shorter playlist appears on every import that
    // never had one, which is a different lie.
    respondWithMatches([match(0), match(1)])

    const result = await runImport()

    expect(result?.duplicates).toBe(0)
  })

  it('says how many tracks it had nothing to do for', async () => {
    respondWithMatches([match(0), match(1), match(2)])
    mockSourcesFullyOnDevice.mockResolvedValue(new Set(['https://youtu.be/track0']))
    mockGetLocal.mockImplementation(async (id: string) =>
      id === 'local-Track 0'
        ? { file_uri: 'file:///a.opus', cover_uri: 'file:///a.jpg' }
        : { file_uri: null },
    )
    const progress: { total: number; alreadyHere: number }[] = []
    const unsubscribe = useImportProgress.subscribe((state) => {
      const update = state.runs[5]
      if (update) progress.push(update as unknown as (typeof progress)[number])
    })

    await runImport()
    unsubscribe()

    // The bar counts this run's work; this is the rest of the playlist, so the
    // two numbers can be reconciled instead of merely disagreeing.
    //
    // Asserted **during** the run as well as at the end, and that is the test:
    // the loop publishes from three places and the last one is its own literal,
    // so an assertion on the final update alone passes while the line is absent
    // for the whole import. #389 shipped exactly that mistake once already.
    expect(progress.slice(0, -1)).toEqual(
      expect.arrayContaining([expect.objectContaining({ total: 2, alreadyHere: 1 })]),
    )
    expect(progress.at(-1)).toMatchObject({ total: 2, alreadyHere: 1 })
  })

  /**
   * A retry counts the retry (#398), from the 2026-08-08 device pass.
   *
   * *"there is a button 'try the 1 track that failed' allow me to
   * redownload, but somehow when i pressed it, the counter started from 0 again,
   * seems like re-downloading the whole list"*. He could not tell — and on
   * mobile data the difference is an hour of traffic.
   */
  it('counts only the work a retry actually has, not the whole playlist', async () => {
    respondWithMatches([match(0), match(1), match(2), match(3)])
    // Three landed the first time; the fourth is what the button is for.
    mockSourcesFullyOnDevice.mockResolvedValue(
      new Set(['https://youtu.be/track0', 'https://youtu.be/track1', 'https://youtu.be/track2']),
    )
    mockGetLocal.mockImplementation(async (id: string) =>
      id === 'local-Track 3'
        ? { file_uri: null }
        : { file_uri: 'file:///a.opus', cover_uri: 'file:///a.jpg' },
    )
    const progress: { done: number; total: number }[] = []
    const unsubscribe = useImportProgress.subscribe((state) => {
      const update = state.runs[5]
      if (update) progress.push(update as unknown as (typeof progress)[number])
    })

    const result = await runImport()
    unsubscribe()

    // "0 of 1", then "1 of 1". Never "0 of 4", which is also what re-fetching
    // the whole list would look like.
    expect(progress.every((update) => update.total === 1)).toBe(true)
    // And never above it while it runs: the three tracks it walks past are not
    // work done, they are work that was never in this run.
    expect(progress.every((update) => update.done <= 1)).toBe(true)
    expect(progress.at(-1)?.done).toBe(1)
    // And exactly one download happened, which is the claim behind the number.
    expect(mockDownload).toHaveBeenCalledTimes(1)
    // The *summary* is still about the playlist: four tracks are on the device.
    expect(result?.saved).toBe(4)
  })

  it('says a track is being retried, so slow does not read as stuck', async () => {
    respondWithMatches([match(0)])
    mockExtract.mockRejectedValueOnce(new Error('connection reset'))
    const phases: { phase: string; attempt: number; title: string }[] = []
    const unsubscribe = useImportProgress.subscribe((state) => {
      const update = state.runs[5]
      if (update)
        phases.push(update as unknown as { phase: string; attempt: number; title: string })
    })

    await runImport()
    unsubscribe()

    // Published *before* the backoff is waited out, or the two seconds are a
    // gap in the bar rather than an explanation of one.
    expect(phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'retrying',
          attempt: 2,
          alreadyHere: 0,
          title: 'Track 0',
        }),
      ]),
    )
  })

  it('counts failures while it runs, rather than only in the summary', async () => {
    respondWithMatches([match(0), match(1)])
    // Persistently, so it is a failure rather than a retry that succeeds.
    mockExtract.mockImplementation(async (url: string) => {
      if (url.endsWith('track0')) throw new Error('refused')
      return { audio_url: 'https://x', http_headers: {}, content_length: 1 }
    })
    const progress: { failed: number }[] = []

    const unsubscribe = useImportProgress.subscribe((state) => {
      const update = state.runs[5]
      if (update) progress.push(update as unknown as { failed: number })
    })
    await runImport()
    unsubscribe()

    expect(progress.at(-1)?.failed).toBe(1)
  })

  it('counts a track that failed as finished, not as still to come', async () => {
    // Both fail, so nothing is ever saved: the only thing that can move `done`
    // is a failure being counted as work completed.
    respondWithMatches([match(0), match(1)])
    mockExtract.mockRejectedValue(new Error('refused'))
    const progress: { done: number; saved: number; failed: number }[] = []
    const unsubscribe = useImportProgress.subscribe((state) => {
      const update = state.runs[5]
      if (update) progress.push(update as unknown as (typeof progress)[number])
    })

    await runImport()
    unsubscribe()

    /*
     * Asserted *during* the run rather than at the end, and that distinction is
     * the test. The last publish sets `done` to the list length outright, so a
     * `done` that counted only successes would still finish on 2 of 2 and look
     * perfectly correct — while the bar hung at 0 for the entire import.
     */
    expect(progress.slice(0, -1)).toEqual(
      expect.arrayContaining([expect.objectContaining({ done: 1, saved: 0, failed: 1 })]),
    )
  })
})

/**
 * What a second screen sees, and what an already-downloaded track is missing.
 *
 * Both reported after #333 shipped: the page showed a frozen "0 of 13" when
 * re-entered mid-run, and tracks imported before covers were kept never got
 * one however many times the import was reopened.
 */
describe('joining a run in progress, and filling in what is missing', () => {
  it('publishes progress where any screen can read it, not just the one that started it', async () => {
    respondWithMatches([match(0), match(1)])

    const promise = importPlaylistOnDevice('5', 'Road Trip')
    await settle()
    await promise

    // A screen mounting now reads this rather than waiting for a callback it
    // was never given: the in-progress guard turns a second caller away at the
    // door, so its callback would be wired to nothing.
    expect(useImportProgress.getState().runs[5]).toMatchObject({ done: 2, total: 2 })
  })

  it('fetches a cover for a track that already has audio but no artwork', async () => {
    respondWithMatches([match(0)])
    // Downloaded by an earlier run, before covers were kept.
    mockGetLocal.mockResolvedValue({ file_uri: 'file:///a.opus', cover_uri: null })

    await runImport()

    // Re-importing cannot fix this on its own: this is exactly the branch a
    // re-import takes, and it used to `continue` straight past the artwork.
    expect(mockSaveCover).toHaveBeenCalledWith('local-Track 0', 'https://i.ytimg.com/vi/abc/hq.jpg')
    // And it does not download the audio again.
    expect(mockDownload).not.toHaveBeenCalled()
  })

  it('leaves a track that already has its artwork completely alone', async () => {
    respondWithMatches([match(0)])
    mockGetLocal.mockResolvedValue({ file_uri: 'file:///a.opus', cover_uri: 'file:///a.jpg' })

    await runImport()

    // A healthy library must cost nothing to reopen — one extraction per track
    // would make revisiting a finished import as slow as running it.
    expect(mockExtract).not.toHaveBeenCalled()
    expect(mockSaveCover).not.toHaveBeenCalled()
  })

  it('keeps the track when the cover cannot be fetched', async () => {
    respondWithMatches([match(0)])
    mockGetLocal.mockResolvedValue({ file_uri: 'file:///a.opus', cover_uri: null })
    mockExtract.mockRejectedValue(new Error('refused'))

    const result = await runImport()

    // A picture is not worth failing a track whose audio is already here.
    expect(result).toMatchObject({ saved: 1, failed: 0 })
  })
})

/**
 * Asking Android not to freeze the run (#371, ADR-019).
 *
 * The loop stays in JavaScript. What it lacked was not a place to run but
 * permission to keep running: a minimised app with no foreground service is a
 * frozen process, which is the whole of bug 5 — and of the "restart" and the
 * "automatic retry" that were really this run being stopped and resumed.
 */
describe('holding a foreground service for the run (#371)', () => {
  it('holds one for the length of the import', async () => {
    respondWithMatches([match(0)])

    await runImport()

    expect(mockStartTask).toHaveBeenCalledTimes(1)
    expect(mockStopTask).toHaveBeenCalledTimes(1)
    // Started before the work and released after it, or it protects nothing.
    expect(mockStartTask.mock.invocationCallOrder[0]).toBeLessThan(
      mockDownload.mock.invocationCallOrder[0],
    )
    expect(mockStopTask.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockDownload.mock.invocationCallOrder[0],
    )
  })

  it('releases it when the run throws rather than finishes', async () => {
    // The matches cannot be read, so the run ends by throwing.
    mockListMatches.mockRejectedValue(new Error('the library is unreachable'))

    await expect(runImport()).rejects.toThrow('unreachable')

    // A notification for an import that ended is exactly the kind of surface
    // that lies, and this one would never go away.
    expect(mockStopTask).toHaveBeenCalled()
  })

  it('does not claim one for a run that has nothing to do', async () => {
    respondWithMatches([match(0)])
    mockFinishedImport.mockResolvedValue({
      importId: 5,
      saved: 13,
      failed: 0,
      gaveUp: false,
      local_playlist_id: 'playlist-1',
      finishedAt: '2026-08-05T00:00:00Z',
    })

    await runImport()

    // This branch returns in milliseconds from a record on disk. A foreground
    // notification for it would be the shortest-lived lie in the app.
    expect(mockStartTask).not.toHaveBeenCalled()
    // Released anyway: `stop` on a service that was never started is a no-op,
    // and that is what lets the release live in one `finally` instead of on
    // every path out.
    expect(mockStopTask).toHaveBeenCalled()
  })

  it('imports anyway when Android refuses the service', async () => {
    respondWithMatches([match(0)])
    mockStartTask.mockReturnValue('not_allowed_from_background')

    const result = await runImport()

    // The import is not the notification's dependant. Without the service the
    // run is merely interruptible, which is where it already was.
    expect(result).toMatchObject({ saved: 1, failed: 0 })
  })
})

/**
 * What actually stopped the 134-track import (2026-08-09 device pass).
 *
 * I watched the bar freeze at 45 of 134, the failed list stop growing, and
 * no retry button appear — and then, a dozen minutes later, found the playlist
 * complete but for two tracks. Nothing restarted it. It had never stopped.
 *
 * `handle` was awaited bare inside the worker pool, and only its *download* is
 * guarded: `fetchAudio` catches extraction and download errors and returns
 * false. Everything else throws through — the two SQLite writes inside
 * `inOrder`, `getLocalSong`, `removeSongIfEmpty`, and `onLibraryChanged`, which
 * calls into React Query. When one did, `Promise.all` rejected without
 * cancelling the sibling worker, so the run *reported* failure while a second
 * worker quietly finished the list, `rememberFinishedImport` was skipped, and
 * the `finally` released the in-progress guard underneath a run still going.
 */
describe('one bad track must not take the run with it (2026-08-09)', () => {
  it('fails the track whose row cannot be written, and finishes the rest', async () => {
    respondWithMatches([match(0), match(1), match(2)])
    mockSaveMetadata.mockImplementation(async (song: { title: string }) => {
      if (song.title === 'Track 1') throw new Error('database is locked')
      return `local-${song.title}`
    })

    const result = await runImport()

    // The run *completes* — this is the whole finding. It used to reject here,
    // which is what froze the bar while the other worker carried on.
    expect(result).toMatchObject({ saved: 2, failed: 1 })
    // And the record is written, so the screen reaches a terminal state and can
    // offer the retry button that never appeared.
    expect(mockRemember).toHaveBeenCalled()
  })

  it('names the throw in the log, since nothing else can explain it', async () => {
    respondWithMatches([match(0), match(1)])
    mockSaveMetadata.mockImplementation(async (song: { title: string }) => {
      if (song.title === 'Track 1') throw new Error('database is locked')
      return `local-${song.title}`
    })

    await runImport()

    const threw = useDiagnostics
      .getState()
      .entries.find((entry) => entry.event === 'playlistImport.trackThrew')
    // The position and the reason. `downloadRefused` is an expected failure
    // with a known shape; this is the opposite, and the log has to say which.
    expect(threw?.detail).toContain('#1')
    expect(threw?.detail).toContain('database is locked')
    // The position, never the title (#322, #354).
    expect(threw?.detail).not.toContain('Track 1')
  })

  /**
   * The consequence that costs bandwidth rather than just clarity.
   *
   * A worker throwing used to reject `Promise.all` without cancelling its
   * sibling, and the `finally` then released the in-progress guard while that
   * sibling was still downloading. Re-entering the screen — which I did,
   * repeatedly, because the bar had frozen — therefore started a **second**
   * concurrent pass over the same tracks.
   *
   * The download *count* cannot see this: the cursor is shared, so a surviving
   * worker picks up everything the dead one would have taken and the total is
   * identical either way. The guard is the observable.
   */
  it('refuses a second run while a worker is still going, even after a throw', async () => {
    respondWithMatches([match(0), match(1), match(2), match(3)])
    mockSaveMetadata.mockImplementation(async (song: { title: string }) => {
      if (song.title === 'Track 0') throw new Error('database is locked')
      return `local-${song.title}`
    })
    // Long enough that the run is unambiguously still in flight below.
    mockDownload.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 30_000)),
    )

    const promise = importPlaylistOnDevice('5', 'Road Trip')
    // Far enough in for track 0 to have thrown, nowhere near the end.
    await settle(2)
    const second = await importPlaylistOnDevice('5', 'Road Trip')

    // Null means "there is already a run" — the guard is still held.
    expect(second).toBeNull()
    await settle()
    await promise
    // And released exactly once, when every worker had actually stopped.
    expect(mockStopTask).toHaveBeenCalledTimes(1)
  })
})

/**
 * Saying how long things took, and that the run is still alive.
 *
 * Every line this file logged was written when something *finished*, so a
 * silence was ambiguous in the way that has cost this iteration most: an import
 * that has stopped prints nothing, and an import grinding through three
 * five-minute download timeouts also prints nothing. They need opposite fixes.
 */
describe('an import that says how long it is taking (2026-08-09)', () => {
  it('records how long a refused download took before it gave up', async () => {
    respondWithMatches([match(0)])
    mockExtract.mockResolvedValue({
      audio_url: 'https://googlevideo.example/a',
      http_headers: {},
      content_length: 4096,
      client: 'ANDROID_VR',
    })
    mockDownload.mockRejectedValue(new Error('Download refused with status 403 at byte 0'))

    await runImport()

    const refused = useDiagnostics
      .getState()
      .entries.find((entry) => entry.event === 'playlistImport.downloadRefused')
    // An instant 403 and a five-minute timeout printed the same line, and the
    // difference between them is the whole of "why did it stop for a dozen
    // minutes".
    expect(refused?.detail).toMatch(/after \d+\.\d+s/)
  })

  it('beats while a slow download is in flight, so a gap means it stopped', async () => {
    respondWithMatches([match(0)])
    // Longer than the heartbeat by several multiples: this is the case the beat
    // exists for — real work in progress and nothing finishing to log.
    mockDownload.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 90_000)),
    )

    await runImport()

    const beats = useDiagnostics
      .getState()
      .entries.filter((entry) => entry.event === 'playlistImport.alive')
    expect(beats.length).toBeGreaterThan(1)
    // What the beat has to carry: where the run is, and whether the process is
    // being scheduled at all while backgrounded.
    // `done=`, because `45/136` was read as *track #45* and cost a paragraph of
    // analysis chasing a track that had no log line of its own (#457).
    expect(beats[0].detail).toMatch(/done=0\/1 phase=downloading attempt=1 stuck=\d+\.\d+s/)
    expect(beats[0].detail).toContain('state=')
    // The ambiguity itself, pinned: a counter that could be mistaken for the
    // position `trackDone` prints must not appear unlabelled.
    expect(beats[0].detail).not.toMatch(/(^|\s)\d+\/\d+/)
  })

  it('stops beating when the run does', async () => {
    respondWithMatches([match(0)])

    await runImport()
    const afterRun = useDiagnostics
      .getState()
      .entries.filter((entry) => entry.event === 'playlistImport.alive').length
    // Well past several more intervals. An uncancelled beat is a leak whether
    // or not a test catches it.
    jest.advanceTimersByTime(120_000)

    expect(
      useDiagnostics.getState().entries.filter((entry) => entry.event === 'playlistImport.alive'),
    ).toHaveLength(afterRun)
  })
})

/**
 * A foreground-service reading that can answer either way (#432).
 *
 * `import.foregroundTask … running=false` was sampled on the statement after an
 * **asynchronous** `startForegroundService`, so `false` is what a healthy phone
 * printed too. It was read as a finding for a day. An instrument that cannot
 * produce the other answer has measured nothing.
 */
describe('reading the foreground service late enough to mean something', () => {
  it('reports whether the service is running, after it has had time to start', async () => {
    respondWithMatches([match(0)])
    // Long enough that the run outlives the delayed read. That is not a test
    // convenience: the read is cancelled when the run ends, because a service
    // reading for an import that is already over answers nothing. A real
    // 134-track import runs for minutes.
    mockDownload.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 30_000)),
    )
    // False at the moment of the request — which is the real sequence — and
    // true once the main looper has run `startForeground`.
    mockTaskRunning.mockReturnValue(false)
    const promise = importPlaylistOnDevice('5', 'Road Trip')
    // Far enough in for the service to have been requested, nowhere near the
    // delayed read at two seconds — `settle` advances in 2 s steps, which would
    // fire the read before the service had "started".
    for (let flush = 0; flush < 30; flush++) await Promise.resolve()
    jest.advanceTimersByTime(500)
    mockTaskRunning.mockReturnValue(true)
    await settle()
    await promise

    const settled = useDiagnostics
      .getState()
      .entries.find((entry) => entry.event === 'import.foregroundTask.settled')
    // The whole point: `true` is reachable. The old line could only ever say
    // `false`, whatever the service did.
    expect(settled?.detail).toBe('running=true')
  })

  it('can still say false, so a real failure is not hidden', async () => {
    respondWithMatches([match(0)])
    mockDownload.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 30_000)),
    )
    mockTaskRunning.mockReturnValue(false)

    await runImport()

    const settled = useDiagnostics
      .getState()
      .entries.find((entry) => entry.event === 'import.foregroundTask.settled')
    expect(settled?.detail).toBe('running=false')
  })

  it('does not leave the reading scheduled after the run ends', async () => {
    respondWithMatches([match(0)])

    // Finished **without advancing the clock**: a one-track run needs only
    // microtasks, so at this point the two-second read has not come due. That
    // ordering is the whole test — a timer that fires at most once cannot show
    // a missing `clearTimeout` if the run outlives it.
    const promise = importPlaylistOnDevice('5', 'Road Trip')
    for (let flush = 0; flush < 60; flush++) await Promise.resolve()
    await promise

    jest.advanceTimersByTime(60_000)

    // An uncancelled timer that logs is a leak whether or not a test catches
    // it — #396's probe shipped exactly that shape and failed CI with every
    // test passing.
    expect(
      useDiagnostics
        .getState()
        .entries.filter((entry) => entry.event === 'import.foregroundTask.settled'),
    ).toHaveLength(0)
  })
})

/**
 * A slow client is not a refusing client (#439).
 *
 * Four long tracks failed on 2026-08-09 like this:
 *
 *     attempt 1 via ANDROID_VR after 300.1s: Download was short: 10764208 of 14587885
 *     attempt 2 via IOS        after   0.2s: Download refused with status 403 at byte 0
 *     attempt 3 via TV_SIMPLY  after   0.1s: Download refused with status 403 at byte 0
 *
 * 10764208 bytes in 300.1 s is 35.9 kB/s, and the track needed about 407 s —
 * so it was downloading perfectly well and was cut off at three quarters. Then
 * the client that had just delivered ten megabytes was **retired for being
 * slow**, and the retries went to clients that had already refused.
 */
describe('a client that ran out of time, rather than refusing', () => {
  const short = () =>
    new (jest.requireActual('../src/library/songs').DownloadWasShort)(
      10_764_208,
      14_587_885,
      300_100,
    )

  it('asks the same client again instead of retiring it', async () => {
    respondWithMatches([match(0)])
    mockExtract.mockResolvedValue({
      audio_url: 'https://googlevideo.example/a',
      http_headers: {},
      content_length: 14_587_885,
      client: 'ANDROID_VR',
    })
    mockDownload.mockRejectedValueOnce(short())

    const result = await runImport()

    expect(result).toMatchObject({ saved: 1, failed: 0 })
    // Not excluded. Retiring is for a client whose URL is refused; this one is
    // the only one serving us at all.
    expect(mockExtract).toHaveBeenLastCalledWith('https://youtu.be/track0', { exclude: [] })
  })

  it('still retires a client that refused at byte 0', async () => {
    respondWithMatches([match(0)])
    mockExtract.mockResolvedValue({
      audio_url: 'https://googlevideo.example/a',
      http_headers: {},
      content_length: 4096,
      client: 'ANDROID_VR',
    })
    mockDownload.mockRejectedValueOnce(new Error('Download refused with status 403 at byte 0'))

    await runImport()

    // The other half of the rule, and the reason it is a rule rather than a
    // blanket "never retire": a URL that 403s is as useless as no URL.
    expect(mockExtract).toHaveBeenLastCalledWith('https://youtu.be/track0', {
      exclude: ['ANDROID_VR'],
    })
  })

  it('gives the retry a budget sized from the rate it measured', async () => {
    respondWithMatches([match(0)])
    mockExtract.mockResolvedValue({
      audio_url: 'https://googlevideo.example/a',
      http_headers: {},
      content_length: 14_587_885,
      client: 'ANDROID_VR',
    })
    mockDownload.mockRejectedValueOnce(short())

    await runImport()

    // Attempt 2 is handed the measured rate; the first attempt has nothing to
    // go on and is left exactly as it was.
    const first = mockDownload.mock.calls[0][3]
    const second = mockDownload.mock.calls[1][3]
    expect(first.observedBytesPerSecond ?? null).toBeNull()
    expect(second.observedBytesPerSecond).toBeCloseTo(10_764_208 / 300.1, 0)
  })

  it('does not let a near-instant truncation mint a long budget', async () => {
    respondWithMatches([match(0)])
    mockExtract.mockResolvedValue({
      audio_url: 'https://googlevideo.example/a',
      http_headers: {},
      content_length: 14_587_885,
      client: 'ANDROID_VR',
    })
    // A handful of bytes in a moment says nothing about a connection.
    const { DownloadWasShort } = jest.requireActual('../src/library/songs')
    mockDownload.mockRejectedValueOnce(new DownloadWasShort(2048, 14_587_885, 300))

    await runImport()

    const [, , , , secondRate] = mockDownload.mock.calls[1]
    expect(secondRate ?? null).toBeNull()
  })
})

/**
 * Every track's own state, not just the one in hand (#452).
 *
 * `CONCURRENCY = 2`, so at any moment most of a 135-track import is neither in
 * hand nor finished. I asked to see all of them: *"show the downloading
 * progress for each individual track, fetched → waiting → downloading → success
 * or failed … if the track is failed, display the type"*.
 */
describe('what each track is doing', () => {
  it('marks every accepted track as waiting before any work starts', async () => {
    respondWithMatches([match(0), match(1), match(2)])
    // Never resolves, so the run is caught with work still to do.
    mockDownload.mockImplementation(() => new Promise(() => {}))

    const promise = importPlaylistOnDevice('5', 'Road Trip')
    for (let flush = 0; flush < 40; flush++) await Promise.resolve()

    // The third is untouched by the two workers and must still be listed. A
    // list that fills in as tracks are reached is indistinguishable from a list
    // that is stuck, which is the fault this exists to remove.
    expect(useTrackStates.getState().forImport('5')['https://youtu.be/track2']?.phase).toBe(
      'waiting',
    )
    void promise
  })

  it('walks a track through its phases and lands it on done', async () => {
    respondWithMatches([match(0)])

    await runImport()

    expect(useTrackStates.getState().forImport('5')['https://youtu.be/track0']).toMatchObject({
      phase: 'done',
    })
  })

  it('records why a track failed, not merely that it did', async () => {
    respondWithMatches([match(0)])
    const { VideoUnavailable } = jest.requireActual('../src/library/extract')
    mockExtract.mockRejectedValue(new VideoUnavailable('gone', 'UNPLAYABLE'))

    await runImport()

    // The kind, so the row can say "YouTube will not play this one here" rather
    // than quoting an exception at somebody (#441).
    expect(useTrackStates.getState().forImport('5')['https://youtu.be/track0']).toMatchObject({
      phase: 'failed',
      failure: 'unavailable',
    })
  })

  it('records how it failed as well as why (#582)', async () => {
    /*
     * The kind alone made every failed row of my eighteen-track import
     * read identically. A `refused` was a 403 at byte 0, a 403 after the first
     * megabyte, or a timeout eight megabytes in — three faults with three
     * different answers, flattened into one word.
     *
     * ⚠️ **Two of those three are separate kinds now** (#639): a byte-0 refusal
     * is `refused_at_start`, because it is transient and the advice differs.
     * The detail still carries the offset, which is what #582 was about.
     *
     * Asserted against a **download** failure rather than an extraction one,
     * because that is the path carrying an HTTP status, and it is the one the
     * report was about.
     */
    respondWithMatches([match(0)])
    mockDownload.mockRejectedValue(new Error('Download refused with status 403 at byte 0'))

    await runImport()

    expect(useTrackStates.getState().forImport('5')['https://youtu.be/track0']).toMatchObject({
      phase: 'failed',
      failure: 'refused_at_start',
      detail: expect.stringContaining('status 403 at byte 0'),
    })
  })

  it('records the detail for an extraction failure too', async () => {
    // The other of the two sites that write `lastFailure`. Both were changed;
    // a test covering one would let the other regress silently.
    respondWithMatches([match(0)])
    const { VideoUnavailable } = jest.requireActual('../src/library/extract')
    mockExtract.mockRejectedValue(new VideoUnavailable('BV1x: 稿件不可见', '-404'))

    await runImport()

    expect(useTrackStates.getState().forImport('5')['https://youtu.be/track0']?.detail).toContain(
      '稿件不可见',
    )
  })

  it('calls a track that was already here carried, not saved', async () => {
    respondWithMatches([match(0)])
    mockSourcesFullyOnDevice.mockResolvedValue(new Set(['https://youtu.be/track0']))
    mockGetLocal.mockResolvedValue({ file_uri: 'file:///music/track0.opus', cover_uri: 'c' })

    await runImport()

    // Not a failure and not this run's work — the distinction #398 drew for the
    // counters, now visible per track.
    expect(useTrackStates.getState().forImport('5')['https://youtu.be/track0']?.phase).toBe(
      'carried',
    )
  })

  it('drops a track that is no longer in the import when it runs again', async () => {
    const { VideoUnavailable } = jest.requireActual('../src/library/extract')
    respondWithMatches([match(0), match(1)])
    mockExtract.mockRejectedValue(new VideoUnavailable('gone', 'UNPLAYABLE'))
    await runImport()
    expect(useTrackStates.getState().forImport('5')['https://youtu.be/track1']?.phase).toBe(
      'failed',
    )

    // The user rejects track 1 and runs it again. Overwriting is not enough
    // here — nothing in the second run ever mentions that URL, so a stale
    // "failed" would sit in the list for a track the import no longer contains.
    resetPlaylistImportGuard()
    mockFinishedImport.mockResolvedValue(null)
    respondWithMatches([match(0)])
    mockExtract.mockReset().mockResolvedValue({
      audio_url: 'https://googlevideo.example/a',
      http_headers: {},
      content_length: 4096,
    })
    await runImport()

    expect(useTrackStates.getState().forImport('5')['https://youtu.be/track1']).toBeUndefined()
    expect(useTrackStates.getState().forImport('5')['https://youtu.be/track0']?.phase).toBe('done')
  })
})

/**
 * Which site a track is fetched from (#555).
 *
 * #551 made the search source a choice, so a reviewed match can now be a
 * Bilibili URL. This loop went on calling `extractAudio` directly and threw
 * `NotAYouTubeLink` before a single request — searching found music the user
 * could not download, which is the whole feature for a mainland-China user.
 *
 * The rule is the one `importToDevice` already had: **the URL picks the
 * extractor**. `platformOf` is left unmocked above so the real matcher decides.
 */
describe('a reviewed match is fetched from the site its URL names (#555)', () => {
  const BILIBILI_URL = 'https://www.bilibili.com/video/BV1xx411c7mD'

  it('sends a Bilibili match to the Bilibili extractor', async () => {
    respondWithMatches([match(0, { chosen_url: BILIBILI_URL })])

    await runImport()

    expect(mockBilibiliExtract).toHaveBeenCalledWith(BILIBILI_URL)
    // Not merely "Bilibili was called": the YouTube chain must not also have
    // run, or a passing assertion would survive the loop trying both.
    expect(mockExtract).not.toHaveBeenCalled()
    // And it has to reach the disk. Routing that extracts correctly and then
    // fails to download is not a fixed bug.
    expect(mockDownload).toHaveBeenCalledWith(
      'local-Track 0',
      'https://upos.example/a',
      {},
      expect.anything(),
    )
  })

  it('records the library row as Bilibili too, not always YouTube (#636)', async () => {
    /*
     * The line three above the routing kept saying `Youtube`.
     *
     * #556 fixed which extractor runs and left `source_platform` hardcoded, so
     * every Bilibili track a review import saved was filed in the library as a
     * YouTube song. `importToDevice` gets this right for the same URL added any
     * other way — it writes `extractor.platform`.
     */
    respondWithMatches([match(0, { chosen_url: BILIBILI_URL })])

    await runImport()

    expect(mockSaveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ source_url: BILIBILI_URL, source_platform: 'Bilibili' }),
    )
  })

  it('records a YouTube match as YouTube', async () => {
    // The other edge, or a mutation making this constant `'Bilibili'` would
    // pass the test above (#375's lesson: a guard needs both its edges).
    respondWithMatches([match(0)])

    await runImport()

    expect(mockSaveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ source_platform: 'Youtube' }),
    )
  })

  it('still sends a YouTube match to the YouTube chain', async () => {
    respondWithMatches([match(0)])

    await runImport()

    expect(mockExtract).toHaveBeenCalled()
    expect(mockBilibiliExtract).not.toHaveBeenCalled()
  })

  it('routes a mixed playlist per track rather than per run', async () => {
    respondWithMatches([match(0), match(1, { chosen_url: BILIBILI_URL })])

    await runImport()

    // One decision per URL. A run that read the platform once would send both
    // tracks the same way and still look healthy on a single-source playlist.
    expect(mockExtract).toHaveBeenCalledTimes(1)
    expect(mockBilibiliExtract).toHaveBeenCalledTimes(1)
  })
})
