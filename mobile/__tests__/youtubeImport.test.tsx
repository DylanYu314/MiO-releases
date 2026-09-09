import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { DatabaseSync } from 'node:sqlite'
import type { ReactNode } from 'react'
import { Alert } from 'react-native'

import ImportScreen from '../app/(tabs)/add/import/index'
import ImportDetailScreen from '../app/(tabs)/add/import/[id]'
import { useConnection } from '../src/api/connection'
import { useImportProgress, resetImportProgress } from '../src/api/importProgress'
import { forgetFinishedImports, rememberFinishedImport } from '../src/library/finishedImports'
import {
  addTracks,
  listMatches,
  setMatchCandidates,
  updateImport,
} from '../src/library/playlistImports'
import type { ImportStatus, Page, PlaylistImport } from '../src/api/types'
import { __resetLibraryTransactions } from '../src/library/db'
import { freshLibraryDb, seedImport } from '../src/test/localDb'
import '../src/i18n'

// `mock`-prefixed so the jest.mock factory may reference it — the factory is
// hoisted above every declaration, and jest only exempts names starting with
// "mock" from its out-of-scope guard (a convention in this repo).
const mockPush = jest.fn()
// `mock`-prefixed so the hoisted `jest.mock` factory may reference it.
let mockDb: DatabaseSync
jest.mock('../src/library/db', () => {
  const actual = jest.requireActual('../src/library/db')
  // ⚠️ `requireActual` inside the factory: it may not reference an out-of-scope
  // binding, and only `mock`-prefixed names are exempt.
  const { sqliteAdapter } = jest.requireActual('../src/test/localDb')
  return { ...actual, openLibraryDb: async () => sqliteAdapter(() => mockDb) }
})

const mockFetchPlaylist = jest.fn()
jest.mock('../src/library/youtubePlaylist', () => ({
  fetchYouTubePlaylist: (...args: unknown[]) => mockFetchPlaylist(...args),
}))

jest.mock('expo-router', () => ({
  // The guard reads the current path to know a navigation landed (#375).
  usePathname: () => '/',
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useLocalSearchParams: () => ({ id: '5' }),
  // The import screen re-reads Spotify status on focus (#203) — coming back
  // from the browser is a navigation, not a mount. Run the effect once, which
  // is what focusing a freshly mounted screen does.
  useFocusEffect: (effect: () => void) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react')
    React.useEffect(effect, [effect])
  },
}))

// The device import is its own unit; what this file cares about is that the
// screen drives it, and with what. Mocked also because the real one reaches
// `youtubei.js`, which is ESM and untransformed under jest.
const mockHandOverPlaylist = jest.fn()
jest.mock('../src/library/playlistImport', () => ({
  importPlaylistOnDevice: (...args: unknown[]) => mockHandOverPlaylist(...args),
}))

class FakeSocket {
  static last: FakeSocket | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { wasClean: boolean }) => void) | null = null
  close = jest.fn()

  constructor(public url: string) {
    FakeSocket.last = this
  }
}

function anImport(overrides: Partial<PlaylistImport> = {}): PlaylistImport {
  return {
    id: 5,
    service: 'youtube',
    account_id: null,
    external_playlist_id: 'https://www.youtube.com/playlist?list=PL1',
    name: 'Road trip mix',
    status: 'queued' as ImportStatus,
    track_count: null,
    matched_count: 0,
    import_total: null,
    imported_count: 0,
    failed_count: 0,
    playlist_id: null,
    // A YouTube playlist has no matching phase at all (ADR-010), so the phone
    // never supplies candidates for one (#353).
    client_matches: false,
    error: null,
    created_at: '2026-07-30T00:00:00Z',
    updated_at: '2026-07-30T00:00:00Z',
    ...overrides,
  }
}

/**
 * Real `auto_matched` rows for import `5`, so `importableCount` is not zero.
 *
 * The confirm mutation reads that count into `import_total`, and the handover
 * refuses to start on an import with nothing accepted — so a test that seeds
 * only the import row proves nothing about confirming (#655).
 */
async function seedAutoMatched(count: number): Promise<void> {
  await addTracks(
    '5',
    Array.from({ length: count }, (_, i) => ({
      external_id: `vid${i}`,
      title: `Track ${i}`,
      artist: 'An Artist',
      duration_s: 200,
    })),
  )
  for (const row of await listMatches('5')) {
    await setMatchCandidates(
      row.id,
      [
        {
          url: `https://www.youtube.com/watch?v=${row.external_id}`,
          title: row.title,
          uploader: null,
          duration: 200,
          score: null,
          source: 'youtube',
        },
      ],
      'auto_matched',
    )
  }
}

