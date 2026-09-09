import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { DatabaseSync } from 'node:sqlite'
import type { ReactNode } from 'react'

import QQImportScreen from '../app/(tabs)/add/import/qq'
import { useConnection } from '../src/api/connection'
import { __resetLibraryTransactions } from '../src/library/db'
import {
  ExternalPlaylistTruncated,
  ExternalSourceRefused,
  type ExternalPlaylist,
} from '../src/library/externalPlaylist'
import { NotAQQLink } from '../src/library/qqUrl'
import { useSearchSource } from '../src/library/searchSource'
import { freshLibraryDb } from '../src/test/localDb'
import '../src/i18n'

/**
 * The QQ Music import screen (#103, ADR-013).
 *
 * The NetEase screen's twin, and this file covers the same seam: the playlist
 * is read on the device, then posted to `POST /playlist-imports/external`, and
 * a failure has to say **which of the two** it was so the user knows whether to
 * fix the link or wait.
 *
 * `qq.test.ts` covers the reader. `backend/tests/test_playlist_imports_api.py`
 * covers the endpoint.
 */

// `mock`-prefixed so the hoisted `jest.mock` factory may reference it.
let mockDb: DatabaseSync
jest.mock('../src/library/db', () => {
  const actual = jest.requireActual('../src/library/db')
  // ⚠️ `requireActual` inside the factory: it may not reference an out-of-scope
  // binding, and only `mock`-prefixed names are exempt.
  const { sqliteAdapter } = jest.requireActual('../src/test/localDb')
  return { ...actual, openLibraryDb: async () => sqliteAdapter(() => mockDb) }
})

const mockReplace = jest.fn()
jest.mock('expo-router', () => ({
  usePathname: () => '/add/import/qq',
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
}))

const mockFetchPlaylist = jest.fn()
jest.mock('../src/library/qq', () => ({
  QQ_SERVICE: 'qq',
  fetchQQPlaylist: (...args: unknown[]) => mockFetchPlaylist(...args),
}))

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const PLAYLIST: ExternalPlaylist = {
  service: 'qq',
  sourceUrl: 'https://y.qq.com/n/ryqq/playlist/7707261125',
  name: '甜度爆表 | 旋律说唱狙击少女心',
  tracks: [
    {
      externalId: '0039MnYb0qxYhV',
      title: '你的',
      artist: 'DouDou, Viva宋佩豫',
      album: '你的',
      durationSeconds: 163,
    },
  ],
}

/** What actually landed in the library, which is the whole subject now. */
function storedImports() {
  return mockDb.prepare(`SELECT * FROM playlist_imports`).all() as Record<string, unknown>[]
}

function storedTracks() {
  return mockDb.prepare(`SELECT * FROM track_matches ORDER BY position`).all() as Record<
    string,
    unknown
  >[]
}

/**
 * Type a link and press the button.
 *
 * The `act` between the two is load-bearing: the button is `disabled` while the
 * box is empty, and RNTL will not fire a press on a disabled Pressable — so
 * without flushing the state update first, every test presses nothing and
 * passes for the wrong reason.
 */
async function typeAndSubmit(text = 'https://y.qq.com/n/ryqq/playlist/7707261125') {
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText('QQ Music'), text)
  })
  await act(async () => {
    fireEvent.press(screen.getByText('Read the playlist'))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  // `apiFetch` throws "No server configured" without one, which would make every
  // success path fail for a reason that has nothing to do with QQ.
  __resetLibraryTransactions()
  mockDb = freshLibraryDb()
  // ⚠️ Deliberately **no server**. Since #611 this screen reaches none, so
  // configuring one would hide a regression that reintroduced a request.
  useConnection.setState({ serverUrl: null, accessKey: null })
  // Module-level and shared with every other screen: left on Bilibili by the
  // last test in this file, it would silently change what the next file reads.
  useSearchSource.setState({ source: 'youtube' })
})

