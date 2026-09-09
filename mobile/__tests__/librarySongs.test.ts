import type { Song } from '../src/api/types'
import { classifyFailure } from '../src/library/failureKind'
import { useDiagnostics } from '../src/diagnostics/log'
import {
  downloadAudioFromUrl,
  CHUNK_BYTES,
  chunkTimeoutMs,
  getLocalSong,
  getLocalSongByServerId,
  saveDeviceSongMetadata,
  listLocalSongs,
  removeLocalSong,
  removeLocalSongs,
  removeIncompleteSongs,
  removeSongIfEmpty,
  saveCover,
  saveSongMetadata,
  saveSongToDevice,
} from '../src/library/songs'

/**
 * Putting a song on the device (#159), on a clean start.
 *
 * The ordering is the thing under test: **metadata first, audio second,
 * `file_uri` last**. That is what makes a failed download a visible, retryable
 * row instead of nothing at all — and what stops `file_uri` ever pointing at
 * half a song.
 */

/** Keyed by the *local* id since #246, which is what the table is keyed by. */
const mockRows = new Map<string, Record<string, unknown>>()
const mockDisk = new Map<string, number>()
const mockDownload = jest.fn()
const mockRemoveFromPlaylists = jest.fn(async (_ids: readonly string[]) => {})

const byServerId = (serverId: unknown) =>
  [...mockRows.values()].find((row) => row.server_song_id === serverId) ?? null

// Deleting a song now clears its playlist entries too (#219). Mocked because
// this file is about the songs table, and the real one opens its own database.
jest.mock('../src/library/playlists', () => ({
  removeSongFromAllPlaylists: jest.fn(async () => {}),
  removeSongsFromAllPlaylists: (ids: readonly string[]) => mockRemoveFromPlaylists(ids),
}))

jest.mock('../src/library/db', () => ({
  openLibraryDb: async () => ({
    runAsync: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('VALUES (?, NULL,')) {
        // The device-side insert (#246): no server id, and a different param
        // list from the server one below.
        const localId = params[0] as string
        const existing = (mockRows.get(localId) ?? {}) as Record<string, unknown>
        mockRows.set(localId, {
          ...existing,
          id: localId,
          server_song_id: null,
          title: params[1],
          artist: params[2],
          album: null,
          duration: params[3],
          source_url: params[4],
          source_platform: params[5],
          added_at: params[6],
          loudness_lufs: params[7] ?? null,
          peak_dbfs: null,
          file_uri: existing.file_uri ?? null,
          file_size: existing.file_size ?? null,
          cover_uri: existing.cover_uri ?? null,
        })
      } else if (sql.includes('INSERT INTO songs')) {
        const localId = params[0] as string
        const serverId = params[1] as number
        // Upsert on the *server* id, which is what identifies the same song
        // across imports now that the primary key is ours. Preserving file_uri
        // is still the behaviour that matters.
        const existing = (byServerId(serverId) ?? {}) as Record<string, unknown>
        const id = (existing.id as string) ?? localId
        mockRows.set(id, {
          ...existing,
          id,
          server_song_id: serverId,
          title: params[2],
          artist: params[3],
          album: params[4],
          duration: params[5],
          source_url: params[6],
          source_platform: params[7],
          added_at: params[8],
          loudness_lufs: params[9],
          peak_dbfs: params[10],
          file_uri: existing.file_uri ?? null,
          file_size: existing.file_size ?? null,
          cover_uri: existing.cover_uri ?? null,
        })
      } else if (sql.includes('UPDATE songs SET file_uri')) {
        const row = mockRows.get(params[2] as string)
        if (row) {
          row.file_uri = params[0]
          row.file_size = params[1]
        }
      } else if (sql.includes('UPDATE songs SET cover_uri')) {
        const row = mockRows.get(params[1] as string)
        if (row) row.cover_uri = params[0]
      } else if (sql.includes('DELETE FROM songs')) {
        // `IN (?, ?, …)` since #569, and `= ?` for the single form. Both are
        // just "delete every id you were handed".
        let changes = 0
        for (const id of params) {
          if (mockRows.delete(id as string)) changes += 1
        }
        return { changes }
      }
      return { changes: 0 }
    },
    // The filter is honoured rather than ignored. A mock that answers every
    // `getAllAsync` with the whole table makes the launch sweep below look like
    // it deletes the library, or like it works — depending on which way the
    // assertion happens to point.
    getAllAsync: async (sql: string) =>
      sql.includes('file_uri IS NULL')
        ? [...mockRows.values()].filter((row) => row.file_uri == null)
        : [...mockRows.values()],
    getFirstAsync: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('source_url = ?')) {
        return (
          [...mockRows.values()].find(
            (row) => row.source_url === params[0] && row.server_song_id === null,
          ) ?? null
        )
      }
      return sql.includes('server_song_id = ?')
        ? byServerId(params[0])
        : (mockRows.get(params[0] as string) ?? null)
    },
  }),
}))

jest.mock('expo-file-system', () => {
  const join = (parts: (string | { uri: string })[]) =>
    parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/')

  class File {
    uri: string
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(parts)
    }
    get exists() {
      return mockDisk.has(this.uri)
    }
    get size() {
      return mockDisk.get(this.uri) ?? null
    }
    delete() {
      mockDisk.delete(this.uri)
    }
    create() {
      mockDisk.set(this.uri, 0)
    }
    /**
     * `append` is honoured, because the chunked download is built on it (#454).
     *
     * A mock that ignored the flag would record the *last* chunk's length as
     * the file size, so a seven-chunk download of a 13 MB track would land as
     * 2 MB and every assertion about the finished file would be measuring the
     * mock. `FileSystemFile.kt:87` is the real one: `FileOutputStream(file,
     * append)`, which also creates the file when it is missing.
     */
    write(bytes: Uint8Array, options?: { append?: boolean }) {
      const before = options?.append ? (mockDisk.get(this.uri) ?? 0) : 0
      mockDisk.set(this.uri, before + bytes.byteLength)
    }
    open() {
      const uri = this.uri
      return {
        writeBytes: (bytes: Uint8Array) =>
          mockDisk.set(uri, (mockDisk.get(uri) ?? 0) + bytes.byteLength),
        close: () => {},
      }
    }
    static downloadFileAsync = (...args: unknown[]) => mockDownload(...args)
  }

  class Directory {
    uri: string
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(parts)
    }
    get exists() {
      return true
    }
    create() {}
    list() {
      return []
    }
  }

  return { File, Directory, Paths: { document: { uri: 'file:///data/app' } } }
})