function page(items: PlaylistImport[]): Page<PlaylistImport> {
  return { items, total: items.length, limit: 20, offset: 0 }
}

/**
 * Answer every request with `body` — except the ones that cannot be an import.
 *
 * The detail screen asks for its matches too since #203 (`GET
 * …/matches`), and a fake that handed those an import object was **not a
 * cheaper server, it was a different one**: `getNextPageParam` reads
 * `items.length` off the answer, so the screen crashed on a shape no real
 * backend returns. `docs/lessons.md` has the general version of this — a fake
 * client validates the fake.
 *
 * So the two match routes get a real empty page. A test that cares what is in
 * them installs its own `fetch`.
 */
function respondWith(body: unknown, status = 200) {
  seedIfImport(body)
  globalThis.fetch = jest.fn(async (url: string) => ({
    ok: status < 400,
    status,
    json: async () => bodyFor(url, body),
  })) as unknown as typeof fetch
}

/** Every fetch fake in this file goes through here, including the hand-rolled
 *  ones, so none of them can answer `/matches` with an import. */
function bodyFor(url: string, body: unknown): unknown {
  return String(url).includes('/matches') ? page([]) : body
}

/**
 * ⚠️ An import fixture goes to **SQLite**, not to `fetch` (#611).
 *
 * The detail screen reads its import from the device now. Keeping the call
 * sites (`respondWith(playlistImport({...}))`) means a diff in this file is
 * about the *rows moving*, not about the screen behaving differently — which is
 * the only way to tell a port from a rewrite.
 *
 * A page of imports seeds each of them; the recent-imports list reads the same
 * table.
 */
function seedIfImport(body: unknown): void {
  const asPage = body as { items?: unknown[] }
  if (Array.isArray(asPage?.items)) {
    for (const item of asPage.items) seedIfImport(item)
    return
  }
  const row = body as Record<string, unknown>
  if (row && typeof row === 'object' && 'status' in row && 'id' in row) {
    seedImport(mockDb, String(row.id), { ...row, id: String(row.id) })
  }
}

/** The import row as it stands, which is where these decisions land now. */
function storedImport(id = '5') {
  return mockDb.prepare(`SELECT * FROM playlist_imports WHERE id = ?`).get(id) as
    Record<string, unknown> | undefined
}

/** The client the last render used, so a test can watch what got invalidated. */
let lastClient: QueryClient | null = null

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  })
  lastClient = client
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(async () => {
  jest.clearAllMocks()
  __resetLibraryTransactions()
  mockDb = freshLibraryDb()
  resetImportProgress()
  await forgetFinishedImports()
  mockHandOverPlaylist.mockResolvedValue({
    saved: 0,
    failed: 0,
    gaveUp: false,
    local_playlist_id: 'lp',
  })
  FakeSocket.last = null
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket
  useConnection.setState({
    serverUrl: 'https://mio.test/api',
    accessKey: 'a-key',
    usingDefaultServer: true,
    loaded: true,
  })
})