describe('QQImportScreen', () => {
  it('reads the playlist on the device and writes it to the library', async () => {
    mockFetchPlaylist.mockResolvedValue(PLAYLIST)

    await render(<QQImportScreen />, { wrapper })
    await typeAndSubmit()

    // Read here, not on the server: ADR-013 decision 2, and the reason the
    // droplet's ability to reach QQ never had to be measured.
    expect(mockFetchPlaylist).toHaveBeenCalledWith('https://y.qq.com/n/ryqq/playlist/7707261125')
    await waitFor(() => expect(storedImports()).toHaveLength(1))
    // The rows themselves now, not a request body — there is no request.
    expect(storedImports()[0]).toMatchObject({
      service: 'qq',
      name: '甜度爆表 | 旋律说唱狙击少女心',
      // `matching` is what makes the review screen start searching on arrival.
      status: 'matching',
    })
    expect(storedTracks().length).toBeGreaterThan(0)
  })

  it('goes to the review screen, because the searching happens there', async () => {
    mockFetchPlaylist.mockResolvedValue(PLAYLIST)

    await render(<QQImportScreen />, { wrapper })
    await typeAndSubmit()

    // Every track is a title that still has to be found, and `[id].tsx` starts
    // searching on mount. Staying here would look like nothing had happened.
    // The id is minted locally now, so it is read back rather than hardcoded.
    await waitFor(() => expect(storedImports()).toHaveLength(1))
    expect(mockReplace).toHaveBeenCalledWith(`/add/import/${storedImports()[0].id as string}`)
  })

  it('tells the user a bare id will do, before they need it', async () => {
    /*
     * The wiring, not the ingredient (#564, and the #561 lesson).
     *
     * All three of these screens have accepted a bare id since the day they
     * were written, and none of them said so — so I went looking for a
     * share link the QQ Music app does not offer and concluded the feature did
     * not work on a phone. A parity guard cannot catch that: the string is only
     * missing in the sense that nothing renders it.
     *
     * Asserted **before** an error, deliberately. Advice that only appears once
     * the user has already failed is advice that arrives too late.
     */
    await render(<QQImportScreen />, { wrapper })

    expect(screen.getByText(/paste its number on its own/i)).toBeTruthy()
  })

  it('writes nothing when the link is not a QQ one', async () => {
    mockFetchPlaylist.mockRejectedValue(new NotAQQLink('https://example.com/x'))

    await render(<QQImportScreen />, { wrapper })
    await typeAndSubmit('https://example.com/x')

    /*
     * The *guidance*, not the opening words.
     *
     * `NotAQQLink`'s own message starts "Not a QQ Music playlist link", and
     * `messageFor` falls back to `describeError`, which returns exactly that.
     * So matching the shared prefix passes even with the translation branch
     * deleted — it did, until this assertion moved to the half only the
     * translated string carries.
     */
    expect(await screen.findByText(/paste the 歌单's number on its own/i)).toBeTruthy()
    expect(storedImports()).toHaveLength(0)
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('says a refusal is a refusal, and names the code', async () => {
    mockFetchPlaylist.mockRejectedValue(new ExternalSourceRefused('nope', '-1'))

    await render(<QQImportScreen />, { wrapper })
    await typeAndSubmit()

    // "Private or deleted, try again later" asks for a different action than
    // "fix the link" — collapsing the two is the trap #492 fell into.
    expect(await screen.findByText(/would not answer \(-1\)/i)).toBeTruthy()
  })

  it('says how short a truncated read was, and imports nothing', async () => {
    mockFetchPlaylist.mockRejectedValue(new ExternalPlaylistTruncated(66, 40))

    await render(<QQImportScreen />, { wrapper })
    await typeAndSubmit()

    expect(await screen.findByText(/Only 40 of 66 tracks/i)).toBeTruthy()
    // Half a playlist is worse than none: nothing later in the pipeline could
    // tell that anything was missing.
    expect(storedImports()).toHaveLength(0)
  })

  it('tells the user MiO never takes QQ Music’s audio', async () => {
    // The one thing a user cannot verify by using the app, and the rule the
    // whole design is built around. It is on the screen deliberately.
    await render(<QQImportScreen />, { wrapper })

    expect(screen.getByText(/never downloads audio from QQ Music/i)).toBeTruthy()
  })

  it('says the 歌单 must be public before anything is attempted', async () => {
    await render(<QQImportScreen />, { wrapper })

    expect(screen.getByText(/must be public/i)).toBeTruthy()
    expect(mockFetchPlaylist).not.toHaveBeenCalled()
  })
})

/**
 * Which site this screen promises the audio comes from (#551, #557).
 *
 * Built in from the start here rather than retrofitted: the NetEase screen
 * shipped naming YouTube flatly, and for a user in mainland China who had
 * chosen Bilibili that was simply false.
 */
describe('naming the source the audio will actually come from', () => {
  it('names Bilibili once Bilibili is the chosen source', async () => {
    useSearchSource.setState({ source: 'bilibili' })

    await render(<QQImportScreen />, { wrapper })

    expect(screen.getByText(/searched for on Bilibili/i)).toBeTruthy()
    expect(screen.getByText(/the audio comes from Bilibili/i)).toBeTruthy()
    expect(screen.queryByText(/searched for on YouTube/i)).toBeNull()
  })

  it('still names YouTube on the default source', async () => {
    await render(<QQImportScreen />, { wrapper })

    expect(screen.getByText(/searched for on YouTube/i)).toBeTruthy()
    expect(screen.getByText(/the audio comes from YouTube/i)).toBeTruthy()
  })
})
