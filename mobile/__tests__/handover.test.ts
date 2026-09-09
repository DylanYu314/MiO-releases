import { useConnection } from '../src/api/connection'
import { loadInstallId } from '../src/api/installId'
import {
  handOverPlaylist,
  handOverSong,
  handoverContext,
  resetHandoverGuard,
} from '../src/library/handover'

/**
 * The handover, shared by all three ways to add music (#215).
 *
 * Two of them — search and a confirmed playlist import — put nothing on the
 * device at all before this existed, because the download lived inside a
 * progress panel only add-a-link mounted. These pin the shared path: it fetches
 * what it needs, it skips what is already here, and one song failing does not
 * take the rest of a playlist with it.
 */

const mockSave = jest.fn()
const mockLocal = new Map<number, { id?: string; file_uri: string | null }>()

const mockPlaylistFor = jest.fn()
const mockAddSongs = jest.fn()
jest.mock('../src/library/playlists', () => ({
  playlistForServerImport: (...args: unknown[]) => mockPlaylistFor(...args),
  addSongsToPlaylist: (...args: unknown[]) => mockAddSongs(...args),
}))

jest.mock('../src/library/songs', () => ({
  saveSongToDevice: (...args: unknown[]) => mockSave(...args),
  // Keyed by the *server's* id: this device mints its own (#246), so the
  // handover has to look up what it actually holds — a server song.
  getLocalSongByServerId: async (id: number) => mockLocal.get(id) ?? null,
}))

function song(id: number) {
  return { id, title: `Song ${id}`, artist: 'A' }
}

/** Answers `/songs/{id}` and `/playlists/{id}`, so one mock serves both paths. */
function respond(playlistItems: number[] = []) {
  globalThis.fetch = jest.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.includes('/playlists/')
        ? {
            id: 1,
            name: 'P',
            items: playlistItems.map((id) => ({ id, position: 0, song: song(id) })),
          }
        : song(Number(url.split('/songs/')[1])),
  })) as unknown as typeof fetch
}

beforeEach(async () => {
  await loadInstallId()
  mockSave.mockReset().mockImplementation(async (song: { id: number }) => `local-${song.id}`)
  mockPlaylistFor.mockReset().mockResolvedValue('local-playlist')
  mockAddSongs.mockReset().mockResolvedValue(0)
  mockLocal.clear()
  resetHandoverGuard()
  useConnection.setState({
    serverUrl: 'https://mio.test/api',
    accessKey: 'a-key',
    usingDefaultServer: true,
    loaded: true,
  })
  respond()
})

describe('handoverContext', () => {
  it('carries the install header, without which the audio endpoint 404s', () => {
    const context = handoverContext()
    expect(context?.serverUrl).toBe('https://mio.test/api')
    expect(context?.headers['X-Install-Id']).toBeDefined()
    expect(context?.headers['X-Unlock-Key']).toBe('a-key')
  })

  it('is null with no server, so a caller cannot download from nowhere', () => {
    useConnection.setState({ serverUrl: null })
    expect(handoverContext()).toBeNull()
  })
})

