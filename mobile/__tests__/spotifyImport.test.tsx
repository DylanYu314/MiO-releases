import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { DatabaseSync } from 'node:sqlite'
import type { ReactNode } from 'react'
import { StyleSheet } from 'react-native'
import * as Linking from 'expo-linking'

import ImportScreen from '../app/(tabs)/add/import/index'
import SpotifyPlaylistsScreen from '../app/(tabs)/add/import/spotify'
import { MatchReview } from '../src/components/MatchReview'
import { useTrackStates } from '../src/api/trackStates'
import { useToast } from '../src/components/Toast'
import { useConnection } from '../src/api/connection'
import { __resetLibraryTransactions } from '../src/library/db'
import { freshLibraryDb, seedImport, seedMatches } from '../src/test/localDb'
import type { Page, SpotifyPlaylist, SpotifyStatus, TrackMatch } from '../src/api/types'
import '../src/i18n'

/**
 * Importing a Spotify playlist, on the phone (#203).
 *
 * Three surfaces, one file: connecting, picking a playlist, and reviewing the
 * matches. They are one feature and share every fixture.
 *
 * The **backend** half of #203 — `?client=app` and the deep-link callback — is
 * tested in `backend/tests/test_spotify_api.py`. Nothing here can prove the
 * browser comes back, because that journey leaves the app entirely; what these
 * prove is that the app sends people to the right URL and reads the answer
 * afterwards.
 */

const mockPush = jest.fn()
const mockReplace = jest.fn()
// `code` and `state` arrived with #612: Spotify redirects straight to the
// app now, so the deep link carries the authorization code itself.
const mockParams: { spotify_error?: string; code?: string; state?: string } = {}
jest.mock('expo-router', () => ({
  // The guard reads the current path to know a navigation landed (#375).
  usePathname: () => '/',
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (effect: () => void) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react')
    React.useEffect(effect, [effect])
  },
}))

jest.mock('expo-linking', () => ({ openURL: jest.fn() }))

/*
 * ⚠️ Spotify is signed in to **from the device** since #612, so the status,
 * the playlists and the tracklist are local reads rather than proxied
 * endpoints. The modules are mocked here because this suite is about the
 * *screens*; `spotifyAuth.test.ts` covers the PKCE flow itself.
 */
const mockStoredTokens = jest.fn()
const mockBeginSignIn = jest.fn()
const mockCompleteSignIn = jest.fn()
const mockSignOut = jest.fn()
jest.mock('../src/library/spotifyAuth', () => ({
  storedTokens: () => mockStoredTokens(),
  beginSignIn: () => mockBeginSignIn(),
  completeSignIn: (...args: unknown[]) => mockCompleteSignIn(...args),
  signOut: () => mockSignOut(),
  SpotifyAuthError: class extends Error {},
}))

const mockListPlaylists = jest.fn()
const mockFetchTracks = jest.fn()
const mockFetchProfile = jest.fn()
jest.mock('../src/library/spotifyApi', () => ({
  listPlaylists: (...args: unknown[]) => mockListPlaylists(...args),
  fetchPlaylistTracks: (...args: unknown[]) => mockFetchTracks(...args),
  fetchProfile: () => mockFetchProfile(),
}))

let mockConfigured = true
jest.mock('../src/library/spotifyConfig', () => ({
  SPOTIFY_CLIENT_ID: 'a-client-id',
  SPOTIFY_REDIRECT_URI: 'mio://add/import',
  spotifyConfigured: () => mockConfigured,
}))

// `mock`-prefixed so the hoisted `jest.mock` factory may reference it.
let mockDb: DatabaseSync
jest.mock('../src/library/db', () => {
  const actual = jest.requireActual('../src/library/db')
  // ⚠️ `requireActual` inside the factory: it may not reference an out-of-scope
  // binding, and only `mock`-prefixed names are exempt.
  const { sqliteAdapter } = jest.requireActual('../src/test/localDb')
  return { ...actual, openLibraryDb: async () => sqliteAdapter(() => mockDb) }
})

/** The device's own answer to "did this land", mocked: the real one reaches
 *  expo-sqlite, which is native and absent under jest. */
const mockSourcesWithAudio = jest.fn()
jest.mock('../src/library/songs', () => ({
  sourcesWithAudio: (...args: unknown[]) => mockSourcesWithAudio(...args),
  formatDuration: jest.requireActual('../src/api/songs').formatDuration,
}))