describe('ImportScreen', () => {
  it('reads the playlist on the device and opens the new import', async () => {
    /*
     * ⚠️ Was "posts the playlist URL to the YouTube endpoint" (#622). The
     * listing happens here now, so there is no endpoint — and the assertion
     * that matters became "no request was made at all", which is the claim.
     */
    const calls: string[] = []
    globalThis.fetch = jest.fn(async (url: string) => {
      calls.push(String(url))
      // `/spotify/status` is legitimately still the server's — Spotify is the
      // one source whose fetch has not moved (#612). Everything else must not
      // be asked for.
      return { ok: true, status: 200, json: async () => ({ configured: false, accounts: [] }) }
    }) as unknown as typeof fetch
    mockFetchPlaylist.mockResolvedValue({
      playlistId: 'PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb',
      name: 'Road trip mix',
      tracks: [
        {
          videoId: 'dQw4w9WgXcQ',
          title: 'First song',
          uploader: 'A Channel',
          durationSeconds: 212,
          thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        },
      ],
    })

    await render(<ImportScreen />, { wrapper })
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText('Import a YouTube playlist'),
        'https://www.youtube.com/playlist?list=PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb',
      )
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Import'))
    })

    const local = mockDb.prepare(`SELECT id, name FROM playlist_imports`).all() as {
      id: string
      name: string
    }[]
    await waitFor(() => expect(local).toHaveLength(1))
    expect(local[0].name).toBe('Road trip mix')
    expect(mockPush).toHaveBeenCalledWith(`/add/import/${local[0].id}`)

    // ⚠️ An entry is its own candidate (ADR-014), so it arrives already chosen
    // and *unscored* — a confidence here would be a measurement nobody made.
    const row = mockDb.prepare(`SELECT * FROM track_matches`).get() as Record<string, unknown>
    expect(row.status).toBe('auto_matched')
    expect(row.chosen_url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(row.confidence).toBeNull()
    /*
     * The wiring, not the ingredient (#635, and #561's lesson).
     *
     * `youtubePlaylist.ts` reading the art is worth nothing if the candidate is
     * built without it — which is exactly what happened: the listing carried
     * four fields, the candidate copied those four, and the review row drew an
     * empty square while a Spotify import against the same source had art.
     */
    expect(JSON.parse(row.candidates as string)[0].thumbnail).toBe(
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    )
    expect(calls.filter((url) => url.includes('/playlist-imports'))).toEqual([])
  })

  it('lists imports already under way, so a long one can be found again', async () => {
    // An import is tens of minutes. Starting one and walking away only works if
    // it is still reachable afterwards.
    respondWith(page([anImport({ status: 'importing', imported_count: 12, import_total: 40 })]))

    await render(<ImportScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('Road trip mix')).toBeTruthy())
    // **Not** "12 of 40". Those are the server's counters, and the server has
    // downloaded nothing since confirm began sending `download: false` (#270) —
    // so the row said "12 of 40" for an import this device had never fetched.
    expect(screen.queryByText('Downloading · 12 of 40')).toBeNull()
  })

  it('counts what this device has fetched, live, while a run is going', async () => {
    respondWith(page([anImport({ status: 'importing', imported_count: 0, import_total: 40 })]))
    useImportProgress.getState().report('5', {
      done: 7,
      total: 13,
      title: 'A track',
      phase: 'downloading',
      failed: 0,
      saved: 7,
      attempt: 1,
      alreadyHere: 0,
    })

    await render(<ImportScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('Downloading · 7 of 13')).toBeTruthy())
  })

  it('shows what the last run managed, once it has finished', async () => {
    respondWith(page([anImport({ status: 'done', imported_count: 0, import_total: 40 })]))
    await rememberFinishedImport('5', {
      saved: 13,
      failed: 0,
      duplicates: 0,
      gaveUp: false,
      local_playlist_id: 'p1',
    })

    await render(<ImportScreen />, { wrapper })

    // "13 of 13", not "0 of 40" — and it stays that way on re-entry, which is
    // the whole point of recording it.
    await waitFor(() => expect(screen.getByText('Done · 13 of 13')).toBeTruthy())
  })

  /**
   * ⚠️ **Replaces "shows a lock rather than an error when importing needs a
   * key" (#622).**
   *
   * That lock rendered on a 401 from `POST /playlist-imports/youtube`. The
   * listing is on the device now, so this screen makes no request and the lock
   * can never fire — a test for it could not fail, and the screen no longer has
   * one to show.
   *
   * The replacement asserts the behaviour that took its place, which is the
   * whole point of #608: the access key gates a **self-hoster's** server, never
   * a user's own playlist.
   */
  it('imports with no server and no access key at all', async () => {
    useConnection.setState({
      serverUrl: null,
      accessKey: null,
      usingDefaultServer: false,
      loaded: true,
    })
    mockFetchPlaylist.mockResolvedValue({
      playlistId: 'PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb',
      name: 'Road trip mix',
      tracks: [
        {
          videoId: 'dQw4w9WgXcQ',
          title: 'First song',
          uploader: 'A Channel',
          durationSeconds: 212,
          thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        },
      ],
    })

    await render(<ImportScreen />, { wrapper })
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText('Import a YouTube playlist'),
        'https://www.youtube.com/playlist?list=PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb',
      )
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Import'))
    })

    await waitFor(() =>
      expect(mockDb.prepare(`SELECT id FROM playlist_imports`).all()).toHaveLength(1),
    )
    expect(screen.queryByText('Importing is locked')).toBeNull()
  })

  it('will not submit an empty URL', async () => {
    respondWith(page([]))

    await render(<ImportScreen />, { wrapper })
    const before = (globalThis.fetch as jest.Mock).mock.calls.length
    await act(async () => {
      fireEvent.press(screen.getByText('Import'))
    })

    expect((globalThis.fetch as jest.Mock).mock.calls.length).toBe(before)
  })
})

