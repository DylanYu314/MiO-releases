import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { DatabaseSync } from 'node:sqlite'
import type { ReactNode } from 'react'

import NeteaseImportScreen from '../app/(tabs)/add/import/netease'
import { useConnection } from '../src/api/connection'
import { __resetLibraryTransactions } from '../src/library/db'
import {
  ExternalPlaylistTruncated,
  ExternalSourceRefused,
  type ExternalPlaylist,
} from '../src/library/externalPlaylist'
import { NotANeteaseLink } from '../src/library/neteaseUrl'
import { useSearchSource } from '../src/library/searchSource'
import { freshLibraryDb } from '../src/test/localDb'
import '../src/i18n'

/**
 * The NetEase import screen (#102, ADR-013).
 *
 * ⚠️ **Both steps are on the device since #611.** The playlist is read here and
 * written to the local `playlist_imports` tables — there is no request at all.
 * What this file is really about is the **third** thing: that a failure says
 * which step it was, and asks for the right action.
 *
 * `netease.test.ts` covers the reader; `playlistImportsDb.test.ts` covers the
 * tables. This covers the seam and the wording.
 */

// `mock`-prefixed so the hoisted `jest.mock` factory may reference it.
let mockDb: DatabaseSync
jest.mock('../src/library/db', () => {
  const actual = jest.requireActual('../src/library/db')
  // ⚠️ `requireActual` inside the factory, not the import above: a `jest.mock`
  // factory may not reference an out-of-scope binding, and only `mock`-prefixed
  // names are exempt.
  const { sqliteAdapter } = jest.requireActual('../src/test/localDb')
  return { ...actual, openLibraryDb: async () => sqliteAdapter(() => mockDb) }
})

const mockReplace = jest.fn()
jest.mock('expo-router', () => ({
  usePathname: () => '/add/import/netease',
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
}))

