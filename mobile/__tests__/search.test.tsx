import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'

import SearchScreen from '../app/(tabs)/add/search'
import { useActiveImports } from '../src/api/activeImports'
import { useDeviceAdds } from '../src/api/deviceAdds'
import { useSearchUi } from '../src/api/search'
import { useSearchSource } from '../src/library/searchSource'
import { useConnection } from '../src/api/connection'
import type { SearchResult } from '../src/api/types'
import '../src/i18n'

const mockImportToDevice = jest.fn()
jest.mock('../src/library/deviceImport', () => ({
  importToDevice: (...args: unknown[]) => mockImportToDevice(...args),
}))

/**
 * Searching YouTube happens on the device since #353, so the screen no longer
 * reaches `GET /search` for it and `globalThis.fetch` is not where the results
 * come from. The server path is still exercised below — through Bilibili, which
 * is the source that genuinely still needs it.
 */
const mockSearchOnDevice = jest.fn()
jest.mock('../src/library/deviceSearch', () => ({
  searchOnDevice: (...args: unknown[]) => mockSearchOnDevice(...args),
}))

/**
 * The screen asks the device library whether a result is already there (#376),
 * and `expo-sqlite` is native and absent under jest.
 */
const mockLocalSongs = jest.fn()
jest.mock('../src/library/songs', () => ({
  listLocalSongs: () => mockLocalSongs(),
}))

/** A library row, with the audio actually on disk unless told otherwise. */
function localSong(url: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    source_url: url,
    title: 'Whatever',
    artist: 'Someone',
    file_uri: 'file:///music/l1.opus',
    ...overrides,
  }
}

jest.mock('expo-router', () => ({
  // The guard reads the current path to know a navigation landed (#375).
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  /**
   * Runs the effect and its cleanup, the way a screen that is focused and then
   * left does — which is exactly what #319 is about: the query is cleared on
   * **blur**, so returning does not re-run the last search.
   */
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useEffect } = require('react')
    useEffect(effect, [effect])
  },
}))

function result(title: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    url: `https://youtube.com/watch?v=${title}`,
    title,
    uploader: 'A Channel',
    duration: 210,
    ...overrides,
  }
}

function respondWith(body: unknown, status = 200) {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  }) as unknown as typeof fetch
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    // `mutations` as well as `queries`: the Add button is a mutation, and a
    // queries-only gcTime leaves its collection timer holding the jest worker
    // open for five minutes (a convention in this repo).
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

async function searchFor(term: string) {
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText('Search'), term)
  })
  await act(async () => {
    fireEvent.press(screen.getByText('Search', { exact: true }))
  })
}

beforeEach(() => {
  // The query, input and platform now outlive the screen (#182), which means
  // they also outlive a test. Left alone, one test's search leaks into the next
  // and the failure looks like the screen ignoring a chip.
  useSearchUi.setState({
    input: '',
    query: '',
    platform: 'youtube',
    searchedPlatform: 'youtube',
    searchedSource: 'youtube',
    history: [],
  })
  // Persisted *and* module-level (#632): the picker's value survives a test
  // exactly as the query does, and a leaked 'bilibili' reads as the screen
  // ignoring the picker.
  useSearchSource.setState({ source: 'youtube' })
  // Persisted and module-level, so one test's import leaks into the next.
  useActiveImports.setState({ imports: [] })
  useDeviceAdds.setState({ adds: [] })
  mockImportToDevice
    .mockReset()
    .mockResolvedValue({ local_id: 'l1', title: 'T', artist: 'A', client: 'ANDROID_VR' })
  mockSearchOnDevice.mockReset().mockResolvedValue([])
  mockLocalSongs.mockReset().mockResolvedValue([])
  useConnection.setState({
    serverUrl: 'https://mio.test/api',
    accessKey: 'a-key',
    usingDefaultServer: true,
    loaded: true,
  })
})