describe('ImportDetailScreen', () => {
  it('offers Confirm only at review, because nothing downloads unasked', async () => {
    respondWith(anImport({ status: 'review', track_count: 40 }))

    await render(<ImportDetailScreen />, { wrapper })

    // "Download 0 tracks", not "Confirm & download": the count comes from the
    // matches, and this fake has none. The wording is the point of #203's
    // confirm button — see the count test below.
    await waitFor(() => expect(screen.getByText('Download 0 tracks')).toBeTruthy())
    expect(screen.getByText('40 tracks')).toBeTruthy()
  })

  it('hides Confirm while still fetching, so it cannot be pressed early', async () => {
    respondWith(anImport({ status: 'fetching' }))

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('Fetching')).toBeTruthy())
    expect(screen.queryByText(/^Download \d+ tracks?$/)).toBeNull()
  })

  it('confirming starts the download phase', async () => {
    respondWith(anImport({ status: 'review', track_count: 3 }))

    await render(<ImportDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Download 0 tracks')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByText('Download 0 tracks'))
    })

    // The confirm is a local write now, not `POST …/confirm` — but it still has
    // to be the only way past review, which is what the status proves.
    await waitFor(() => expect(storedImport()?.status).toBe('importing'))
    await waitFor(() => expect(screen.getByText('Downloading')).toBeTruthy())
  })

  /**
   * The two halves, joined (#655).
   *
   * ⚠️ **This suite already asserted both ends and never the middle.**
   * *"confirming starts the download phase"* proves confirm writes `importing`;
   * *"fetches the accepted tracks onto the device once confirmed"* proves the
   * handover runs when the status is `done`. Both passed, and together they
   * described an app where confirming a playlist downloads nothing at all —
   * which is what I hit on 2026-08-20: twelve tracks listed, matched,
   * confirmed, then 12/12 failed with no summary and **nothing in the log**,
   * because the loop that writes those log lines never ran.
   *
   * The server used to move `importing` → `done`; #611 took the server away and
   * nothing took over the transition. So the test is one press to one call.
   */
  it('runs the download loop after a real confirm, not just a seeded status (#655)', async () => {
    mockHandOverPlaylist.mockResolvedValue({
      saved: 3,
      failed: 0,
      duplicates: 0,
      gaveUp: false,
      local_playlist_id: 'lp',
    })
    respondWith(anImport({ status: 'review', track_count: 3 }))
    await seedAutoMatched(3)

    await render(<ImportDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Download 3 tracks')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByText('Download 3 tracks'))
    })

    await waitFor(() => expect(mockHandOverPlaylist).toHaveBeenCalled())
  })

  it('shows the finished status without leaving the screen (#659)', async () => {
    /*
     * The run writes `status: 'done'` to SQLite (#655) and the screen already
     * watching kept its cached `importing`, so the header read "Downloading"
     * after the run had ended — corrected only by navigating away and back.
     * Measured on the device: 12/12 downloaded, the row correct on disk, the
     * open screen still wrong.
     */
    mockHandOverPlaylist.mockImplementation(async () => {
      // What the real loop does before it returns: the row reaches a terminal
      // state. The screen has to notice.
      await updateImport('5', { status: 'done', imported_count: 3, failed_count: 0 })
      return { saved: 3, failed: 0, duplicates: 0, gaveUp: false, local_playlist_id: 'lp' }
    })
    respondWith(anImport({ status: 'review', track_count: 3 }))
    await seedAutoMatched(3)

    await render(<ImportDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Download 3 tracks')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByText('Download 3 tracks'))
    })

    // Without the invalidation this stays "Downloading" for the life of the
    // screen.
    await waitFor(() => expect(screen.getByText('Done')).toBeTruthy())
  })

  /**
   * ⚠️ **Replaces "follows the import over the socket" (#611).**
   *
   * The WebSocket existed to hear about work happening on the server. The work
   * happens here now, so there is no socket and nothing to hear — but the half
   * of that test which was really about #308 still matters, and it is the half
   * kept below: the screen must **not** draw progress from `imported_count`.
   *
   * That counter stopped moving the moment confirm began sending
   * `download: false` (#270) — the server accepted the matches and downloaded
   * nothing — so a bar drawn from it read "0 of 13" for an import that was
   * working, which is exactly what I reported.
   */
  it("never draws progress from the import row's own counters (#308)", async () => {
    respondWith(anImport({ status: 'importing', import_total: 40, imported_count: 20 }))

    await render(<ImportDetailScreen />, { wrapper })

    // The status is still the row's and still matters.
    await waitFor(() => expect(screen.getByText('Downloading')).toBeTruthy())
    // Its counters are not. Showing "20 of 40" would be inventing progress no
    // device has made.
    expect(screen.queryByText('20 of 40')).toBeNull()
  })

  it('reports what reached the device, not what the server managed', async () => {
    // Partial success is success, and visible — but the count that matters is
    // the device's now. The server's `failed_count` describes a download it no
    // longer performs (#268).
    mockHandOverPlaylist.mockResolvedValue({
      saved: 37,
      failed: 3,
      gaveUp: false,
      local_playlist_id: 'lp',
    })
    respondWith(
      anImport({
        status: 'done',
        import_total: 40,
        imported_count: 37,
        failed_count: 3,
        playlist_id: 9,
      }),
    )

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('37 songs are on this device.')).toBeTruthy())
    expect(
      screen.getByText(
        "3 songs couldn't be saved to this device. Open this import again to retry.",
      ),
    ).toBeTruthy()
    // The link needs a local playlist and something actually imported (#225).
    expect(screen.getByText('Open the playlist (37 songs)')).toBeTruthy()
  })

  /**
   * The device fetches the tracks (#268).
   *
   * `done` now means the server accepted the matches and enqueued nothing, so
   * it is the *start* of the device's work rather than the end of the server's
   * — and `import_total` is what it accepted.
   */
  it('fetches the accepted tracks onto the device once confirmed', async () => {
    mockHandOverPlaylist.mockResolvedValue({
      saved: 2,
      failed: 0,
      gaveUp: false,
      local_playlist_id: 'lp',
    })
    respondWith(anImport({ status: 'done', import_total: 2, playlist_id: 9 }))

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() =>
      expect(mockHandOverPlaylist).toHaveBeenCalledWith(
        '5',
        'Road trip mix',
        // The third argument is the per-track callback: it invalidates the
        // library *and* the playlists so both fill in as songs land, rather
        // than after a restart. Progress no longer arrives this way — it goes
        // to `useImportProgress`, so a screen that joins a run half way
        // through can read it too.
        expect.anything(),
      ),
    )
    await waitFor(() => expect(screen.getByText('2 songs are on this device.')).toBeTruthy())
  })

  it('refreshes the library **and** the playlists as each song lands', async () => {
    respondWith(anImport({ status: 'done', import_total: 2, imported_count: 0 }))
    // Run the per-track callback the screen hands in, which is what happens
    // each time a song finishes downloading.
    mockHandOverPlaylist.mockImplementation(
      async (_id: number, _name: string, onSaved: (localId: string) => void) => {
        onSaved('local-1')
        return { saved: 1, failed: 0, duplicates: 0, gaveUp: false, local_playlist_id: 'p1' }
      },
    )

    await render(<ImportDetailScreen />, { wrapper })
    await waitFor(() => expect(mockHandOverPlaylist).toHaveBeenCalled())
    const invalidated = jest.spyOn(lastClient!, 'invalidateQueries')
    await act(async () => {
      mockHandOverPlaylist.mock.calls[0][2]('local-2')
    })

    // Two roots, not one. The library and the playlists are separate keys, and
    // invalidating only the library left the playlist page showing its cache —
    // "I have to close the app and re-enter".
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ['local-library'] })
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ['local-playlists'] })
  })

  it('says which songs did not make it to the device', async () => {
    mockHandOverPlaylist.mockResolvedValue({
      saved: 1,
      failed: 1,
      gaveUp: false,
      local_playlist_id: 'lp',
    })
    respondWith(anImport({ status: 'done', import_total: 2, playlist_id: 9 }))

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() =>
      expect(
        screen.getByText(
          "1 song couldn't be saved to this device. Open this import again to retry.",
        ),
      ).toBeTruthy(),
    )
  })

  /**
   * The summary survives leaving the screen (2026-08-10 device pass).
   *
   * `result` is component state, and it is what draws "N couldn't be saved" and
   * the **try-the-failures** button. Leaving the screen threw it away, and
   * coming back could not rebuild it: the durable record makes the loop return
   * null, so nothing ever set it again. The button existed for one visit.
   *
   * I hit it by tapping the failed track in my library and coming back —
   * the most natural thing to do with a failed track — and reported it as the
   * library making the button disappear. Leaving the screen at all did.
   */
  it('shows what the last run managed after the screen is reopened', async () => {
    await rememberFinishedImport('5', {
      saved: 15,
      failed: 2,
      duplicates: 0,
      gaveUp: false,
      local_playlist_id: 'lp',
    })
    // Exactly what a reopened screen sees: the record says this import is done,
    // so the loop declines to run and reports no outcome of its own.
    mockHandOverPlaylist.mockResolvedValue(null)
    respondWith(anImport({ status: 'done', import_total: 17, playlist_id: 9 }))

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() =>
      expect(
        screen.getByText(
          "2 songs couldn't be saved to this device. Open this import again to retry.",
        ),
      ).toBeTruthy(),
    )
    // The way back to those two tracks, which is the thing that went missing.
    expect(screen.getByText(/Try the 2 tracks that failed/)).toBeTruthy()
  })

  /**
   * A run that throws said nothing at all (#634).
   *
   * `usePlaylistHandover` has returned `failure` since #308 and nothing ever
   * rendered it, so when `importPlaylistOnDevice` threw — as opposed to
   * finishing with failed tracks — the screen showed no error, no counts and no
   * retry, because every summary block is gated on `result`. I reported
   * exactly that shape twice on 2026-08-20.
   */
  it('says why a run stopped, and offers a way back (#634)', async () => {
    mockHandOverPlaylist.mockRejectedValue(new Error('Bilibili refused with status 412'))
    respondWith(anImport({ status: 'done', import_total: 4, playlist_id: 9 }))

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() =>
      expect(screen.getByText('Import failed: Bilibili refused with status 412')).toBeTruthy(),
    )
    expect(screen.getByText('Try again')).toBeTruthy()
  })

  it('runs the loop again when the way back is taken (#634)', async () => {
    mockHandOverPlaylist.mockRejectedValue(new Error('Bilibili refused with status 412'))
    respondWith(anImport({ status: 'done', import_total: 4, playlist_id: 9 }))

    await render(<ImportDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Try again')).toBeTruthy())

    // The second run succeeds, which is the point: the failure is not terminal
    // and nothing was recorded as finished, so the ordinary loop can just run.
    mockHandOverPlaylist.mockReset().mockResolvedValue({
      saved: 4,
      failed: 0,
      duplicates: 0,
      gaveUp: false,
      local_playlist_id: 'lp',
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Try again'))
    })

    await waitFor(() => expect(screen.getByText('4 songs are on this device.')).toBeTruthy())
    expect(screen.queryByText(/Import failed/)).toBeNull()
  })

  it('does not try when the import produced nothing', async () => {
    // An import where every track failed still ends `done`, with an empty
    // playlist — there is nothing to fetch.
    respondWith(anImport({ status: 'done', import_total: 0, failed_count: 3, playlist_id: 9 }))

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('Done')).toBeTruthy())
    expect(mockHandOverPlaylist).not.toHaveBeenCalled()
  })

  it("picks up an import left in `importing`, which is now the device's state (#655)", async () => {
    /*
     * ⚠️ **This test asserted the opposite** — "does not try while the server is
     * still downloading" — and it was right when a server existed: `importing`
     * meant *the server is fetching*, and handing over mid-run would have
     * downloaded a slice and called it the whole playlist.
     *
     * There is no server (#608). `useConfirmImport` writes `importing` and
     * nothing else ever does, so the state now means exactly *the user
     * confirmed and this device owes them a download*. Refusing it was why a
     * confirmed import ran nothing at all.
     *
     * It is also what heals the records already stranded in `importing` on a
     * phone: opening one runs it.
     */
    respondWith(anImport({ status: 'importing', import_total: 40, imported_count: 12 }))

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() => expect(mockHandOverPlaylist).toHaveBeenCalled())
  })
  it('offers no playlist link when nothing was imported (#225)', async () => {
    // `run_confirmed_import` creates the playlist before downloading and always
    // ends `done` unless the orchestration throws, so an import where every
    // track failed used to offer a link to an empty playlist.
    mockHandOverPlaylist.mockResolvedValue({
      saved: 0,
      failed: 3,
      gaveUp: false,
      local_playlist_id: 'lp',
    })
    respondWith(anImport({ status: 'done', import_total: 0, failed_count: 3, playlist_id: 9 }))

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('Done')).toBeTruthy())
    expect(screen.queryByText(/Open the playlist/)).toBeNull()
  })
})