function song(id: number, title = `Song ${id}`): Song {
  return {
    id,
    title,
    artist: 'Artist',
    album: null,
    duration: 200,
    source_url: `https://youtube.com/watch?v=${id}`,
    source_platform: 'Youtube',
    added_at: '2026-07-30T00:00:00Z',
    loudness_lufs: -12,
    peak_dbfs: -1,
  }
}

const context = { serverUrl: 'https://mio.test/api', headers: { 'X-Install-Id': 'abc' } }

type FetchInit = { headers?: Record<string, string> }

function rangeOf(init?: FetchInit): { start: number; end: number } | null {
  const match = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? '')
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null
}

/** What the download asked for. Throws in an assertion that assumed a range. */
function requestedRange(init?: FetchInit): { start: number; end: number } {
  const range = rangeOf(init)
  if (!range) throw new Error(`no Range header on the request: ${JSON.stringify(init?.headers)}`)
  return range
}

/**
 * A stand-in for googlevideo that actually serves ranges.
 *
 * The point of a real one rather than a fixed response: the chunked download
 * (#454) is a *conversation*, and a mock that answers every request with the
 * same body cannot tell a download that resumed correctly from one that fetched
 * byte 0 seven times. This answers what was asked for, so the bytes on the fake
 * disk are only right if the offsets were.
 *
 * `truncateAfter` reproduces the failure #454 exists for: the server closes the
 * stream early, delivering less than the range it was asked for.
 */
function servingFile(
  total: number,
  {
    truncateAfter,
    maxPerResponse,
    refuseAfter,
    servedBy,
  }: {
    /** Serve nothing at or past this offset — a URL that goes dead mid-file. */
    truncateAfter?: number
    /** Close the stream after this many bytes of any one response. */
    maxPerResponse?: number
    /** Answer 403 once the download has passed this offset — a spent URL. */
    refuseAfter?: number
    /** Only this URL is served; anything else is refused. */
    servedBy?: string
  } = {},
): jest.Mock {
  return jest.fn(async (url: string, init?: FetchInit) => {
    // No `Range` is a plain request for the whole thing — what `saveCover`
    // makes, and what a server that does not do ranges would answer anyway.
    const asRange = rangeOf(init)
    if (!asRange) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(total),
      }
    }
    const { start, end } = asRange
    const spent = refuseAfter != null && start >= refuseAfter
    if (spent || (servedBy != null && url !== servedBy)) {
      return { ok: false, status: 403, headers: { get: () => null } }
    }
    const asked = Math.min(end, total - 1) - start + 1
    const reachable =
      truncateAfter == null ? asked : Math.max(0, Math.min(asked, truncateAfter - start))
    const served = maxPerResponse == null ? reachable : Math.min(reachable, maxPerResponse)
    return {
      ok: true,
      status: 206,
      headers: {
        get: (name: string) =>
          // Clamped to what is actually being sent, as a byte server states it.
          name.toLowerCase() === 'content-range'
            ? `bytes ${start}-${start + Math.max(served, 1) - 1}/${total}`
            : null,
      },
      arrayBuffer: async () => new ArrayBuffer(served),
    }
  })
}

beforeEach(() => {
  // Case-insensitive, as a real `Headers` is. A mock stricter than the runtime
  // makes a passing test evidence about the mock.
  globalThis.fetch = servingFile(4096) as unknown as typeof fetch
  mockRows.clear()
  mockDisk.clear()
  mockDownload.mockReset()
  // Module-level and shared: a call left here makes the "does nothing for an
  // empty selection" assertion below read a previous test's work.
  mockRemoveFromPlaylists.mockClear()
  // A successful download puts bytes on the fake disk.
  mockDownload.mockImplementation(async (_url: string, destination: { uri: string }) => {
    mockDisk.set(destination.uri, 4096)
  })
})