describe('SearchScreen', () => {
  it('does not search until something is submitted', async () => {
    await render(<SearchScreen />, { wrapper })

    // A search reaches the upstream extractor and is slow; firing per keystroke
    // would be both useless and rude to the source.
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Search'), 'never mind')
    })
    expect(mockSearchOnDevice).not.toHaveBeenCalled()
  })

  it('searches YouTube on this device rather than through the server (#353)', async () => {
    // The server is refused by YouTube from a datacenter — 1 request in 14
    // (#177) — so the assertion that matters is the absence of a request.
    respondWith([])
    mockSearchOnDevice.mockResolvedValue([result('First'), result('Second')])

    await render(<SearchScreen />, { wrapper })
    await searchFor('bicycle')

    await waitFor(() => expect(screen.getByText('First')).toBeTruthy())
    expect(screen.getByText('Second')).toBeTruthy()
    // The source is **passed**, not read from module state inside the queryFn
    // (#632) — that is what makes it part of the query key.
    expect(mockSearchOnDevice).toHaveBeenCalledWith('bicycle', undefined, 'youtube')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('offers the source picker, and not the old server-platform chooser', async () => {
    // ⚠️ This test used to assert that *no* chooser existed. #240 removed
    // Bilibili from search because it was "rate-limited from outside China and
    // refusing roughly half of spaced requests" — and `docs/bilibili.md` §2.2
    // re-measured that on 2026-08-16: the endpoint serves 320 searches from one
    // address when paced at 1/s, and refuses only above ~1.9/s. The reason
    // expired, and #551 needs the choice anyway, because a user in mainland
    // China cannot reach YouTube at all.
    //
    // The *old* chooser is still gone: `PLATFORMS` selected a platform for the
    // server's `GET /search`, which the device replaced. What is here now is
    // the on-device source picker, which is a different control.
    respondWith([])

    await render(<SearchScreen />, { wrapper })

    expect(screen.queryByText('Bilibili (often rate-limited)')).toBeNull()
    expect(screen.getByText('YouTube')).toBeTruthy()
    expect(screen.getByText('Bilibili')).toBeTruthy()
  })

  it('passes a non-ASCII query through unmangled', async () => {
    // It used to be URL-encoded because it went into a query string. On the
    // device it is an argument, so the requirement inverted: encoding it now
    // would search for the literal text "%E8%87%AA...".
    await render(<SearchScreen />, { wrapper })
    await searchFor('自行车')

    await waitFor(() =>
      expect(mockSearchOnDevice).toHaveBeenCalledWith('自行车', undefined, 'youtube'),
    )
  })

  it('takes the platform on submit, so changing it searches nothing (#240)', async () => {
    respondWith([])

    await render(<SearchScreen />, { wrapper })
    await searchFor('bicycle')
    await waitFor(() => expect(mockSearchOnDevice).toHaveBeenCalledTimes(1))

    // The bug: `query` was snapshotted on submit and `platform` was read live,
    // so moving the platform moved half the query key and fired a search
    // against the *previous* term. The chips are hidden now, which hides the
    // symptom — this asserts the cause is gone.
    await act(async () => {
      useSearchUi.getState().setPlatform('bilibili')
    })
    await act(async () => {})

    expect(mockSearchOnDevice).toHaveBeenCalledTimes(1)
    expect(useSearchUi.getState().searchedPlatform).toBe('youtube')
  })

  /**
   * The source picker was not part of the search (#632).
   *
   * `searchOnDevice` read `currentSearchSource()` from module state inside the
   * `queryFn`, so TanStack could not see it: switching YouTube → Bilibili left
   * the query key untouched, pressing Search re-submitted the same string, and
   * the cache answered with the previous source's results. *"pressed
   * search button but didn't work."*
   */
  it('searches the newly chosen source when Search is pressed again (#632)', async () => {
    mockSearchOnDevice.mockResolvedValue([result('From YouTube')])

    await render(<SearchScreen />, { wrapper })
    await searchFor('稻香')
    await waitFor(() => expect(screen.getByText('From YouTube')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByText('Bilibili'))
    })
    mockSearchOnDevice.mockResolvedValue([result('From Bilibili')])

    // The same term, which is the case that failed: an unchanged query used to
    // mean an unchanged key.
    await act(async () => {
      fireEvent.press(screen.getByText('Search', { exact: true }))
    })

    await waitFor(() => expect(screen.getByText('From Bilibili')).toBeTruthy())
    expect(mockSearchOnDevice).toHaveBeenLastCalledWith('稻香', undefined, 'bilibili')
  })

  it('stops showing the other source results once the picker moves (#632)', async () => {
    mockSearchOnDevice.mockResolvedValue([result('From YouTube')])

    await render(<SearchScreen />, { wrapper })
    await searchFor('稻香')
    await waitFor(() => expect(screen.getByText('From YouTube')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByText('Bilibili'))
    })

    // *"the search result carried over to this page"*. They answer a
    // question that is no longer being asked.
    expect(screen.queryByText('From YouTube')).toBeNull()
    // ...and tapping the picker is not a search, so nothing was fetched for it.
    expect(mockSearchOnDevice).toHaveBeenCalledTimes(1)
  })

  it('runs a repeated search from history against the chosen source (#632)', async () => {
    mockSearchOnDevice.mockResolvedValue([result('From YouTube')])

    await render(<SearchScreen />, { wrapper })
    await searchFor('稻香')
    await waitFor(() => expect(screen.getByText('From YouTube')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByText('Bilibili'))
    })
    mockSearchOnDevice.mockResolvedValue([result('From Bilibili')])

    // The recent-search chip, which fills the box and submits — the second half
    // of the report, and the same cause.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Search for 稻香 again'))
    })

    await waitFor(() => expect(screen.getByText('From Bilibili')).toBeTruthy())
    expect(mockSearchOnDevice).toHaveBeenLastCalledWith('稻香', undefined, 'bilibili')
  })

  /**
   * Leaving the screen lost an add that was still running (#633).
   *
   * `importToDevice` has written `source: 'search'` records since #318 and
   * nothing on this screen read them — `DeviceAddList` was mounted on
   * `add/link.tsx` and the two import screens, and not here. `ResultRow` kept
   * its phase in `useState`, so a remount offered "Add" for a live download.
   */
  it('shows what this device is adding, from the durable record (#633)', async () => {
    useDeviceAdds.setState({
      adds: [
        {
          url: 'https://youtube.com/watch?v=Slow',
          source: 'search',
          status: 'working',
          title: 'Slow one',
          artist: 'A Channel',
          thumbnail: null,
          error: null,
          phase: 'downloading',
          attempt: 1,
          attempts: 4,
          startedAt: 1,
          finishedAt: null,
        },
      ],
    })

    // A screen that has never searched: exactly what "leave and come back"
    // renders, since the query is cleared on blur (#319).
    await render(<SearchScreen />, { wrapper })

    expect(screen.getByText('Slow one')).toBeTruthy()
  })

  it("does not show another page's adds", async () => {
    // `source` is what keeps each page's list its own (#318). A link added from
    // add-link has no business appearing under a search.
    useDeviceAdds.setState({
      adds: [
        {
          url: 'https://youtube.com/watch?v=Pasted',
          source: 'link',
          status: 'working',
          title: 'Pasted one',
          artist: null,
          thumbnail: null,
          error: null,
          startedAt: 1,
          finishedAt: null,
        },
      ],
    })

    await render(<SearchScreen />, { wrapper })

    expect(screen.queryByText('Pasted one')).toBeNull()
  })

  it('offers no second Add for a track already downloading (#633)', async () => {
    mockSearchOnDevice.mockResolvedValue([result('Slow')])
    useDeviceAdds.setState({
      adds: [
        {
          url: 'https://youtube.com/watch?v=Slow',
          source: 'search',
          status: 'working',
          title: 'Slow',
          artist: null,
          thumbnail: null,
          error: null,
          startedAt: 1,
          finishedAt: null,
        },
      ],
    })

    await render(<SearchScreen />, { wrapper })
    await searchFor('slow')
    /*
     * ⚠️ Wait for the **row's button**, not for the title.
     *
     * The first version waited on `getAllByText('Slow')`, which the record row
     * satisfies before the search has resolved — the record and the result are
     * the same track, which is the whole scenario. It passed on a laptop and
     * failed on CI, where the first `render()` in a worker costs ten times as
     * much (#279). A wait that the wrong element can satisfy is not a wait.
     */
    await waitFor(() => expect(screen.getByLabelText('Add')).toBeTruthy())

    // Pressing it would start a second `importToDevice` over the same file —
    // `saveDeviceSongMetadata` returns the same row for one `source_url`, so
    // both writes land on one path.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add'))
    })

    expect(mockImportToDevice).not.toHaveBeenCalled()
  })

  it('retries a recorded failure from the list, not from a row (#633)', async () => {
    // The record outlives the results, so the thing being retried need not be
    // on this page at all — the same reason `add/link.tsx` takes a URL.
    useDeviceAdds.setState({
      adds: [
        {
          url: 'https://youtube.com/watch?v=Failed',
          source: 'search',
          status: 'failed',
          title: 'Failed one',
          artist: null,
          thumbnail: null,
          error: 'Download refused with status 403 at byte 0',
          failure: 'refused',
          startedAt: 1,
          finishedAt: 2,
        },
      ],
    })

    await render(<SearchScreen />, { wrapper })
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Try adding Failed one again'))
    })

    expect(mockImportToDevice).toHaveBeenCalledWith('https://youtube.com/watch?v=Failed', {
      source: 'search',
    })
  })

  it('shows a visible lock when the server requires a key', async () => {
    /*
     * The ADR-009 lesson: a backend 401 is not a UX. A locked feature needs a
     * lock the user can act on, not a failed request.
     *
     * Driven through **Bilibili** since #353, because that is the only source
     * that still reaches the server — YouTube is searched on the device and
     * cannot answer 401 at all. The branch is kept rather than deleted so that
     * adding a server-backed source later is not silently unprotected, and this
     * is what keeps it covered.
     */
    respondWith({ detail: 'A valid access key is required to import' }, 401)
    useSearchUi.setState({ platform: 'bilibili' })

    await render(<SearchScreen />, { wrapper })
    await searchFor('anything')

    await waitFor(() => expect(screen.getByText('Importing is locked')).toBeTruthy())
    expect(screen.getByText('Add your invite key')).toBeTruthy()
  })

  it('explains a rate limit in the user language rather than the extractor error', async () => {
    // Bilibili, for the same reason as the lock above — and it is the source
    // the message was written for.
    respondWith({ detail: 'HTTP Error 412' }, 503)
    useSearchUi.setState({ platform: 'bilibili' })

    await render(<SearchScreen />, { wrapper })
    await searchFor('anything')

    await waitFor(() =>
      expect(
        screen.getByText(
          'This source is limiting requests right now. Wait a moment and search again.',
        ),
      ).toBeTruthy(),
    )
  })

  it('explains a device-side rate limit the same way (#586)', async () => {
    /*
     * ⚠️ The test above exercises the **server** path — `ApiError` 503 — and
     * that path has not been the one that fires since #353 moved searching onto
     * the phone. A device refusal is a `SearchRefused`, and it fell through to
     * `error.message`, so the screen showed the raw English "Bilibili search
     * refused: HTTP 412" while a translated string for exactly this sat unused.
     *
     * The string existed, was translated into both languages, and was wired to
     * a condition that no longer happened — the #561 shape again.
     */
    const refusal = new Error('Bilibili search refused: HTTP 412')
    refusal.name = 'SearchRefused'
    mockSearchOnDevice.mockRejectedValue(refusal)

    await render(<SearchScreen />, { wrapper })
    await searchFor('anything')

    await waitFor(() =>
      expect(
        screen.getByText(
          'This source is limiting requests right now. Wait a moment and search again.',
        ),
      ).toBeTruthy(),
    )
    expect(screen.queryByText(/HTTP 412/)).toBeNull()
  })

  it('fetches a YouTube result on this device, not through the server', async () => {
    respondWith([])
    mockSearchOnDevice.mockResolvedValue([result('Pick me')])

    await render(<SearchScreen />, { wrapper })
    await searchFor('pick')
    await waitFor(() => expect(screen.getByText('Pick me')).toBeTruthy())

    const before = (globalThis.fetch as jest.Mock).mock.calls.length
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add'))
    })

    // This used to create a server job, inheriting the measured 1-in-14: the
    // droplet is refused by YouTube on every client, the phone is not.
    await waitFor(() =>
      expect(mockImportToDevice).toHaveBeenCalledWith(
        'https://youtube.com/watch?v=Pick me',
        expect.objectContaining({ onProgress: expect.any(Function) }),
      ),
    )
    expect((globalThis.fetch as jest.Mock).mock.calls.length).toBe(before)
    await waitFor(() => expect(screen.getByText('Added')).toBeTruthy())
  })

  it('says which phase the download is in, not just that it is busy (#240)', async () => {
    respondWith([])
    mockSearchOnDevice.mockResolvedValue([result('Pick me')])

    // Held open, so the phases are observable at all — a resolved promise would
    // go straight to "Added" and the test would assert nothing about progress.
    let finish: (value: unknown) => void = () => {}
    let report: (progress: unknown) => void = () => {}
    mockImportToDevice.mockImplementation((_url: string, options: Record<string, never>) => {
      report = options.onProgress
      return new Promise((resolve) => {
        finish = resolve
      })
    })

    await render(<SearchScreen />, { wrapper })
    await searchFor('pick')
    await waitFor(() => expect(screen.getByText('Pick me')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add'))
    })
    // Set before the import is even called, so the row never sits blank.
    expect(screen.getByText('Finding the audio…')).toBeTruthy()

    await act(async () => {
      report({ phase: 'downloading', attempt: 1, alreadyHere: 0, client: 'IOS' })
    })
    expect(screen.getByText('Downloading…')).toBeTruthy()

    // A retired client is the difference between slow and stuck, so the attempt
    // is said — as a suffix. Written as a replacement it swallowed the phase,
    // and every step after the first retry read "Retrying".
    await act(async () => {
      report({ phase: 'extracting', attempt: 2, alreadyHere: 0, client: null })
    })
    expect(screen.getByText('Finding the audio… · attempt 2')).toBeTruthy()

    // The *last* phase reported, so the assertion after the import finishes is
    // about clearing rather than about having moved on. Asserting an earlier
    // phase is absent proves nothing: it was already replaced.
    await act(async () => {
      report({ phase: 'saving', attempt: 2, alreadyHere: 0, client: 'IOS' })
    })
    expect(screen.getByText('Saving… · attempt 2')).toBeTruthy()

    await act(async () => {
      finish({ local_id: 'l1', title: 'T', artist: 'A', client: 'IOS' })
    })
    await waitFor(() => expect(screen.getByText('Added')).toBeTruthy())
    // The phase line goes with the import; leaving "Saving…" under a finished
    // row would be worse than never having shown it.
    expect(screen.queryByText('Saving… · attempt 2')).toBeNull()
  })

  it('says why a device import failed rather than doing nothing', async () => {
    respondWith([])
    mockSearchOnDevice.mockResolvedValue([result('Pick me')])
    mockImportToDevice.mockRejectedValue(new Error('No client could provide audio'))

    await render(<SearchScreen />, { wrapper })
    await searchFor('pick')
    await waitFor(() => expect(screen.getByText('Pick me')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add'))
    })

    // A result that silently does nothing is indistinguishable from a broken
    // button.
    await waitFor(() => expect(screen.getByText('No client could provide audio')).toBeTruthy())
  })

  it('falls back to the server for a source the device cannot fetch', async () => {
    // About the *result's* URL, not about where the search came from: a
    // Bilibili link cannot be fetched on the device whatever found it.
    respondWith([])
    mockSearchOnDevice.mockResolvedValue([
      result('Bili song', { url: 'https://www.bilibili.com/video/BV1xx' }),
    ])

    await render(<SearchScreen />, { wrapper })
    await searchFor('bili')
    await waitFor(() => expect(screen.getByText('Bili song')).toBeTruthy())

    respondWith({ id: 12 }, 200)
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add'))
    })

    // The device path is YouTube-only; Bilibili and anything else yt-dlp
    // supports still go through the server, and are still handed over (#215).
    await waitFor(() => expect(useActiveImports.getState().imports).toHaveLength(1))
    expect(mockImportToDevice).not.toHaveBeenCalled()

    // "Queued", not "Added" (#240). `POST /jobs` returning is the moment the
    // download starts, so calling it "Added" claims a song is in the library
    // before the server has fetched a byte of it.
    expect(screen.getByText('Queued')).toBeTruthy()
    expect(screen.queryByText('Added')).toBeNull()
  })

  it('keeps past searches visible while something is being typed (#376)', async () => {
    useSearchUi.setState({ history: ['稻香'] })

    await render(<SearchScreen />, { wrapper })
    expect(screen.getByLabelText('Search for 稻香 again')).toBeTruthy()

    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Search'), 'dao')
    })

    // It used to hide itself on the first keystroke, which is the moment you
    // most want it: halfway through retyping a search you have run before.
    expect(screen.getByLabelText('Search for 稻香 again')).toBeTruthy()
  })

  it('replaces what is typed rather than appending to it', async () => {
    useSearchUi.setState({ history: ['稻香'], input: 'half typed' })

    await render(<SearchScreen />, { wrapper })
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Search for 稻香 again'))
    })

    expect(useSearchUi.getState().input).toBe('稻香')
    expect(useSearchUi.getState().query).toBe('稻香')
  })

  it('says so when a search finds nothing', async () => {
    respondWith([])

    await render(<SearchScreen />, { wrapper })
    await searchFor('asdkjhasd')

    await waitFor(() => expect(screen.getByText('No results found.')).toBeTruthy())
  })
})