const mockFetchPlaylist = jest.fn()
jest.mock('../src/library/netease', () => ({
  NETEASE_SERVICE: 'netease',
  fetchNeteasePlaylist: (...args: unknown[]) => mockFetchPlaylist(...args),
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
  service: 'netease',
  sourceUrl: 'https://music.163.com/#/playlist?id=79177352',
  name: 'Billboard 2007 Top 100',
  tracks: [
    {
      externalId: '21534415',
      title: 'Same Girl',
      artist: 'R. Kelly, Usher',
      album: 'Double Up',
      durationSeconds: 253.91,
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
 * The `act` between the two is load-bearing, not ceremony: the button is
 * `disabled` while the box is empty, and RNTL will not fire a press on a
 * disabled Pressable. Without flushing the state update from `changeText`
 * first, every one of these tests silently presses nothing and passes for the
 * wrong reason.
 */
async function typeAndSubmit(text = 'https://music.163.com/#/playlist?id=79177352') {
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText('NetEase Cloud Music'), text)
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
})

describe('NeteaseImportScreen', () => {
  it('reads the playlist on the device and writes it to the library', async () => {
    mockFetchPlaylist.mockResolvedValueOnce(PLAYLIST)

    await render(<NeteaseImportScreen />, { wrapper })
    await typeAndSubmit()

    await waitFor(() => expect(storedImports()).toHaveLength(1))
    expect(storedImports()[0]).toMatchObject({
      service: 'netease',
      external_playlist_id: 'https://music.163.com/#/playlist?id=79177352',
      name: 'Billboard 2007 Top 100',
      // `matching` is what makes the review screen start searching on arrival.
      status: 'matching',
      track_count: 1,
    })
    // Snake case and seconds, as the columns are named — a renamed field here
    // is a silent null, which is why this is asserted field by field.
    expect(storedTracks()).toHaveLength(1)
    expect(storedTracks()[0]).toMatchObject({
      external_id: '21534415',
      title: 'Same Girl',
      artist: 'R. Kelly, Usher',
      album: 'Double Up',
      duration_s: 253.91,
      position: 0,
      status: 'pending',
    })
  })

  it('goes to the review screen, because the searching happens there', async () => {
    // Not decoration: every track is a *guess* that still has to be found on
    // YouTube, and `[id].tsx` starts searching on mount for an import at
    // `matching`. Landing back on an unchanged form would show nothing.
    mockFetchPlaylist.mockResolvedValueOnce(PLAYLIST)

    await render(<NeteaseImportScreen />, { wrapper })
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
    await render(<NeteaseImportScreen />, { wrapper })

    expect(screen.getByText(/Paste the playlist's number instead/i)).toBeTruthy()
  })

  it('does not post anything when the link is not a NetEase one', async () => {
    mockFetchPlaylist.mockRejectedValueOnce(new NotANeteaseLink('https://example.com'))

    await render(<NeteaseImportScreen />, { wrapper })
    await typeAndSubmit('https://example.com')

    // Asserted on the *advice*, not on the phrase "not a NetEase playlist
    // link" — that phrase is also in `NotANeteaseLink`'s own message, so the
    // fallback `describeError` branch renders it too and a mutation deleting
    // this case survived. Only the translated copy tells the user what to do.
    await waitFor(() =>
      expect(screen.getByText(/paste the playlist's number on its own/i)).toBeTruthy(),
    )
    expect(storedImports()).toEqual([])
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('says a refusal is a refusal, and names the code', async () => {
    // "The playlist may be private" and "your link is wrong" ask for opposite
    // actions. #492 shipped a screen that conflated two states and told the
    // user a login had expired when it had succeeded.
    mockFetchPlaylist.mockRejectedValueOnce(new ExternalSourceRefused('refused', '401'))

    await render(<NeteaseImportScreen />, { wrapper })
    await typeAndSubmit()

    await waitFor(() => expect(screen.getByText(/would not answer \(401\)/i)).toBeTruthy())
    expect(screen.queryByText(/paste the playlist's number on its own/i)).toBeNull()
  })

  it('says how short a truncated read was, and imports nothing', async () => {
    mockFetchPlaylist.mockRejectedValueOnce(new ExternalPlaylistTruncated(95, 40))

    await render(<NeteaseImportScreen />, { wrapper })
    await typeAndSubmit()

    await waitFor(() => expect(screen.getByText(/Only 40 of 95 tracks/i)).toBeTruthy())
    expect(storedImports()).toEqual([])
  })

  /**
   * ⚠️ **This replaces "reads the access-key gate as a lock" (#611).**
   *
   * That test asserted a 401 from `POST /playlist-imports/external` rendered as
   * "you need an access key". It cannot fire any more, because there is no
   * request — and a test that can never fail is worse than no test.
   *
   * What replaced it is the behaviour change itself, asserted directly: the
   * gate (ADR-009) still exists for a **self-hoster's** server, but it no longer
   * stands between a user and their own NetEase playlist. That is #608's
   * position — the key must never be what buys ingestion — arriving in code.
   */
  it('imports with no server and no access key at all', async () => {
    useConnection.setState({ serverUrl: null, accessKey: null })
    mockFetchPlaylist.mockResolvedValueOnce(PLAYLIST)

    await render(<NeteaseImportScreen />, { wrapper })
    await typeAndSubmit()

    await waitFor(() => expect(storedImports()).toHaveLength(1))
    expect(screen.queryByText(/access key/i)).toBeNull()
  })

  it('does nothing with an empty box', async () => {
    await render(<NeteaseImportScreen />, { wrapper })
    await act(async () => {
      fireEvent.press(screen.getByText('Read the playlist'))
    })

    expect(mockFetchPlaylist).not.toHaveBeenCalled()
    expect(storedImports()).toEqual([])
  })

  it('says the playlist must be public before anything is attempted', async () => {
    // A private 歌单 answers with a code we cannot tell apart from "deleted",
    // so the advice has to be on screen *before* the attempt rather than in the
    // failure. 我喜欢的音乐 is private by default, which makes it the shape a
    // user is most likely to try first.
    await render(<NeteaseImportScreen />, { wrapper })

    expect(screen.getByText(/must be public/i)).toBeTruthy()
    expect(mockFetchPlaylist).not.toHaveBeenCalled()
  })

  it('tells the user MiO never takes NetEase’s audio', async () => {
    // The one thing a user cannot verify by using the app, and the rule the
    // whole design is built around. It is on the screen deliberately.
    await render(<NeteaseImportScreen />, { wrapper })

    expect(screen.getByText(/never downloads audio from NetEase/i)).toBeTruthy()
  })
})

/**
 * Which site this screen promises the audio comes from (#557).
 *
 * It named YouTube flatly, in both the description and the audio note. #551
 * made that a choice, so for the user the toggle exists for — someone in
 * mainland China who has selected Bilibili — the one screen that promises
 * where the audio comes from was telling them the wrong site.
 */
describe('naming the source the audio will actually come from (#557)', () => {
  it('names Bilibili once Bilibili is the chosen source', async () => {
    useSearchSource.setState({ source: 'bilibili' })

    await render(<NeteaseImportScreen />, { wrapper })

    // Both sentences, because both used to be hardcoded and fixing one would
    // leave the other quietly lying.
    expect(screen.getByText(/searched for on Bilibili/i)).toBeTruthy()
    expect(screen.getByText(/the audio comes from Bilibili/i)).toBeTruthy()
    expect(screen.queryByText(/searched for on YouTube/i)).toBeNull()
  })

  it('still names YouTube on the default source', async () => {
    useSearchSource.setState({ source: 'youtube' })

    await render(<NeteaseImportScreen />, { wrapper })

    expect(screen.getByText(/searched for on YouTube/i)).toBeTruthy()
    expect(screen.getByText(/the audio comes from YouTube/i)).toBeTruthy()
  })
})