describe('saving a song to the device (#159)', () => {
  it('records the song before its audio arrives', async () => {
    const localId = await saveSongMetadata(song(1))

    // The id is this device's, minted here — not the server's (#246).
    expect(localId).not.toBe('1')
    expect(localId).toMatch(/^[0-9a-f]{32}$/)

    const stored = await getLocalSong(localId)
    expect(stored?.server_song_id).toBe(1)
    expect(stored?.title).toBe('Song 1')
    // Known about, not downloaded — a real state, and what "adding…" looks like.
    expect(stored?.file_uri).toBeNull()
  })

  it('records where the audio landed, and how big it is', async () => {
    const localId = await saveSongToDevice(song(1), context)

    const stored = await getLocalSong(localId)
    // Named by the local id, not the server's — the two are different things
    // and confusing them is the easy mistake in this file.
    expect(stored?.file_uri).toContain(`${localId}.opus`)
    expect(stored?.file_size).toBe(4096)
  })

  it('sends the identifying headers, or the audio endpoint 404s', async () => {
    await saveSongToDevice(song(1), context)

    const [url, , options] = mockDownload.mock.calls[0]
    expect(url).toBe('https://mio.test/api/songs/1/audio')
    expect(options.headers).toEqual({ 'X-Install-Id': 'abc' })
    // Re-downloading must not fail because a previous attempt left something.
    expect(options.idempotent).toBe(true)
  })

  it('leaves a visible, retryable row when the download fails', async () => {
    mockDownload.mockRejectedValue(new Error('offline'))

    await expect(saveSongToDevice(song(1), context)).rejects.toThrow('offline')

    // The row survives, so the failure is something the user can see and retry
    // rather than a song that silently never appeared.
    const stored = await getLocalSongByServerId(1)
    expect(stored).not.toBeNull()
    expect(stored?.file_uri).toBeNull()
  })

  it('cleans up a partial file rather than recording half a song', async () => {
    mockDownload.mockImplementation(async (_url: string, destination: { uri: string }) => {
      mockDisk.set(destination.uri, 512) // partially written
      throw new Error('connection reset')
    })

    await expect(saveSongToDevice(song(1), context)).rejects.toThrow('connection reset')

    // A half-written file recorded as present reads as a corrupt library rather
    // than a failed download.
    expect(mockDisk.size).toBe(0)
  })

  it('re-importing a song already on disk does not forget where it is', async () => {
    const localId = await saveSongToDevice(song(1), context)
    const before = await getLocalSong(localId)

    // The same song arriving again — an overlapping playlist, say.
    const again = await saveSongMetadata(song(1, 'Corrected Title'))

    // Same local id, not a second row: the upsert keys on the server id, which
    // is what makes the import handover idempotent.
    expect(again).toBe(localId)
    const after = await getLocalSong(localId)
    expect(after?.title).toBe('Corrected Title')
    expect(after?.file_uri).toBe(before?.file_uri)
    expect(await listLocalSongs()).toHaveLength(1)
  })

  it('removes the audio, the cover and the row together', async () => {
    const localId = await saveSongToDevice(song(1), context)
    // Two files since #218: the audio and its cover.
    expect(mockDisk.size).toBe(2)

    await removeLocalSong(localId)

    // "Delete" means gone. An orphaned cover would be bytes nothing can ever
    // find again, because the row was its only index.
    expect(mockDisk.size).toBe(0)
    expect(await getLocalSong(localId)).toBeNull()
  })

  it('removes many songs in one pass (#569)', async () => {
    /*
     * *"when I select all the tracks, and click delete, they are being
     * deleted one by one"*.
     *
     * The rows and the files still all have to go — that part is not allowed to
     * change — and the playlist work happens **once for the whole batch**
     * rather than once per song, which is where the time went when a selection
     * came out of a single playlist.
     */
    const a = await saveSongToDevice(song(1), context)
    const b = await saveSongToDevice(song(2), context)
    expect(mockDisk.size).toBe(4)

    const report = await removeLocalSongs([a, b])

    expect(report).toEqual({ removed: 2, fileFailures: 0 })
    expect(mockDisk.size).toBe(0)
    expect(await getLocalSong(a)).toBeNull()
    expect(await getLocalSong(b)).toBeNull()
    // Once, with both ids — not twice.
    expect(mockRemoveFromPlaylists).toHaveBeenCalledTimes(1)
    expect(mockRemoveFromPlaylists.mock.calls[0][0]).toEqual([a, b])
  })

  it('does nothing, and says so, for an empty selection', async () => {
    // The guard that keeps `IN ()` — a syntax error — from ever being built.
    const report = await removeLocalSongs([])

    expect(report).toEqual({ removed: 0, fileFailures: 0 })
    expect(mockRemoveFromPlaylists).not.toHaveBeenCalled()
  })

  it('counts a song that had already gone rather than claiming it', async () => {
    // `removed` is what the database actually deleted. Reporting the length of
    // the request would let the screen say "3 removed" about two.
    const a = await saveSongToDevice(song(1), context)

    const report = await removeLocalSongs([a, 'local-never-existed'])

    expect(report.removed).toBe(1)
  })

  it('lists what is on the device', async () => {
    await saveSongToDevice(song(1), context)
    await saveSongMetadata(song(2))

    const songs = await listLocalSongs()

    // Both are in the library; only one has audio yet.
    expect(songs).toHaveLength(2)
    expect(songs.filter((s) => s.file_uri !== null)).toHaveLength(1)
  })
})