describe('tidying the import list (#224)', () => {
  it('removes a single record, succeeded or failed', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    respondWith(page([anImport({ status: 'failed', name: 'Broken mix' })]))

    await render(<ImportScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Broken mix')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Delete import Broken mix'))
    })

    // Confirmed first: it cannot be undone, and the message has to say the
    // music stays — "delete" beside a list of imports reads the other way.
    const [title, message, buttons] = alert.mock.calls[0]
    expect(title).toBe('Delete import?')
    expect(message).toContain('stay')
    // Nothing is gone until the confirmation is answered.
    expect(storedImport()).toBeTruthy()

    await act(async () => {
      ;(buttons as { text: string; onPress?: () => void }[])
        .find((button) => button.text === 'Delete')
        ?.onPress?.()
    })

    // Gone from the device, which is where the record lives now.
    await waitFor(() => expect(storedImport()).toBeUndefined())
    alert.mockRestore()
  })
})

describe('retrying the tracks that failed (#223)', () => {
  it('offers it when some tracks failed, and posts retry-failed', async () => {
    respondWith(anImport({ status: 'done', imported_count: 37, failed_count: 3, playlist_id: 9 }))

    await render(<ImportDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Retry failed')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByText('Retry failed'))
    })

    // Only the failed tracks: the successful ones keep their songs, so this is
    // not a second import of the whole playlist. The run is local now, so what
    // is asserted is the state it leaves rather than the request it sent.
    await waitFor(() => expect(storedImport()?.status).toBe('importing'))
    expect(storedImport()?.failed_count).toBe(0)
  })

  it('does not offer it when nothing failed', async () => {
    respondWith(anImport({ status: 'done', imported_count: 40, failed_count: 0, playlist_id: 9 }))

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('Done')).toBeTruthy())
    expect(screen.queryByText('Retry failed')).toBeNull()
  })
})

