import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { DatabaseSync } from 'node:sqlite'
import type { ReactNode } from 'react'

import KugouImportScreen from '../app/(tabs)/add/import/kugou'
import { useConnection } from '../src/api/connection'
import { __resetLibraryTransactions } from '../src/library/db'
import {
  ExternalPlaylistTruncated,
  ExternalSourceRefused,
  type ExternalPlaylist,
} from '../src/library/externalPlaylist'
import { NotAKugouLink } from '../src/library/kugouUrl'
import { useSearchSource } from '../src/library/searchSource'
import { freshLibraryDb } from '../src/test/localDb'
import '../src/i18n'

/**
 * The Kugou import screen (#104, ADR-013).
 *
 * The same seam as NetEase's and QQ's — read here, post there, and say which of
 * the two failed — plus the one thing only this screen has to explain: Kugou
 * glues the artist and title together, so some tracks arrive with no artist and
 * go to review. Without saying so, that reads as MiO failing.
 *
 * `kugou.test.ts` covers the reader.
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
  usePathname: () => '/add/import/kugou',
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
}))

const mockFetchPlaylist = jest.fn()
jest.mock('../src/library/kugou', () => ({
  KUGOU_SERVICE: 'kugou',
  fetchKugouPlaylist: (...args: unknown[]) => mockFetchPlaylist(...args),
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
  service: 'kugou',
  sourceUrl: 'https://www.kugou.com/yy/special/single/4304395.html',
  name: '我真的好喜欢你ʸᵃ',
  tracks: [
    {
      externalId: '174E45179B00',
      title: '安乐死',
      artist: '颜妹',
      album: null,
      durationSeconds: 165,
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
async function typeAndSubmit(text = 'https://www.kugou.com/yy/special/single/4304395.html') {
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText('Kugou'), text)
  })
  await act(async () => {
    fireEvent.press(screen.getByText('Read the playlist'))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetLibraryTransactions()
  mockDb = freshLibraryDb()
  // ⚠️ Deliberately **no server**. Since #611 this screen reaches none, so
  // configuring one would hide a regression that reintroduced a request.
  useConnection.setState({ serverUrl: null, accessKey: null })
  // Module-level and shared with every other screen: left on Bilibili by the
  // last test in this file, it would silently change what the next file reads.
  useSearchSource.setState({ source: 'youtube' })
})

describe('KugouImportScreen', () => {
  it('reads the playlist on the device and writes it to the library', async () => {
    mockFetchPlaylist.mockResolvedValue(PLAYLIST)

    await render(<KugouImportScreen />, { wrapper })
    await typeAndSubmit()

    expect(mockFetchPlaylist).toHaveBeenCalledWith(
      'https://www.kugou.com/yy/special/single/4304395.html',
    )
    await waitFor(() => expect(storedImports()).toHaveLength(1))
    // The rows themselves now, not a request body — there is no request.
    expect(storedImports()[0]).toMatchObject({
      service: 'kugou',
      name: '我真的好喜欢你ʸᵃ',
      // `matching` is what makes the review screen start searching on arrival.
      status: 'matching',
    })
    expect(storedTracks().length).toBeGreaterThan(0)
  })

  it('goes to the review screen, because the searching happens there', async () => {
    mockFetchPlaylist.mockResolvedValue(PLAYLIST)

    await render(<KugouImportScreen />, { wrapper })
    await typeAndSubmit()

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
    await render(<KugouImportScreen />, { wrapper })

    expect(screen.getByText(/Paste the 歌单's number instead/i)).toBeTruthy()
  })

  it('writes nothing when the link is not a Kugou one', async () => {
    mockFetchPlaylist.mockRejectedValue(new NotAKugouLink('https://example.com/x'))

    await render(<KugouImportScreen />, { wrapper })
    await typeAndSubmit('https://example.com/x')

    // The *guidance*, not the opening words: `NotAKugouLink`'s own message
    // starts "Not a Kugou playlist link" and `describeError` returns exactly
    // that, so matching the shared prefix would pass with the translation
    // branch deleted.
    expect(await screen.findByText(/paste the 歌单's number on its own/i)).toBeTruthy()
    expect(storedImports()).toHaveLength(0)
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('says a refusal is a refusal, and names the code', async () => {
    mockFetchPlaylist.mockRejectedValue(new ExternalSourceRefused('nope', '20010'))

    await render(<KugouImportScreen />, { wrapper })
    await typeAndSubmit()

    expect(await screen.findByText(/would not answer \(20010\)/i)).toBeTruthy()
  })

  it('says how short a truncated read was, and imports nothing', async () => {
    mockFetchPlaylist.mockRejectedValue(new ExternalPlaylistTruncated(107, 50))

    await render(<KugouImportScreen />, { wrapper })
    await typeAndSubmit()

    expect(await screen.findByText(/Only 50 of 107 tracks/i)).toBeTruthy()
    expect(storedImports()).toHaveLength(0)
  })

  it('warns that some tracks will arrive without an artist', async () => {
    // Only this screen needs it: Kugou has no artist field, so the split can
    // fail and those tracks go to review. Unexplained, that looks like a fault.
    await render(<KugouImportScreen />, { wrapper })

    expect(screen.getByText(/artist and the title in one field/i)).toBeTruthy()
  })

  it('tells the user MiO never takes Kugou’s audio', async () => {
    await render(<KugouImportScreen />, { wrapper })

    expect(screen.getByText(/never downloads audio from Kugou/i)).toBeTruthy()
  })

  it('says the 歌单 must be public before anything is attempted', async () => {
    await render(<KugouImportScreen />, { wrapper })

    expect(screen.getByText(/must be public/i)).toBeTruthy()
    expect(mockFetchPlaylist).not.toHaveBeenCalled()
  })
})

/**
 * Which site this screen promises the audio comes from (#551, #557).
 *
 * Built in from the start rather than retrofitted — the NetEase screen shipped
 * naming YouTube flatly, and for a user in mainland China who had chosen
 * Bilibili that was simply false.
 */
describe('naming the source the audio will actually come from', () => {
  it('names Bilibili once Bilibili is the chosen source', async () => {
    useSearchSource.setState({ source: 'bilibili' })

    await render(<KugouImportScreen />, { wrapper })

    expect(screen.getByText(/searched for on Bilibili/i)).toBeTruthy()
    expect(screen.getByText(/the audio comes from Bilibili/i)).toBeTruthy()
    expect(screen.queryByText(/searched for on YouTube/i)).toBeNull()
  })

  it('still names YouTube on the default source', async () => {
    await render(<KugouImportScreen />, { wrapper })

    expect(screen.getByText(/searched for on YouTube/i)).toBeTruthy()
    expect(screen.getByText(/the audio comes from YouTube/i)).toBeTruthy()
  })
})