describe('a song this device fetched itself (#246)', () => {
  const track = {
    title: 'Flower of Japan',
    artist: 'A Channel',
    duration: 214,
    source_url: 'https://www.youtube.com/watch?v=DruvTra8swY',
    source_platform: 'Youtube',
  }

  it('has no server id at all, which is the whole point', async () => {
    const localId = await saveDeviceSongMetadata(track)

    const stored = await getLocalSong(localId)
    expect(stored?.server_song_id).toBeNull()
    expect(stored?.title).toBe('Flower of Japan')
  })

  it("keeps YouTube's loudness figure, so normalization survives (#246)", async () => {
    const localId = await saveDeviceSongMetadata({ ...track, loudness_lufs: -14.3 })

    // The server measured this with ffmpeg's ebur128 (G4). YouTube ships the
    // same number, in the same unit, with metadata we already fetch — which is
    // why moving downloads to the device costs no loudness correction.
    expect((await getLocalSong(localId))?.loudness_lufs).toBe(-14.3)
  })

  it('adding the same link twice reuses the row rather than downloading again', async () => {
    const first = await saveDeviceSongMetadata(track)
    const second = await saveDeviceSongMetadata({ ...track, title: 'Corrected' })

    // Keyed on source_url, since there is no server id to key on. Without this
    // a re-import would make a second row and fetch the audio a second time.
    expect(second).toBe(first)
    expect(await listLocalSongs()).toHaveLength(1)
    expect((await getLocalSong(first))?.title).toBe('Corrected')
  })

  it('downloads from the given URL and records where it landed', async () => {
    const localId = await saveDeviceSongMetadata(track)

    await downloadAudioFromUrl(localId, 'https://googlevideo.example/audio')

    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(url).toBe('https://googlevideo.example/audio')
    // `fetch`, not `File.downloadFileAsync` — the latter is OkHttp on Android
    // and googlevideo answered 403 to it twice (#246). This reproduces the
    // request the spike observed working, `Range` included.
    expect(init.headers.Range).toBe('bytes=0-2097151')
    // Never our own identity: there is no server here to identify ourselves to.
    expect(init.headers['X-Install-Id']).toBeUndefined()

    const stored = await getLocalSong(localId)
    expect(stored?.file_uri).toContain(`${localId}.opus`)
    expect(stored?.file_size).toBe(4096)
  })

  it('reports the status when the download is refused', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as unknown as typeof fetch
    const localId = await saveDeviceSongMetadata(track)

    // "It failed" with no number is what made the first two attempts at this
    // guesswork.
    await expect(downloadAudioFromUrl(localId, 'https://googlevideo.example/x')).rejects.toThrow(
      'status 403',
    )
    expect(mockDisk.size).toBe(0)
  })

  /**
   * A dead connection must fail, not hang (from the 2026-08-09 device pass).
   *
   * Nothing on the device's download path had a timeout. `apiFetch` has had one
   * since it was written — *"a stalled connection must fail rather than hang
   * forever behind a spinner"* — and the paths that replaced the server got
   * none. Android froze the app mid-download, the sockets died, and the promise
   * never settled: the import never advanced, never failed, never finished, so
   * no result and no retry button, and a library row sat on "Downloading…"
   * until the app was restarted.
   */
  describe('a download that never answers', () => {
    it('gives up rather than waiting forever', async () => {
      jest.useFakeTimers()
      // A socket that answers nothing, ever — which is what a frozen app leaves
      // behind. Wired to the abort signal, because that is the contract the
      // production code relies on: without it this test would hang too.
      globalThis.fetch = jest.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')))
          }),
      ) as unknown as typeof fetch
      const localId = await saveDeviceSongMetadata(track)

      const download = downloadAudioFromUrl(
        localId,
        'https://googlevideo.example/x',
        {},
        {
          contentLength: 4096,
        },
      )
      const settled = expect(download).rejects.toThrow(/timed out/)
      await jest.advanceTimersByTimeAsync(chunkTimeoutMs() + 1)
      await settled

      // Named, not a bare `AbortError`: "the connection stopped" and "someone
      // cancelled" are the same exception and very different findings.
      expect((await getLocalSong(localId))?.file_uri).toBeNull()
      jest.useRealTimers()
    })

    /**
     * The budget stopped being about the file (#454).
     *
     * This is the whole reason chunking fixes the four long tracks. The old
     * `downloadTimeoutMs` paced the *whole file*, so a big one either got a long
     * fuse — my objection, *"what if a track failed because of other
     * reason, and we set 15 minute ceiling"* — or was cut off at three quarters,
     * which is what actually happened. A chunk is a fixed size, so the fuse is
     * the same length for a four-minute song and a three-hour compilation, and
     * every chunk that lands resets it.
     */
    it('paces a chunk, not a file, so length buys no extra fuse', () => {
      // The four tracks that failed were 13–14 MB; the compilation was 187 MB.
      // Neither is an input, because neither can be: there is only ever one
      // chunk in flight.
      expect(chunkTimeoutMs()).toBe(chunkTimeoutMs())
      // Long enough to move a chunk at the rate my phone actually managed
      // (~35 kB/s), which is the measurement that moved the floor. The chunk is
      // 512 KiB since #649, so the floor came down with it — by construction,
      // because both are computed from `CHUNK_BYTES`.
      expect(chunkTimeoutMs()).toBeGreaterThan((CHUNK_BYTES / 35_000) * 1000)
      // …and short enough that a dead socket is not held for minutes. Under the
      // old total budget this was five minutes for any file over ~11 MB.
      expect(chunkTimeoutMs()).toBeLessThan(3 * 60_000)
    })

    /**
     * A budget earned by measurement, not by guesswork (#439), which survives
     * the move to chunks: a connection that proved it is slow gets more room.
     */
    it('widens a chunk once a rate has actually been measured', () => {
      // The rate the four failed tracks actually achieved: 35.9 kB/s. It buys
      // nothing now, and that is the point — the floor moved *below* it, so the
      // case that needed a measurement to survive no longer needs one.
      expect(chunkTimeoutMs(10_764_208 / 300.1)).toBe(chunkTimeoutMs())
      // A connection slower than the floor still earns room, which is all
      // #439's mechanism was ever for.
      expect(chunkTimeoutMs(8_000)).toBeGreaterThan(chunkTimeoutMs())
      // Only a retry after a truncated download supplies a rate at all.
      expect(chunkTimeoutMs(null)).toBe(chunkTimeoutMs())
      expect(chunkTimeoutMs(0)).toBe(chunkTimeoutMs())
    })

    it('never shortens the fuse for a connection that is doing well', () => {
      // A measured rate can only widen. Fibre measured at 10 MB/s would
      // otherwise derive a budget of about two seconds and fail on one hiccup.
      expect(chunkTimeoutMs(10_000_000)).toBe(chunkTimeoutMs())
    })
  })

  it('refuses an empty body rather than recording a zero-byte song', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as unknown as typeof fetch
    const localId = await saveDeviceSongMetadata(track)

    await expect(downloadAudioFromUrl(localId, 'https://googlevideo.example/x')).rejects.toThrow(
      'no bytes',
    )
    expect((await getLocalSong(localId))?.file_uri).toBeNull()
  })

  it('cleans up a partial file rather than recording half a song', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('connection reset')) as typeof fetch
    const localId = await saveDeviceSongMetadata(track)

    await expect(downloadAudioFromUrl(localId, 'https://googlevideo.example/x')).rejects.toThrow(
      'connection reset',
    )

    expect(mockDisk.size).toBe(0)
    // The row survives, so the failure is visible and retryable.
    expect(await getLocalSong(localId)).not.toBeNull()
  })

  it('forwards any extra headers it is given', async () => {
    const localId = await saveDeviceSongMetadata(track)

    await downloadAudioFromUrl(localId, 'https://googlevideo.example/audio', { 'X-Test': '1' })

    const [, init] = (globalThis.fetch as jest.Mock).mock.calls.at(-1)!
    expect(init.headers['X-Test']).toBe('1')
  })

  it('asks for no more than what YouTube stated', async () => {
    const localId = await saveDeviceSongMetadata(track)

    await downloadAudioFromUrl(
      localId,
      'https://googlevideo.example/a',
      {},
      { contentLength: 4096 },
    )

    const calls = (globalThis.fetch as jest.Mock).mock.calls
    // A song smaller than one chunk is still one request, and it asks for
    // exactly what exists rather than for the fallback ceiling.
    expect(calls).toHaveLength(1)
    expect(calls[0][1].headers.Range).toBe('bytes=0-4095')
  })

  /**
   * The failure #454 exists for.
   *
   * Track 46 failed three times, and never on time: 79.8%, then 97.6%, then
   * 98.6% of 13,011,571 bytes, the last two with minutes of budget left.
   * googlevideo was closing the stream early, and no timeout can fix a server
   * hanging up. A ranged request for the rest finishes it.
   */
  describe('a stream the server closes early (#454)', () => {
    /** Track 46's real size, so the arithmetic is the one that failed. */
    const TRACK_46 = 13_011_571

    it('asks for the rest instead of starting over', async () => {
      // Every response stops after 1 MiB, whatever it was asked for — the shape
      // of a server that will not hold a long stream open.
      // ⚠️ Derived from the chunk, not a literal. "The server closed early" means
      // *less than a chunk*, and this was `1024 * 1024` — which stopped being
      // short the moment #649 lowered the chunk to 512 KiB, so the fixture
      // served whole chunks and the rescue it exists to observe never happened.
      globalThis.fetch = servingFile(TRACK_46, { maxPerResponse: CHUNK_BYTES / 2 }) as never
      const localId = await saveDeviceSongMetadata(track)

      await downloadAudioFromUrl(
        localId,
        'https://googlevideo.example/a',
        {},
        {
          contentLength: TRACK_46,
        },
      )

      // The whole track, assembled out of short answers.
      expect((await getLocalSong(localId))?.file_size).toBe(TRACK_46)

      // …and every request continued from where the last one stopped. Without
      // the offsets this passes on a downloader that re-fetches byte 0 forever.
      const starts = (globalThis.fetch as jest.Mock).mock.calls.map(
        ([, init]) => requestedRange(init).start,
      )
      // Half-chunk strides, because this fixture closes every response at half a
      // chunk — which is the scenario. What is being proved is continuation, so
      // the strides are derived rather than assumed.
      expect(starts.slice(0, 3)).toEqual([0, CHUNK_BYTES / 2, CHUNK_BYTES])
      // No offset asked for twice: a downloader re-fetching byte 0 forever
      // would still be "sorted".
      expect(new Set(starts).size).toBe(starts.length)
      expect(starts).toEqual([...starts].sort((a, b) => a - b))
    })

    it('never holds more than a chunk of the file in memory', async () => {
      globalThis.fetch = servingFile(TRACK_46) as never
      const localId = await saveDeviceSongMetadata(track)

      await downloadAudioFromUrl(
        localId,
        'https://googlevideo.example/a',
        {},
        {
          contentLength: TRACK_46,
        },
      )

      // The second reason for chunking: `arrayBuffer()` holds the body, and the
      // 2h54m track I probed is 187 MB. No request may ask for more than
      // one chunk, whatever the file's size.
      const windows = (globalThis.fetch as jest.Mock).mock.calls.map(([, init]) => {
        const { start, end } = requestedRange(init)
        return end - start + 1
      })
      expect(Math.max(...windows)).toBeLessThanOrEqual(CHUNK_BYTES)
      expect(windows.length).toBeGreaterThan(1)
    })

    it('still fails, with the numbers, when the bytes actually stop', async () => {
      // A URL that goes dead at 79.8% and never serves another byte — the case
      // a ranged retry must not paper over.
      globalThis.fetch = servingFile(TRACK_46, { truncateAfter: 10_387_392 }) as never
      const localId = await saveDeviceSongMetadata(track)

      // A truncated song plays and then stops, which reads as a broken app. A
      // failed download keeps the row retryable and says what happened — and
      // carries the rate, because #439 sizes the next attempt from it.
      await expect(
        downloadAudioFromUrl(
          localId,
          'https://googlevideo.example/a',
          {},
          {
            contentLength: TRACK_46,
          },
        ),
      ).rejects.toThrow(`short: 10387392 of ${TRACK_46}`)
      expect(mockDisk.size).toBe(0)
    })

    /**
     * Whether chunking actually rescued anything (#467).
     *
     * The recovery was silent, so my *"track 46 downloaded, but maybe just
     * luck this time"* could not be answered from any log. It is the right
     * question: a track that never truncated and a track rescued seven times
     * looked identical.
     */
    it('says how many chunks it had to ask for twice', async () => {
      const { useDiagnostics } = jest.requireActual('../src/diagnostics/log')
      useDiagnostics.setState({ entries: [] })
      globalThis.fetch = servingFile(TRACK_46, { maxPerResponse: CHUNK_BYTES / 2 }) as never
      const localId = await saveDeviceSongMetadata(track)

      await downloadAudioFromUrl(
        localId,
        'https://googlevideo.example/a',
        {},
        {
          contentLength: TRACK_46,
        },
      )

      const entry = useDiagnostics
        .getState()
        .entries.find((e: { event: string }) => e.event === 'download.recovered')
      expect(entry?.detail ?? '').toMatch(/short=[1-9]/)
    })

    it('says nothing at all when nothing needed rescuing', async () => {
      // The other answer, which is what makes the line above evidence. A
      // diagnostic written on every download would bury the ones that matter.
      const { useDiagnostics } = jest.requireActual('../src/diagnostics/log')
      useDiagnostics.setState({ entries: [] })
      globalThis.fetch = servingFile(TRACK_46) as never
      const localId = await saveDeviceSongMetadata(track)

      await downloadAudioFromUrl(
        localId,
        'https://googlevideo.example/a',
        {},
        {
          contentLength: TRACK_46,
        },
      )

      expect(
        useDiagnostics
          .getState()
          .entries.filter((e: { event: string }) => e.event === 'download.recovered'),
      ).toHaveLength(0)
    })

    it('gives up rather than asking a dead URL forever', async () => {
      globalThis.fetch = servingFile(4096, { truncateAfter: 0 }) as never
      const localId = await saveDeviceSongMetadata(track)

      await expect(
        downloadAudioFromUrl(localId, 'https://googlevideo.example/a', {}, { contentLength: 4096 }),
      ).rejects.toThrow('no bytes')
      // Bounded, which is the whole of #411: a URL answering 206-with-nothing
      // is a hang if the loop believes it.
      expect((globalThis.fetch as jest.Mock).mock.calls.length).toBeLessThanOrEqual(4)
    })
  })

  /**
   * A URL that stops serving part-way through (#454).
   *
   * #246 measured a stream URL serving one request and refusing the next
   * (*"403 at byte 1048576"*); #442's probe measured one serving two. Both are
   * real readings and they disagree, so the download bets on neither: a refusal
   * *after* bytes have landed asks for a fresh URL and carries on from the same
   * offset, which is exactly the case the probe proved works.
   */
  describe('a URL that is spent mid-file (#454)', () => {
    const SIZE = 6 * 1024 * 1024

    it('continues on a fresh URL from where it stopped', async () => {
      const fresh = 'https://googlevideo.example/fresh'
      globalThis.fetch = jest.fn(async (url: string, init?: never) => {
        // The first URL serves two chunks and then refuses, as #246 saw.
        const server =
          url === fresh ? servingFile(SIZE) : servingFile(SIZE, { refuseAfter: 4 * 1024 * 1024 })
        return server(url, init)
      }) as never
      const localId = await saveDeviceSongMetadata(track)

      await downloadAudioFromUrl(
        localId,
        'https://googlevideo.example/spent',
        {},
        {
          contentLength: SIZE,
          refresh: async () => ({ url: fresh, headers: {}, contentLength: SIZE }),
        },
      )

      // Nothing re-downloaded: the first four megabytes came from the spent URL.
      expect((await getLocalSong(localId))?.file_size).toBe(SIZE)
      const resumed = (globalThis.fetch as jest.Mock).mock.calls.find(([url]) => url === fresh)
      expect(requestedRange(resumed![1]).start).toBe(4 * 1024 * 1024)
    })

    it('refuses to resume onto a source of a different size', async () => {
      globalThis.fetch = servingFile(SIZE, { refuseAfter: 2 * 1024 * 1024 }) as never
      const localId = await saveDeviceSongMetadata(track)

      // A re-extraction can come back with a different client's format. Its
      // bytes appended to a half-downloaded file would make a song of plausible
      // length that does not play — worse than failing, and invisible.
      await expect(
        downloadAudioFromUrl(
          localId,
          'https://googlevideo.example/a',
          {},
          {
            contentLength: SIZE,
            refresh: async () => ({
              url: 'https://x/other',
              headers: {},
              contentLength: SIZE + 17,
            }),
          },
        ),
      ).rejects.toThrow('changed size')
      expect(mockDisk.size).toBe(0)
    })

    it('refuses a source that answers the whole file part-way through', async () => {
      let served = 0
      globalThis.fetch = jest.fn(async (_url: string, init?: FetchInit) => {
        const { start, end } = requestedRange(init)
        // The second answer ignores `Range` and sends the entity from byte 0 —
        // a 200, not a 206. Appending it would double the file's first half.
        if (served++ > 0) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            arrayBuffer: async () => new ArrayBuffer(SIZE),
          }
        }
        return {
          ok: true,
          status: 206,
          headers: { get: () => `bytes ${start}-${end}/${SIZE}` },
          arrayBuffer: async () => new ArrayBuffer(end - start + 1),
        }
      }) as never
      const localId = await saveDeviceSongMetadata(track)

      await expect(
        downloadAudioFromUrl(localId, 'https://googlevideo.example/a', {}, { contentLength: SIZE }),
      ).rejects.toThrow('restarted from byte 0')
      // The corruption this prevents is invisible: a file of plausible length
      // that does not play, recorded as a complete song.
      expect(mockDisk.size).toBe(0)
    })

    it('fails at byte 0 without asking for a fresh URL', async () => {
      globalThis.fetch = servingFile(SIZE, { refuseAfter: 0 }) as never
      const refresh = jest.fn()
      const localId = await saveDeviceSongMetadata(track)

      await expect(
        downloadAudioFromUrl(
          localId,
          'https://googlevideo.example/a',
          {},
          {
            contentLength: SIZE,
            refresh,
          },
        ),
      ).rejects.toThrow('status 403 at byte 0')
      // A refusal before any bytes is the video being refused, not the URL
      // being spent — re-extracting the same thing would just refuse again.
      expect(refresh).not.toHaveBeenCalled()
    })
  })
})