jest.mock('../src/library/playlistImport', () => ({
  importPlaylistOnDevice: jest.fn(),
}))

function status(overrides: Partial<SpotifyStatus> = {}): SpotifyStatus {
  return {
    configured: true,
    accounts: [
      {
        id: 3,
        spotify_user_id: 'dylan',
        display_name: 'Alex',
        created_at: '2026-08-02T00:00:00Z',
      },
    ],
    ...overrides,
  }
}

function playlist(overrides: Partial<SpotifyPlaylist> = {}): SpotifyPlaylist {
  return {
    id: 'pl1',
    name: 'Road trip',
    image_url: null,
    track_count: 12,
    owner_name: 'Alex',
    ...overrides,
  }
}

function match(overrides: Partial<TrackMatch> = {}): TrackMatch {
  return {
    id: 1,
    position: 0,
    external_id: 'spotify:track:1',
    title: 'First song',
    artist: 'An Artist',
    album: null,
    duration_s: 210,
    candidates: [],
    chosen_url: null,
    confidence: null,
    status: 'needs_review',
    song_id: null,
    error: null,
    ...overrides,
  }
}

function pageOf<T>(items: T[], total = items.length): Page<T> {
  return { items, total, limit: 50, offset: 0 }
}

/** A router keyed on the URL, because these screens ask several endpoints and a
 *  single canned body is a different server (see `youtubeImport.test.tsx`). */
/**
 * ⚠️ Import fixtures go to **SQLite**, not to `fetch` (#611).
 *
 * The call sites are unchanged on purpose: a table entry whose value looks like
 * a page of matches, or like an import row, is written to the tables instead of
 * answered over HTTP. Everything else — `/spotify/status`, `/spotify/playlists`
 * — is still the server's and still routed.
 */
function seedFromTable(table: [RegExp, unknown][]) {
  for (const [, value] of table) {
    const page = value as { items?: Record<string, unknown>[] }
    if (Array.isArray(page?.items)) {
      // A page of matches: the rows carry a position and a title.
      if (page.items.length === 0 || 'title' in page.items[0]) {
        seedImport(mockDb, '5')
        seedMatches(mockDb, '5', page.items)
      }
      continue
    }
    const row = value as { id?: unknown; status?: unknown }
    if (row && typeof row === 'object' && 'status' in row && 'id' in row) {
      seedImport(mockDb, String(row.id), row as Record<string, unknown>)
    }
  }
}

function routes(table: [RegExp, unknown][], record?: { url: string; method: string }[]) {
  seedFromTable(table)
  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    record?.push({ url: String(url), method: init?.method ?? 'GET' })
    const hit = table.find(([pattern]) => pattern.test(String(url)))
    return {
      ok: true,
      status: 200,
      json: async () => (hit ? hit[1] : pageOf([])),
    }
  }) as unknown as typeof fetch
}