describe("the server's failure count is not the truth any more (#268)", () => {
  it('hides it once the device has reported', async () => {
    // I hit this: the import said "3 tracks failed to download" while the
    // tracks were sitting in my library. `failed_count` describes a *server*
    // download — an older attempt on the same import — and the device had just
    // fetched them all successfully.
    mockHandOverPlaylist.mockResolvedValue({
      saved: 3,
      failed: 0,
      gaveUp: false,
      local_playlist_id: 'lp',
    })
    respondWith(anImport({ status: 'done', import_total: 3, imported_count: 0, failed_count: 3 }))

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('3 songs are on this device.')).toBeTruthy())
    expect(screen.queryByText(/failed to download/)).toBeNull()
    // Retrying the *server's* download is retrying the thing that does not
    // work; the way back for a missed track is tapping it in the library.
    expect(screen.queryByText('Retry failed')).toBeNull()
  })

  it('still shows it for an import the server did download', async () => {
    // A legacy import, or one confirmed from the web: there the count is real
    // and the retry is the right offer.
    mockHandOverPlaylist.mockImplementation(() => new Promise(() => {}))
    respondWith(
      anImport({ status: 'importing', import_total: 40, imported_count: 37, failed_count: 3 }),
    )

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText(/3 tracks failed to download/)).toBeTruthy())
  })
})