/**
 * Cover art on the device (#218).
 *
 * The column that unblocks T4's thumbnails, and the one that finally makes
 * lock-screen artwork possible: `artworkUrl` is a bare string the OS fetches
 * itself, so it could never carry the install header an owned `/cover` needs.
 * A `file://` URI needs headers from nobody.
 *
 * The rule these tests exist to hold is that **artwork is decoration**. Every
 * failure mode below must leave a complete, playable song behind.
 */
describe('cover art (#218)', () => {
  it('stores the cover beside the audio and records where it went', async () => {
    const localId = await saveSongToDevice(song(1), context)

    const row = await getLocalSong(localId)
    expect(row?.cover_uri).toBe(`file:///data/app/library/${localId}.jpg`)
    expect(mockDisk.has(row!.cover_uri!)).toBe(true)
  })

  it('asks the server for the cover with the headers that make it ours', async () => {
    await saveSongToDevice(song(1), context)

    const call = (globalThis.fetch as jest.Mock).mock.calls.find((c) =>
      String(c[0]).includes('/cover'),
    )
    expect(call[0]).toBe('https://mio.test/api/songs/1/cover')
    // #170: the endpoint 404s without this, which is the entire reason the OS
    // could never fetch it directly.
    expect(call[1].headers).toEqual({ 'X-Install-Id': 'abc' })
  })

  it('keeps the song when the server has no cover for it', async () => {
    /*
     * The 404 carries a body on purpose.
     *
     * With an empty response the test passed even when the `response.ok` check
     * was deleted — reading `arrayBuffer()` off the stub threw, the catch
     * swallowed it, and the outcome looked identical. A body means removing that
     * check really does store the error page as cover art, which is the bug this
     * is here to catch. (Found by mutating the check out; it survived.)
     */
    ;(globalThis.fetch as jest.Mock).mockImplementation(async (url: string) =>
      String(url).includes('/cover')
        ? { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(64) }
        : {
            ok: true,
            status: 206,
            headers: { get: () => 'bytes 0-4095/4096' },
            arrayBuffer: async () => new ArrayBuffer(4096),
          },
    )

    const localId = await saveSongToDevice(song(1), context)

    const row = await getLocalSong(localId)
    expect(row?.cover_uri).toBeNull()
    // The song itself is complete. This is the assertion that matters: a
    // missing JPEG must never cost the user a track.
    expect(row?.file_uri).toBeTruthy()
  })

  it('keeps the song when fetching the cover throws outright', async () => {
    ;(globalThis.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes('/cover')) throw new Error('network is down')
      return {
        ok: true,
        status: 206,
        headers: { get: () => 'bytes 0-4095/4096' },
        arrayBuffer: async () => new ArrayBuffer(4096),
      }
    })

    // Must not reject. Letting this propagate would make the caller delete the
    // audio and mark the import failed over a thumbnail.
    const localId = await saveSongToDevice(song(1), context)

    expect((await getLocalSong(localId))?.file_uri).toBeTruthy()
    expect((await getLocalSong(localId))?.cover_uri).toBeNull()
  })

  it('does not refetch a cover it already has', async () => {
    const localId = await saveSongToDevice(song(1), context)
    const before = (globalThis.fetch as jest.Mock).mock.calls.filter((c) =>
      String(c[0]).includes('/cover'),
    ).length

    await saveCover(localId, 'https://mio.test/api/songs/1/cover')

    const after = (globalThis.fetch as jest.Mock).mock.calls.filter((c) =>
      String(c[0]).includes('/cover'),
    ).length
    // Re-running is how a *missing* cover gets filled in later, so it has to be
    // safe — but it must not re-download one that is already on disk.
    expect(after).toBe(before)
  })

  it('does nothing at all when there is no cover URL', async () => {
    // The device import path passes null whenever YouTube offered no thumbnail.
    expect(await saveCover('some-id', null)).toBeNull()
    expect(mockDisk.size).toBe(0)
  })

  it('refuses an empty body rather than recording a zero-byte cover', async () => {
    ;(globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    })

    expect(await saveCover('some-id', 'https://example.com/cover.jpg')).toBeNull()
    expect(mockDisk.size).toBe(0)
  })
})