describe('handOverSong', () => {
  it('fetches the row and puts the audio on the device', async () => {
    await handOverSong(5)

    expect(mockSave).toHaveBeenCalledTimes(1)
    const [saved, context] = mockSave.mock.calls[0]
    expect(saved.id).toBe(5)
    expect(context.headers['X-Install-Id']).toBeDefined()
  })

  it('skips a song whose audio is already here', async () => {
    mockLocal.set(5, { file_uri: 'file:///library/5.opus' })

    await handOverSong(5)

    // `file_uri` is a fact about the disk, so this is the whole re-download
    // guard: no extra bookkeeping, and it survives a reinstall of the store.
    expect(mockSave).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('re-downloads a row that exists without its audio', async () => {
    // The half-finished state the schema deliberately models: metadata written,
    // download failed. Skipping this would strand the song forever.
    mockLocal.set(5, { file_uri: null })

    await handOverSong(5)

    expect(mockSave).toHaveBeenCalledTimes(1)
  })

  it('throws when the download fails, so the caller leaves it unfinished', async () => {
    mockSave.mockRejectedValue(new Error('offline'))

    await expect(handOverSong(5)).rejects.toThrow('offline')
  })
})

describe('handOverPlaylist', () => {
  it('downloads every song a confirmed import produced', async () => {
    respond([1, 2, 3])

    const result = await handOverPlaylist(9)

    expect(result).toMatchObject({ saved: 3, failed: 0 })
    expect(mockSave.mock.calls.map(([s]) => s.id)).toEqual([1, 2, 3])
  })

  it('carries on past a song that fails, and counts it', async () => {
    respond([1, 2, 3])
    mockSave.mockImplementation(async (s: { id: number }) => {
      if (s.id === 2) throw new Error('offline')
    })

    const result = await handOverPlaylist(9)

    // Partial success is success and visible — the same rule the backend's own
    // import follows. One bad track must not cost the other ninety-nine.
    expect(result).toMatchObject({ saved: 2, failed: 1 })
    expect(mockSave).toHaveBeenCalledTimes(3)
  })

  it('resumes rather than restarts when songs are already here', async () => {
    respond([1, 2, 3])
    mockLocal.set(1, { file_uri: 'file:///library/1.opus' })
    mockLocal.set(2, { file_uri: 'file:///library/2.opus' })

    const result = await handOverPlaylist(9)

    expect(result).toMatchObject({ saved: 3, failed: 0 })
    expect(mockSave.mock.calls.map(([s]) => s.id)).toEqual([3])
  })

  it('returns null rather than a zero result when a run is already going', async () => {
    respond([1, 2])
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    mockSave.mockImplementation(() => blocked)

    // The guard is claimed synchronously, before the first await, which is what
    // makes a second call safe no matter how the two interleave.
    const first = handOverPlaylist(9)
    const second = await handOverPlaylist(9)

    // A joined run has downloaded nothing *itself*; reporting {saved: 0} would
    // read on screen as "no songs made it".
    expect(second).toBeNull()
    release()
    await first
  })

  it('lets the guard go when a run finishes, so a retry is possible', async () => {
    respond([1])
    mockSave.mockRejectedValueOnce(new Error('offline'))

    expect(await handOverPlaylist(9)).toMatchObject({ saved: 0, failed: 1 })
    expect(await handOverPlaylist(9)).toMatchObject({ saved: 1, failed: 0 })
  })
})

describe('the imported playlist exists on the device (#225)', () => {
  it('creates it and adds the songs in order', async () => {
    respond([1, 2, 3])

    const result = await handOverPlaylist(9)

    // Without this the import downloaded a pile of loose songs and its
    // "Open playlist" link pointed at a server id this phone never had.
    expect(mockPlaylistFor).toHaveBeenCalledWith(9, 'P')
    expect(mockAddSongs).toHaveBeenCalledWith('local-playlist', ['local-1', 'local-2', 'local-3'])
    expect(result?.local_playlist_id).toBe('local-playlist')
  })

  it('offers no playlist when nothing was imported', async () => {
    respond([1, 2])
    mockSave.mockRejectedValue(new Error('offline'))

    const result = await handOverPlaylist(9)

    // An import where every track failed still ends `done` with an empty
    // playlist — the case the old "not a failed import" guard let through.
    expect(result).toMatchObject({ saved: 0, failed: 2, local_playlist_id: null })
    expect(mockAddSongs).not.toHaveBeenCalled()
  })

  it('includes songs that were already on the device', async () => {
    respond([1, 2])
    mockLocal.set(1, { id: 'local-1', file_uri: 'file:///library/1.opus' })

    await handOverPlaylist(9)

    // Resuming a part-finished import must still put the whole playlist
    // together, not just the songs this run happened to fetch.
    expect(mockAddSongs).toHaveBeenCalledWith('local-playlist', ['local-1', 'local-2'])
  })
})

/**
 * Releasing the server's copy once the device has it (#221, ADR-017).
 *
 * The ordering is the whole thing. `saveSongToDevice` writes the bytes and only
 * then records `file_uri`; confirming any earlier would delete the copy the
 * download still needs — and the handover's own retry reads that copy, which is
 * why the trigger cannot be the job reaching `done`.
 */
describe('telling the server it can delete its copy (#221)', () => {
  const confirmCalls = () =>
    (globalThis.fetch as jest.Mock).mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/confirm-receipt'))

  it('confirms receipt after the audio is on the device', async () => {
    await handOverSong(5)

    expect(confirmCalls()).toEqual(['https://mio.test/api/songs/5/confirm-receipt'])
  })

  it('confirms after saving, never before', async () => {
    // Asserted as an order, not just as "both happened": a confirmation that
    // raced the download would delete the file it was reading.
    const order: string[] = []
    mockSave.mockImplementation(async () => {
      order.push('save')
      return 'local-5'
    })
    globalThis.fetch = jest.fn(async (url: string) => {
      if (String(url).includes('/confirm-receipt')) order.push('confirm')
      return { ok: true, status: 200, json: async () => song(5) }
    }) as unknown as typeof fetch

    await handOverSong(5)

    expect(order).toEqual(['save', 'confirm'])
  })

  it('does not confirm for a song that was already here', async () => {
    // Nothing was downloaded, so this device has said nothing new — and the
    // server may be holding that copy for a reason.
    mockLocal.set(5, { id: 'local-5', file_uri: 'file:///library/local-5.opus' })

    await handOverSong(5)

    expect(confirmCalls()).toEqual([])
  })

  it('still succeeds when the confirmation fails', async () => {
    /*
     * Best-effort on purpose. A confirmation that does not arrive costs the
     * server some disk; one that *throws* would fail a handover whose whole job
     * has already succeeded. The server keeps its copy and the next handover
     * returns early because the song is on the device.
     */
    globalThis.fetch = jest.fn(async (url: string) => {
      if (String(url).includes('/confirm-receipt')) {
        return { ok: false, status: 500, json: async () => ({ detail: 'boom' }) }
      }
      return { ok: true, status: 200, json: async () => song(5) }
    }) as unknown as typeof fetch

    await expect(handOverSong(5)).resolves.toBeUndefined()
    expect(mockSave).toHaveBeenCalledTimes(1)
  })
})