/** What the review actually wrote. The PATCH it used to send is gone (#611). */
function storedMatch(id = '1') {
  return mockDb.prepare(`SELECT * FROM track_matches WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    // `mutations` as well as `queries` — accepting a match is a mutation, and a
    // queries-only gcTime holds the jest worker open for five minutes.
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetLibraryTransactions()
  mockDb = freshLibraryDb()
  mockStoredTokens.mockResolvedValue({ displayName: 'Alex', accessToken: 'a-token' })
  mockBeginSignIn.mockResolvedValue('https://accounts.spotify.com/authorize?code_challenge=abc')
  mockListPlaylists.mockResolvedValue({ items: [], total: 0 })
  mockConfigured = true
  mockFetchTracks.mockResolvedValue([])
  delete mockParams.spotify_error
  delete mockParams.code
  delete mockParams.state
  useConnection.setState({
    serverUrl: 'https://mio.test/api',
    accessKey: 'a-key',
    usingDefaultServer: true,
    loaded: true,
  })
})

describe('connecting Spotify', () => {
  it('opens Spotify itself, with a challenge minted here (#612)', async () => {
    // ⚠️ Was "opens the backend login". The sign-in goes straight to Spotify
    // now, carrying a PKCE challenge this device generated — there is no
    // backend in the flow, so there is no `client=app` to tell it anything.
    mockStoredTokens.mockResolvedValue(null)

    await render(<ImportScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Connect Spotify')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByText('Connect Spotify'))
    })

    await waitFor(() => expect(mockBeginSignIn).toHaveBeenCalled())
    expect(Linking.openURL).toHaveBeenCalledWith(
      'https://accounts.spotify.com/authorize?code_challenge=abc',
    )
  })

  it('exchanges the code the deep link brought back, once', async () => {
    // ⚠️ The verifier is spent by the exchange, so a second attempt with the
    // same code fails and would show an error for a sign-in that worked —
    // #538's shape, where a confirmed key re-polls as expired.
    mockParams.code = 'an-auth-code'
    mockParams.state = 'the-state'
    mockCompleteSignIn.mockResolvedValue({})
    mockFetchProfile.mockResolvedValue({ id: 'u1', displayName: 'Alex' })

    const view = await render(<ImportScreen />, { wrapper })
    await waitFor(() => expect(mockCompleteSignIn).toHaveBeenCalledTimes(1))
    expect(mockCompleteSignIn).toHaveBeenCalledWith({ code: 'an-auth-code', state: 'the-state' })

    await act(async () => {
      view.rerender(<ImportScreen />)
    })
    expect(mockCompleteSignIn).toHaveBeenCalledTimes(1)
  })

  it('says why an exchange failed, rather than looking connected', async () => {
    mockParams.code = 'an-auth-code'
    mockStoredTokens.mockResolvedValue(null)
    mockCompleteSignIn.mockRejectedValue(new Error('state_mismatch'))

    await render(<ImportScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText(/state_mismatch/)).toBeTruthy())
  })

  it('shows the connected account and a way into the picker', async () => {
    await render(<ImportScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('Connected as Alex.')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByText('Pick a playlist'))
    })
    expect(mockPush).toHaveBeenCalledWith('/add/import/spotify')
  })

  it('says Spotify is not set up rather than offering a button that cannot work', async () => {
    // ⚠️ ADR-005's distinction survives #612, but it moved: `configured: false`
    // is now **this build** carrying no client id rather than the server having
    // none. Still nothing a user can fix by tapping, so there is nothing to tap.
    mockConfigured = false
    mockStoredTokens.mockResolvedValue(null)

    await render(<ImportScreen />, { wrapper })

    await waitFor(() =>
      expect(
        screen.getByText(
          "Spotify import isn't set up on this server, so there's nothing to connect to yet.",
        ),
      ).toBeTruthy(),
    )
    expect(screen.queryByText('Connect Spotify')).toBeNull()
  })

  it('explains a failed sign-in that came back through the deep link', async () => {
    // The callback carries `?spotify_error=…` into the app. A failure has
    // nothing to re-read from the server, so it is the one thing the deep link
    // must be parsed for.
    mockParams.spotify_error = 'access_denied'
    routes([[/spotify\/status/, status({ accounts: [] })]])

    await render(<ImportScreen />, { wrapper })

    await waitFor(() =>
      expect(
        screen.getByText('You cancelled the Spotify sign-in, so nothing was connected.'),
      ).toBeTruthy(),
    )
  })
})

describe('picking a playlist', () => {
  it('lists the playlists and starts an import from the one tapped', async () => {
    mockListPlaylists.mockResolvedValue({
      items: [playlist(), playlist({ id: 'pl2', name: 'Focus' })],
      total: 2,
    })

    await render(<SpotifyPlaylistsScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Road trip')).toBeTruthy())
    // Both rows carry it, so `getAllBy`: the meta line is the assertion, not
    // which row it belongs to.
    expect(screen.getAllByText('12 tracks · Alex')).toHaveLength(2)

    await act(async () => {
      fireEvent.press(screen.getByText('Focus'))
    })

    // ⚠️ The tracklist is read from Spotify **by this device** (#612), so what
    // is asserted is the local import it produced rather than a POST body.
    await waitFor(() => expect(mockFetchTracks).toHaveBeenCalledWith('pl2'))
    const local = mockDb
      .prepare(`SELECT id, name, service, status FROM playlist_imports`)
      .all() as {
      id: string
      name: string
      service: string
      status: string
    }[]
    await waitFor(() => expect(local).toHaveLength(1))
    expect(local[0]).toMatchObject({ name: 'Focus', service: 'spotify', status: 'matching' })
    expect(mockReplace).toHaveBeenCalledWith(`/add/import/${local[0].id}`)
  })

  it('writes the tracks as pending, because a Spotify track is not a video', async () => {
    /*
     * ⚠️ The difference from a YouTube playlist, and it is the whole reason the
     * review step exists (ADR-013, ADR-014): a YouTube entry *is* its own
     * candidate, while a Spotify track is a title and an artist that still has
     * to be found. So these land `pending` for `deviceMatching.ts`, never
     * `auto_matched`.
     */
    mockListPlaylists.mockResolvedValue({ items: [playlist()], total: 1 })
    mockFetchTracks.mockResolvedValue([
      {
        externalId: 'spotify:track:1',
        title: 'First song',
        artist: 'An Artist',
        album: 'An Album',
        durationSeconds: 210,
      },
    ])

    await render(<SpotifyPlaylistsScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Road trip')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByText('Road trip'))
    })

    await waitFor(() => expect(mockDb.prepare(`SELECT * FROM track_matches`).all()).toHaveLength(1))
    expect(mockDb.prepare(`SELECT * FROM track_matches`).get()).toMatchObject({
      title: 'First song',
      artist: 'An Artist',
      album: 'An Album',
      duration_s: 210,
      status: 'pending',
      chosen_url: null,
    })
  })

  it('asks for nothing when no account is connected', async () => {
    routes([[/spotify\/status/, status({ accounts: [] })]])

    await render(<SpotifyPlaylistsScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('Spotify')).toBeTruthy())
    const asked = (globalThis.fetch as jest.Mock).mock.calls.map((call) => String(call[0]))
    // `enabled: accountId !== null` — a playlists call with `account_id=null`
    // is a 422 the user can do nothing about.
    expect(asked.some((url) => url.includes('/spotify/playlists'))).toBe(false)
  })
})

describe('reviewing the matches', () => {
  it('shows what each track would actually download, not just what Spotify said', async () => {
    routes([
      [
        /matches/,
        pageOf([
          match({
            candidates: [
              {
                url: 'https://youtu.be/a',
                title: 'First song (official)',
                uploader: 'Label',
                duration: 212,
                score: 0.91,
              },
            ],
            chosen_url: 'https://youtu.be/a',
            status: 'auto_matched',
          }),
        ]),
      ],
    ])

    await render(<MatchReview importId="5" interactive />, { wrapper })

    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())
    // A review screen showing only the Spotify track asks the user to approve
    // something they cannot see.
    expect(screen.getByText('→ First song (official)')).toBeTruthy()
  })

  it('says so when the matcher found nothing', async () => {
    routes([[/matches/, pageOf([match({ status: 'no_match' })])]])

    await render(<MatchReview importId="5" interactive />, { wrapper })

    await waitFor(() => expect(screen.getByText('No candidate found')).toBeTruthy())
  })

  /*
   * One check box, not a tick and a cross (#377).
   *
   * the pair "reads as two actions when it is really one state". So the
   * row now carries a single checkbox meaning *will this be imported*, and these
   * tests are about that state rather than about two buttons.
   */
  it('includes one track when its box is ticked', async () => {
    routes([[/matches/, pageOf([match({ chosen_url: 'https://youtu.be/a' })])]])

    await render(<MatchReview importId="5" interactive />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Include First song in the import'))
    })

    await waitFor(() => expect(storedMatch().status).toBe('accepted'))
  })

  it('un-ticks a track that was already going to be imported', async () => {
    // The half a tick-and-cross pair could not express: the box is a toggle, so
    // the same control takes a decision back.
    routes([[/matches/, pageOf([match({ status: 'accepted', chosen_url: 'https://youtu.be/a' })])]])

    await render(<MatchReview importId="5" interactive />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())

    const box = screen.getByLabelText('Include First song in the import')
    expect(box.props.accessibilityState).toMatchObject({ checked: true })

    await act(async () => {
      fireEvent.press(box)
    })

    await waitFor(() => expect(storedMatch().status).toBe('rejected'))
  })

  it('will not let a track with no URL be included', async () => {
    // Accepting a track with nothing chosen would enqueue a download of
    // nothing, which the backend would then record as a failure.
    routes([[/matches/, pageOf([match({ status: 'no_match', chosen_url: null })])]])

    await render(<MatchReview importId="5" interactive />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())

    expect(
      screen.getByLabelText('Include First song in the import').props.accessibilityState,
    ).toMatchObject({ disabled: true, checked: false })
  })

  /** The opacity applied to the row containing a given title. */
  function rowOpacity(title: string): number | undefined {
    let node = screen.getByText(title) as
      { parent?: unknown; props?: { style?: unknown } } | undefined
    while (node) {
      const flat = StyleSheet.flatten(node.props?.style as never) as
        { opacity?: number } | undefined
      if (flat?.opacity !== undefined) return flat.opacity
      node = node.parent as typeof node
    }
    return undefined
  }

  it('dims a track that will not be imported, so the selection reads at a glance', async () => {
    // UI 3's other half. With only a status word to go on, working out what a
    // forty-row list is actually going to do meant reading all forty.
    routes([[/matches/, pageOf([match({ status: 'rejected', chosen_url: 'https://youtu.be/a' })])]])

    await render(<MatchReview importId="5" interactive />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())

    expect(rowOpacity('First song')).toBeLessThan(1)
  })

  it('leaves an included track at full strength', async () => {
    routes([[/matches/, pageOf([match({ status: 'accepted', chosen_url: 'https://youtu.be/a' })])]])

    await render(<MatchReview importId="5" interactive />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())

    // Without this the previous test passes against a component that dims
    // every row, which would say nothing at all.
    expect(rowOpacity('First song')).toBeUndefined()
  })

  it('says a row can be re-matched, which nothing did before (#377)', async () => {
    // "user wont know, there is no indication or hint". The whole row
    // opened the candidate sheet and looked exactly like a row that did not.
    routes([[/matches/, pageOf([match({ chosen_url: 'https://youtu.be/a' })])]])

    await render(<MatchReview importId="5" interactive />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())

    expect(screen.getByText('Change ›')).toBeTruthy()
  })

  it('offers a finished row a different hint, because the decision is a different one', async () => {
    // Once the import has run the question stops being "which of these is it?"
    // and becomes "that one did not work, try another" (#399) — so the row still
    // opens the sheet, and says a different thing above it.
    mockSourcesWithAudio.mockResolvedValue(new Set())
    routes([[/matches/, pageOf([match({ status: 'imported' })])]])

    await render(<MatchReview importId="5" />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())

    expect(screen.queryByText('Change ›')).toBeNull()
    expect(screen.getByText('Try another source ›')).toBeTruthy()
  })

  it('rejects everything currently shown in one tap, and says how many that is', async () => {
    routes([[/matches/, pageOf([match({ id: 1 }), match({ id: 2, title: 'Second song' })])]])

    await render(<MatchReview importId="5" interactive />, { wrapper })
    await waitFor(() => expect(screen.getByText('Second song')).toBeTruthy())

    // The count is on the button, so the scope of a bulk action is visible
    // before it is pressed rather than after.
    await act(async () => {
      fireEvent.press(screen.getByText('Reject all 2 shown'))
    })

    // Both rows, in one action — the count on the button and the rows written
    // have to agree, which is the whole claim.
    await waitFor(() => expect(storedMatch('1').status).toBe('rejected'))
    expect(storedMatch('2').status).toBe('rejected')
  })

  it('offers no accept or reject once the import is a record rather than a decision', async () => {
    routes([[/matches/, pageOf([match({ status: 'imported' })])]])

    await render(<MatchReview importId="5" />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())

    expect(screen.queryByLabelText('Include First song in the import')).toBeNull()
    expect(screen.queryByText(/^Reject all/)).toBeNull()
    // …and the filters change with it: "did it work?" replaces "what needs me?".
    // Asserted on the two chips that belong to exactly one of the sets, so
    // neither can be satisfied by a row's status label saying the same word.
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.queryByText('Needs review')).toBeNull()
  })

  it('repointing a track accepts it too, rather than asking twice', async () => {
    routes([
      [
        /matches/,
        pageOf([
          match({
            candidates: [
              {
                url: 'https://youtu.be/b',
                title: 'A better take',
                uploader: null,
                duration: null,
                score: 0.4,
              },
            ],
          }),
        ]),
      ],
    ])

    await render(<MatchReview importId="5" interactive />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Choose a different match for First song'))
    })
    await act(async () => {
      fireEvent.press(screen.getByText(/A better take/))
    })

    // Choosing a track *is* the decision; making the user then press ✓ would be
    // a second tap for an answer already given.
    await waitFor(() => expect(storedMatch().chosen_url).toBe('https://youtu.be/b'))
    expect(storedMatch().status).toBe('accepted')
    // ⚠️ And the score comes from the candidate, not from the caller (#610) —
    // a repoint to a listed candidate keeps that candidate's number.
    expect(storedMatch().confidence).toBe(0.4)
  })
})

describe('why a track did not arrive', () => {
  /*
   * #565 — the message I hit importing a NetEase 歌单 with the source set
   * to Bilibili: *"YouTube will not play this one here"*, about a Bilibili
   * match, on the one screen the whole Chinese-import feature ends at.
   *
   * `VideoUnavailable` comes from both extractors — `bilibili.ts` throws it for
   * codes -404, -403, 62002 and 62004 — and the copy named YouTube regardless.
   * The row does know: it has `chosen_url`, and `platformOf` is already the
   * app's answer to which service that is.
   *
   * Asserted both ways in one render, so a string that had merely stopped
   * naming anything would fail rather than pass.
   */
  it('blames the service the match actually came from', async () => {
    routes([
      [
        /matches/,
        pageOf([
          match({ id: 1, position: 0, title: 'A song', chosen_url: 'https://b23.tv/vtV4k1G' }),
          match({
            id: 2,
            position: 1,
            title: 'B song',
            chosen_url: 'https://youtu.be/dQw4w9WgXcQ',
          }),
        ]),
      ],
    ])
    useTrackStates
      .getState()
      .set('5', 'https://b23.tv/vtV4k1G', { phase: 'failed', attempt: 1, failure: 'unavailable' })
    useTrackStates.getState().set('5', 'https://youtu.be/dQw4w9WgXcQ', {
      phase: 'failed',
      attempt: 1,
      failure: 'unavailable',
    })

    await render(<MatchReview importId="5" />, { wrapper })

    await waitFor(() =>
      expect(screen.getByText(/^Bilibili will not play this one here/)).toBeTruthy(),
    )
    expect(screen.getByText(/^YouTube will not play this one here/)).toBeTruthy()
  })
})

describe('how a track failed, not just that it did (#582)', () => {
  /*
   * Bug 2 of the 2026-08-17 report: an eighteen-track import where every row
   * said "failed" and nothing said why. `TrackState` carried a `FailureKind`
   * and no message at all, so all eighteen rows rendered the same sentence —
   * and the run could not be diagnosed from the screen it happened on.
   *
   * Rendered rather than asserted on the store, because the store already held
   * enough to be useful and the screen was throwing it away. Same shape as
   * #561: the ingredient existed, the wiring did not.
   */
  it('shows the status and byte offset under the reason', async () => {
    routes([[/matches/, pageOf([match({ chosen_url: 'https://youtu.be/dQw4w9WgXcQ' })])]])
    useTrackStates.getState().set('5', 'https://youtu.be/dQw4w9WgXcQ', {
      phase: 'failed',
      attempt: 3,
      failure: 'refused',
      detail: 'Download refused with status 403 at byte 0',
    })

    await render(<MatchReview importId="5" />, { wrapper })

    // The kind first — #441's ordering, which this does not reverse.
    await waitFor(() => expect(screen.getByText(/refused the download/)).toBeTruthy())
    // Then the half that distinguishes a block from a spent URL from a timeout.
    expect(screen.getByText(/status 403 at byte 0/)).toBeTruthy()
  })

  it('adds no second line when there is no detail to add', async () => {
    // States written before #582 have no `detail`, and every non-failed phase
    // has none either. Neither may gain an empty row.
    routes([[/matches/, pageOf([match({ chosen_url: 'https://youtu.be/dQw4w9WgXcQ' })])]])
    useTrackStates
      .getState()
      .set('5', 'https://youtu.be/dQw4w9WgXcQ', { phase: 'failed', attempt: 1, failure: 'offline' })

    await render(<MatchReview importId="5" />, { wrapper })

    await waitFor(() => expect(screen.getByText(/No connection/)).toBeTruthy())
    expect(screen.queryByText(/status \d+ at byte/)).toBeNull()
  })
})

/**
 * Pictures in the review (#312).
 *
 * tracks in the review page should show a thumbnail, and so should the
 * candidates when picking an alternative. The backend supplies them from the
 * flat extraction it was already doing, so a row costs no extra request.
 */
describe('seeing what would be downloaded', () => {
  const withThumbnail = {
    url: 'https://youtu.be/a',
    title: 'First song (official)',
    uploader: 'Label',
    duration: 212,
    score: 0.91,
    thumbnail: 'https://i.ytimg.com/vi/a/hq.jpg',
  }

  it('shows the picture of the video, not of the Spotify track', async () => {
    routes([
      [
        /matches/,
        pageOf([match({ candidates: [withThumbnail], chosen_url: 'https://youtu.be/a' })]),
      ],
    ])

    await render(<MatchReview importId="5" interactive />, { wrapper })

    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())
    // `includeHiddenElements`, because the picture is deliberately hidden from
    // screen readers — the row's text already says what the track is, and an
    // unlabelled image would just be noise to read out. RNTL skips such
    // elements by default, which reads as "the thumbnail is not rendered".
    expect(
      screen.getByTestId('match-thumbnail-1', { includeHiddenElements: true }).props.source,
    ).toEqual({ uri: 'https://i.ytimg.com/vi/a/hq.jpg' })
  })

  it('shows the first candidate before anything has been chosen', async () => {
    // The row still has to say what it is about; "nothing chosen yet" is not a
    // reason to show a blank square.
    routes([[/matches/, pageOf([match({ candidates: [withThumbnail], chosen_url: null })])]])

    await render(<MatchReview importId="5" interactive />, { wrapper })

    await waitFor(() =>
      expect(screen.getByTestId('match-thumbnail-1', { includeHiddenElements: true })).toBeTruthy(),
    )
  })

  it('shows a picture beside each candidate when picking between them', async () => {
    routes([
      [
        /matches/,
        pageOf([
          match({
            candidates: [
              withThumbnail,
              { ...withThumbnail, url: 'https://youtu.be/b', title: 'First song (live)' },
            ],
            chosen_url: 'https://youtu.be/a',
          }),
        ]),
      ],
    ])

    await render(<MatchReview importId="5" interactive />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Choose a different match for First song'))
    })

    // Two videos with nearly the same title is exactly when a picture is what
    // decides it — which is the case this is for.
    expect(
      screen.getByTestId('sheet-thumbnail-https://youtu.be/a-0', { includeHiddenElements: true }),
    ).toBeTruthy()
    expect(
      screen.getByTestId('sheet-thumbnail-https://youtu.be/b-1', { includeHiddenElements: true }),
    ).toBeTruthy()
  })

  it('draws a placeholder when there is no picture at all', async () => {
    // Candidates stored before #312 carry no such key, and plenty of videos
    // have no artwork. Neither is a failure.
    routes([[/matches/, pageOf([match({ candidates: [], status: 'no_match' })])]])

    await render(<MatchReview importId="5" interactive />, { wrapper })

    await waitFor(() => expect(screen.getByTestId('match-thumbnail-empty-1')).toBeTruthy())
  })
})

/**
 * The four sub-lists on a finished import record (#308).
 *
 * "we have 4 sub-lists — all, imported, failed, non-match — but imported
 * and failed are always empty, even though they all succeeded."
 *
 * They were `TrackMatchStatus` values the **server** sets when *it* downloads,
 * and it has downloaded nothing since confirm began sending `download: false`
 * (#270). So "imported" could never fill, however well an import went. The
 * device holds the answer — a track is imported if its audio is here.
 */
describe('which tracks a finished import actually landed', () => {
  const chosen = {
    url: 'https://youtu.be/a',
    title: 'First song (official)',
    uploader: 'Label',
    duration: 212,
    score: 0.91,
    thumbnail: null,
  }

  const landed = match({
    id: 1,
    title: 'Landed',
    candidates: [chosen],
    chosen_url: 'https://youtu.be/a',
    status: 'auto_matched',
  })
  const missing = match({
    id: 2,
    title: 'Missing',
    candidates: [{ ...chosen, url: 'https://youtu.be/b' }],
    chosen_url: 'https://youtu.be/b',
    status: 'auto_matched',
  })
  const never = match({ id: 3, title: 'Never matched', candidates: [], status: 'no_match' })

  beforeEach(() => {
    mockSourcesWithAudio.mockResolvedValue(new Set(['https://youtu.be/a']))
  })

  async function openResults() {
    routes([[/matches/, pageOf([landed, missing, never])]])
    await render(<MatchReview importId="5" />, { wrapper })
    await waitFor(() => expect(screen.getByText('Landed')).toBeTruthy())
  }

  it('lists the tracks whose audio is on this device under Imported', async () => {
    await openResults()

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Imported' }))
    })

    expect(screen.getByText('Landed')).toBeTruthy()
    expect(screen.queryByText('Missing')).toBeNull()
    expect(screen.queryByText('Never matched')).toBeNull()
  })

  it('lists the ones it meant to fetch and did not under Failed', async () => {
    await openResults()

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Failed' }))
    })

    expect(screen.getByText('Missing')).toBeTruthy()
    expect(screen.queryByText('Landed')).toBeNull()
    // A track with no candidate at all was never going to be fetched; it
    // belongs in its own list, not among the failures.
    expect(screen.queryByText('Never matched')).toBeNull()
  })

  // Queried by role, not by text: "No match" is both a filter chip and the
  // status a row prints, so `getByText` finds two.
  it('keeps "no match" the server\'s answer, because nothing was ever chosen', async () => {
    await openResults()

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'No match' }))
    })

    expect(screen.getByText('Never matched')).toBeTruthy()
    expect(screen.queryByText('Landed')).toBeNull()
  })

  it('shows everything under All', async () => {
    await openResults()

    expect(screen.getByText('Landed')).toBeTruthy()
    expect(screen.getByText('Missing')).toBeTruthy()
    expect(screen.getByText('Never matched')).toBeTruthy()
  })

  /**
   * Pointing a failed track somewhere else (#399), from the device pass.
   *
   * *"i want to change the source to try if it work, but there are no
   * option for you to change source for failed track, maybe change source could
   * help"*. The review stage has offered exactly this since #203; it vanished
   * the moment the import ran, on the rows where a human has the most to add.
   *
   * The issue asked for its own premise to be checked rather than assumed — that
   * the matcher's other candidates survive the import. They do: `candidates`
   * comes down with every row in both modes, which is why the sheet below is the
   * same one, not a new one.
   */
  it('offers another source for a track the device never got', async () => {
    await openResults()

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Choose a different match for Missing'))
    })

    // The candidate sheet, opened from the results stage.
    expect(screen.getByText('Custom URL…')).toBeTruthy()
  })

  it('offers it for a track the matcher found nothing for, which is where it helps most', async () => {
    await openResults()

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Choose a different match for Never matched'))
    })

    expect(screen.getByText('Custom URL…')).toBeTruthy()
  })

  it('offers nothing for a track that is already on the device', async () => {
    /*
     * The one row where there is genuinely nothing to fix. Without this the
     * test above passes against a component that made every row pressable,
     * which would put "try another source" on a track that worked.
     *
     * **Waited for, not asserted straight after the render**, and this failed on
     * CI before it was: whether a row is repointable depends on the device's own
     * answer about which audio it holds, and until that query resolves `onDevice`
     * is `undefined` and *every* row is offered — including this one. `openResults`
     * waits for the row's text, which arrives first, so a bare assertion here was
     * racing a promise. It won on a laptop and lost on CI, which is 4–7x slower
     * (#279). `docs/lessons.md`: the pixel is not evidence.
     */
    await openResults()

    await waitFor(() =>
      expect(screen.queryByLabelText('Choose a different match for Landed')).toBeNull(),
    )
    // And the wait is not the assertion passing for the wrong reason: the row
    // is still there, and its neighbour is still offered.
    expect(screen.getByText('Landed')).toBeTruthy()
    expect(screen.getByLabelText('Choose a different match for Missing')).toBeTruthy()
  })

  it('says the repoint is not the fetch, because the fetch has already happened', async () => {
    await openResults()

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Choose a different match for Missing'))
    })
    await act(async () => {
      fireEvent.press(screen.getByText(/First song \(official\)/))
    })

    // Repointed and accepted in one go, as the review stage does...
    await waitFor(() => expect(storedMatch('2').status).toBe('accepted'))
    // `Missing`'s own candidate, not `Landed`'s — the two share a title and
    // only the URL tells them apart, which is why this asserts the URL.
    expect(storedMatch('2').chosen_url).toBe('https://youtu.be/b')
    // ...and the user is told where the download actually starts. Changing the
    // source after the run is half the job, and a repoint that appears to do
    // nothing is the failure this issue is a second version of.
    expect(useToast.getState().message).toMatch(/Try the tracks that failed/)
  })
})