/**
 * Undoing a row for audio that never arrived (#309).
 *
 * I re-took the decision this file's import path was built on: the library
 * means *music I have*, so a row with no file does not belong in it.
 *
 * The guard is the whole safety of that change and is tested hardest, because
 * the same failure path is taken by a **re-download of a track that is already
 * here** — and deleting that row would take away a song the user has had for
 * weeks, with its bytes.
 */
describe('removing a row that never got its audio (#309)', () => {
  it('removes a row with no file', async () => {
    const localId = await saveDeviceSongMetadata({
      title: 'Never arrived',
      artist: 'A',
      duration: 100,
      source_url: 'https://youtu.be/never',
      source_platform: 'Youtube',
    })

    await removeSongIfEmpty(localId)

    expect(await getLocalSong(localId)).toBeNull()
  })

  it('leaves a row that has its audio completely alone', async () => {
    const localId = await saveDeviceSongMetadata({
      title: 'Already here',
      artist: 'A',
      duration: 100,
      source_url: 'https://youtu.be/here',
      source_platform: 'Youtube',
    })
    await downloadAudioFromUrl(localId, 'https://cdn.example/a.opus', {}, { contentLength: 4096 })

    await removeSongIfEmpty(localId)

    // The case that would otherwise cost someone a song they already had.
    expect(await getLocalSong(localId)).not.toBeNull()
  })

  it('says nothing about a row that is not there', async () => {
    await expect(removeSongIfEmpty('local-nothing')).resolves.toBeUndefined()
  })
})