/**
 * The search page remembers what you already have (#376).
 *
 * *"when we added a song, then research it, the second time it might
 * still display as added, but how do we make it permanent"*. "Might", because
 * the answer lived in the result row's own `useState` and lasted as long as the
 * row did.
 */
describe('a result the library already holds', () => {
  it('reads as added without anything being pressed', async () => {
    mockSearchOnDevice.mockResolvedValue([result('Pick me')])
    mockLocalSongs.mockResolvedValue([localSong('https://youtube.com/watch?v=Pick me')])

    await render(<SearchScreen />, { wrapper })
    await searchFor('pick')

    await waitFor(() => expect(screen.getByText('Added')).toBeTruthy())
    // And there is nothing to press: adding it again would be a second download
    // of a file the phone already has.
    expect(screen.getByLabelText('Add').props.accessibilityState.disabled).toBe(true)
  })

  it('still offers a result the library does not hold', async () => {
    // The half that proves the assertion above is about the library and not
    // about every row: same library, a different search result.
    mockSearchOnDevice.mockResolvedValue([result('Not mine')])
    mockLocalSongs.mockResolvedValue([localSong('https://youtube.com/watch?v=Something else')])

    await render(<SearchScreen />, { wrapper })
    await searchFor('not')

    await waitFor(() => expect(screen.getByText('Not mine')).toBeTruthy())
    expect(screen.getByText('Add')).toBeTruthy()
    expect(screen.queryByText('Added')).toBeNull()
  })

  it('does not count a row whose download never finished', async () => {
    /*
     * `file_uri` is the whole test, the same one `sourcesWithAudio` and
     * `isPlayable` apply. A row with no file is a state the schema models on
     * purpose — a promise the library cannot keep (#309) — and calling it
     * "Added" would leave the one song the user needs to retry as the one row
     * they cannot.
     */
    mockSearchOnDevice.mockResolvedValue([result('Half done')])
    mockLocalSongs.mockResolvedValue([
      localSong('https://youtube.com/watch?v=Half done', { file_uri: null }),
    ])

    await render(<SearchScreen />, { wrapper })
    await searchFor('half')

    await waitFor(() => expect(screen.getByText('Half done')).toBeTruthy())
    expect(screen.getByText('Add')).toBeTruthy()
  })
})