/**
 * Every phase says where it has got to (#312).
 *
 * I asked for a progress bar for fetching, matching and downloading, and
 * the first two showed nothing at all. They are not the same kind of wait, and
 * these assert that the difference is honoured rather than papered over.
 */
describe('progress through the phases (#312)', () => {
  it('says what fetching is doing, since it has nothing countable to show', async () => {
    // The tracklist arrives in one go and `track_count` only exists afterwards,
    // so a bar here could only be an animation shaped like information.
    respondWith(anImport({ status: 'fetching', track_count: null }))

    await render(<ImportDetailScreen />, { wrapper })

    expect(await screen.findByText('Fetching your tracks from Spotify...')).toBeTruthy()
  })

  it('counts matching, which genuinely can be counted', async () => {
    respondWith(anImport({ status: 'matching', track_count: 40, matched_count: 12 }))

    await render(<ImportDetailScreen />, { wrapper })

    expect(await screen.findByText('12 of 40')).toBeTruthy()
  })

  it('does not claim to be fetching once it is matching', async () => {
    // The phases are exclusive; showing both would be two answers to one
    // question.
    respondWith(anImport({ status: 'matching', track_count: 40, matched_count: 1 }))

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('1 of 40')).toBeTruthy())
    expect(screen.queryByText('Fetching your tracks from Spotify...')).toBeNull()
  })

  it('shows no phase progress once it is waiting for a human', async () => {
    // `review` is not a wait the app is doing anything about, and a bar there
    // would suggest otherwise.
    respondWith(anImport({ status: 'review', track_count: 40, matched_count: 40 }))

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('Ready for review')).toBeTruthy())
    expect(screen.queryByText('Fetching your tracks from Spotify...')).toBeNull()
    expect(screen.queryByText('40 of 40')).toBeNull()
  })
})