/**
 * The rows a killed process leaves behind (#369).
 *
 * `removeSongIfEmpty` above covers a download that *failed*. This covers one
 * that never got to fail: Android suspends a backgrounded app's JavaScript and
 * eventually stops the process, and a row written a moment before that has
 * nobody left to clean it up. I saw the result as songs in the library that
 * would not play.
 */
describe('sweeping rows the last run left mid-download (#369)', () => {
  it('removes a row whose audio never landed', async () => {
    const localId = await saveDeviceSongMetadata({
      title: 'Interrupted',
      artist: 'A',
      duration: 100,
      source_url: 'https://youtu.be/interrupted',
      source_platform: 'Youtube',
    })

    expect(await removeIncompleteSongs()).toBe(1)
    expect(await getLocalSong(localId)).toBeNull()
  })

  it('leaves every song that actually has its audio', async () => {
    const complete = await saveDeviceSongMetadata({
      title: 'Here',
      artist: 'A',
      duration: 100,
      source_url: 'https://youtu.be/here-2',
      source_platform: 'Youtube',
    })
    await downloadAudioFromUrl(complete, 'https://cdn.example/a.opus', {}, { contentLength: 4096 })
    const orphan = await saveDeviceSongMetadata({
      title: 'Not here',
      artist: 'A',
      duration: 100,
      source_url: 'https://youtu.be/not-here',
      source_platform: 'Youtube',
    })

    expect(await removeIncompleteSongs()).toBe(1)
    // The whole library is one bad `WHERE` away from this, which is why the
    // library it must not touch is asserted and not only the row it must.
    expect(await getLocalSong(complete)).not.toBeNull()
    expect(await getLocalSong(orphan)).toBeNull()
  })

  it('costs nothing on a healthy library', async () => {
    const localId = await saveDeviceSongMetadata({
      title: 'Fine',
      artist: 'A',
      duration: 100,
      source_url: 'https://youtu.be/fine',
      source_platform: 'Youtube',
    })
    await downloadAudioFromUrl(localId, 'https://cdn.example/a.opus', {}, { contentLength: 4096 })

    expect(await removeIncompleteSongs()).toBe(0)
    expect(await listLocalSongs()).toHaveLength(1)
  })
})