/**
 * The box no longer remembers, and a history list does (#319).
 *
 * "when there is something in the search box and I switch to Bilibili,
 * or if I re-enter the page, it automatically starts searching — it should have
 * emptied the search box."
 *
 * `useSearchUi` is module-level with no `persist` and **nothing ever cleared
 * it**, so returning re-rendered with the same query and TanStack served the
 * cached result. That was #182's deliberate choice — the box used to empty and
 * lose the results — and the requirement has reversed.
 */
describe('leaving the search screen', () => {
  it('forgets the query, so coming back does not search again', () => {
    useSearchUi.setState({ input: '稻香', query: '', history: [] })
    useSearchUi.getState().submit()
    expect(useSearchUi.getState().query).toBe('稻香')

    useSearchUi.getState().clear()

    expect(useSearchUi.getState().query).toBe('')
    expect(useSearchUi.getState().input).toBe('')
  })

  it('keeps which source you were searching', () => {
    useSearchUi.setState({ platform: 'bilibili' })

    useSearchUi.getState().clear()

    // Which source you are searching is a preference, not part of a query.
    expect(useSearchUi.getState().platform).toBe('bilibili')
  })

  it('remembers what was searched, so nothing is lost by forgetting the box', () => {
    useSearchUi.setState({ input: 'first', query: '', history: [] })
    useSearchUi.getState().submit()
    useSearchUi.setState({ input: 'second' })
    useSearchUi.getState().submit()

    expect(useSearchUi.getState().history).toEqual(['second', 'first'])
  })

  it('moves a repeated search to the front rather than listing it twice', () => {
    useSearchUi.setState({ input: 'first', query: '', history: [] })
    useSearchUi.getState().submit()
    useSearchUi.setState({ input: 'second' })
    useSearchUi.getState().submit()
    useSearchUi.setState({ input: 'first' })
    useSearchUi.getState().submit()

    expect(useSearchUi.getState().history).toEqual(['first', 'second'])
  })

  it('records nothing for an empty submit', () => {
    useSearchUi.setState({ input: '   ', query: '', history: [] })

    useSearchUi.getState().submit()

    expect(useSearchUi.getState().history).toEqual([])
    expect(useSearchUi.getState().query).toBe('')
  })

  it('keeps only the last ten', () => {
    useSearchUi.setState({ history: [], query: '', input: '' })
    for (let index = 0; index < 12; index++) {
      useSearchUi.setState({ input: `q${index}` })
      useSearchUi.getState().submit()
    }

    expect(useSearchUi.getState().history).toHaveLength(10)
    expect(useSearchUi.getState().history[0]).toBe('q11')
  })
})