describe('what a finished run says about itself (#567)', () => {
  /*
   * 2026-08-17: *"it just displayed failed for every track in the list,
   * and somehow displayed 4/4 done (but when open the finished playlist of
   * course I has nothing there), it was a 18 tracks playlist"*.
   *
   * The summary underneath was telling the truth the whole time — "0 songs are
   * on this device", "4 songs couldn't be saved". **The bar is what gets
   * read**, and it said "4 of 4" at 100%. `done` is `saved + failed`, which is
   * right for a progress bar and wrong as a verdict.
   *
   * (The other half of that report — why 18 became 4 at all — is #585, on the
   * server: `list_playlist` dropped the entries it could not read and recorded
   * the survivors as the playlist's size.)
   */
  it('does not read as success when every track failed', async () => {
    respondWith(anImport({ status: 'done', import_total: 4 }))
    mockHandOverPlaylist.mockResolvedValue({
      saved: 0,
      failed: 4,
      gaveUp: false,
      local_playlist_id: 'lp',
    })

    await render(<ImportDetailScreen />, { wrapper })

    // The failures are *in* the count line now, not only in a sentence further
    // down that a full bar has already contradicted.
    await waitFor(() => expect(screen.getByText('4 of 4 · 4 failed')).toBeTruthy())
    expect(screen.queryByText('4 of 4')).toBeNull()
    // And said plainly, first: "0 songs are on this device" is technically true
    // and reads like a rounding error.
    expect(screen.getByText(/Nothing was saved/)).toBeTruthy()
  })

  it('still reads as success when everything worked', async () => {
    // The control. A change that simply always appended "failed" would pass the
    // test above and be worse than the bug.
    respondWith(anImport({ status: 'done', import_total: 13 }))
    mockHandOverPlaylist.mockResolvedValue({
      saved: 13,
      failed: 0,
      gaveUp: false,
      local_playlist_id: 'lp',
    })

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('13 of 13')).toBeTruthy())
    expect(screen.queryByText(/Nothing was saved/)).toBeNull()
    expect(screen.queryByText(/failed/)).toBeNull()
  })

  it('names the failures on a partly successful run too', async () => {
    // Partial success is success and visible — the rule since #398 — but the
    // count line must not hide the other half of it.
    respondWith(anImport({ status: 'done', import_total: 13 }))
    mockHandOverPlaylist.mockResolvedValue({
      saved: 11,
      failed: 2,
      gaveUp: false,
      local_playlist_id: 'lp',
    })

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('13 of 13 · 2 failed')).toBeTruthy())
    // Not "nothing was saved" — eleven songs were.
    expect(screen.queryByText(/Nothing was saved/)).toBeNull()
  })

  it('explains a total smaller than the playlist while it runs', async () => {
    /*
     * `alreadyHere` has been published since #398 and shown by nothing, which
     * left "47 of 53" with nothing to reconcile it. I reported that gap at
     * the time and it was answered with honest arithmetic and no sentence.
     */
    respondWith(anImport({ status: 'done', import_total: 53 }))
    mockHandOverPlaylist.mockResolvedValue({
      saved: 3,
      failed: 0,
      gaveUp: false,
      local_playlist_id: 'lp',
    })
    useImportProgress.getState().report('5', {
      done: 3,
      total: 6,
      title: 'A track',
      phase: 'downloading',
      failed: 0,
      saved: 3,
      attempt: 1,
      alreadyHere: 47,
    })

    await render(<ImportDetailScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('3 of 6')).toBeTruthy())
    expect(screen.getByText(/47 tracks were already on this device/)).toBeTruthy()
  })
})