/**
 * The link between what this file throws and what the user is told (#441).
 *
 * `failureKind.ts` matches on messages, because `downloadAudioFromUrl` throws
 * bare `Error`s and there is nothing else to match on. That is a liability: a
 * reworded message would silently reclassify every failure of that kind as
 * `unknown`, and the classifier's own tests would still pass, because they
 * assert against copies of the strings rather than the strings themselves.
 *
 * These do not. They classify what real calls actually throw.
 */
describe('what the failures here are called', () => {
  const track = {
    title: 'Kind Test',
    artist: 'An Artist',
    duration: 100,
    source_url: 'https://www.youtube.com/watch?v=kinds',
    source_platform: 'Youtube',
  }

  async function thrownBy(fetchImpl: unknown): Promise<unknown> {
    globalThis.fetch = fetchImpl as typeof fetch
    const localId = await saveDeviceSongMetadata(track)
    try {
      await downloadAudioFromUrl(
        localId,
        'https://googlevideo.example/x',
        {},
        { contentLength: 4096 },
      )
      throw new Error('expected the download to fail')
    } catch (error) {
      return error
    }
  }

  it('records what googlevideo said when it refused (#647)', async () => {
    /*
     * Five sightings of this 403 and nobody has ever read the refusal — the
     * report has always been nine words, because a status and an offset is all
     * this file kept. On 2026-08-20 it was pinned to something inside the app
     * (curl on the same phone, same second, same address: 206) with six
     * mechanisms refuted, so the next step is to stop guessing better and make
     * the failure say more (#303).
     *
     * ⚠️ The store is reset first: `append` drops an entry identical to one
     * inside `REPEAT_WINDOW_MS`, and the #639 tests below log the same event —
     * so without this `find` returns *their* line and the assertions grade the
     * wrong reading. Green alone, red in the suite.
     */
    useDiagnostics.setState({ entries: [] })
    await thrownBy(
      jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        headers: { get: (h: string) => (h === 'content-type' ? 'text/plain' : null) },
        text: async () => 'Forbidden: no soup for you',
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    )

    const entry = useDiagnostics.getState().entries.find((e) => e.event === 'download.refused')
    expect(entry).toBeTruthy()
    expect(entry?.detail).toContain('status=403 at byte 0')
    // The host is a fact about Google's edge, not about the track.
    expect(entry?.detail).toContain('host=googlevideo.example')
    expect(entry?.detail).toContain('type=text/plain')
    // The body, which is the thing nobody has looked at.
    expect(entry?.detail).toContain('Forbidden: no soup for you')
  })

  it("records the bound address's family, never the address (#354)", async () => {
    /*
     * ⚠️ The first version of this test asserted the stream URL was absent, and
     * **a mutation logging the whole URL still passed it** — `scrub()` replaces
     * anything with a scheme, so that assertion graded `log.ts` rather than this
     * file. `diagnosticsScrub.test.ts` already owns that.
     *
     * What `scrub()` does *not* strip is a bare IP address, and `ip=` in a
     * googlevideo URL is the **user's own public address**. That is this
     * function's to get right, so that is what is asserted.
     */
    useDiagnostics.setState({ entries: [] })
    const localId = await saveDeviceSongMetadata({ ...track, source_url: 'https://y/ipfam' })
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => null },
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as unknown as typeof fetch
    await downloadAudioFromUrl(
      localId,
      'https://googlevideo.example/x?ip=203.0.113.7&gcr=gb',
      {},
      { contentLength: 4096 },
    ).catch(() => undefined)

    const entry = useDiagnostics.getState().entries.find((e) => e.event === 'download.refused')
    expect(entry?.detail).toContain('boundTo=ipv4')
    expect(entry?.detail).toContain('gcr=yes')
    // The thing that must never be there.
    expect(entry?.detail).not.toContain('203.0.113.7')
  })

  it('calls a real 403 on the first request a refusal at the start (#639)', async () => {
    const error = await thrownBy(
      jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    )
    // Nothing arrived, so `at byte 0` — the signature seen four times, which
    // clears on its own. `refused` would tell the user to find another source.
    expect(classifyFailure(error)).toBe('refused_at_start')
  })

  it('calls a real 403 part-way through an ordinary refusal (#639)', async () => {
    /*
     * The other edge, and the reason this guard is here rather than in
     * `failureKind.test.ts`: the two kinds are told apart by a byte offset that
     * **this file** writes, so only a real call proves the offset is the one
     * the regex expects.
     *
     * One chunk lands, then the next is refused — `refresh` is absent, so the
     * refusal is thrown rather than recovered.
     */
    let call = 0
    const error = await thrownBy(
      jest.fn().mockImplementation(async () => {
        call += 1
        if (call === 1) {
          return {
            ok: true,
            status: 206,
            headers: { get: () => 'bytes 0-2047/4096' },
            arrayBuffer: async () => new ArrayBuffer(2048),
          }
        }
        return {
          ok: false,
          status: 403,
          headers: { get: () => null },
          arrayBuffer: async () => new ArrayBuffer(0),
        }
      }),
    )
    expect((error as Error).message).toContain('at byte 2048')
    expect(classifyFailure(error)).toBe('refused')
  })

  it('calls a real empty body empty', async () => {
    const error = await thrownBy(
      jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    )
    expect(classifyFailure(error)).toBe('empty')
  })

  it('calls a real truncated download a timeout', async () => {
    // The #439 shape: bytes arrived, just not all of them.
    const error = await thrownBy(
      jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(1024),
      }),
    )
    expect(classifyFailure(error)).toBe('timed_out')
  })
})
