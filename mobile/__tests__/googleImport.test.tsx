import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { Alert } from 'react-native'
import * as Linking from 'expo-linking'

import ImportScreen, { GoogleSection } from '../app/(tabs)/add/import/index'
import GooglePlaylistsScreen from '../app/(tabs)/add/import/google'
import { ApiError, errorFrom } from '../src/api/client'
import { useConnection } from '../src/api/connection'
import { resetListImportProgress, useListImportProgress } from '../src/api/listImportProgress'
import type { GooglePlaylist, GoogleStatus } from '../src/api/types'
import '../src/i18n'

/**
 * Importing a **private** YouTube playlist (#106).
 *
 * This slice is the connection: three states, a browser round trip, and the
 * weekly expiry that the issue asks to be surfaced rather than left to look
 * like a fault. The picker and the on-device download arrive next.
 *
 * The backend half — `?client=app`, the deep-link callback, and which 401 is
 * which — is `backend/tests/test_google_api.py`. Nothing here can prove the
 * browser comes back, because that journey leaves the app.
 *
 * ## Why these render `GoogleSection` and not `ImportScreen` (#504)
 *
 * `GOOGLE_IMPORT_ENABLED` is `false`, so the import screen no longer mounts this
 * section at all — Google would need either to review MiO or to show every user
 * a warning screen, and neither was acceptable. The component and its three
 * states are **kept**, because a self-hoster with their own Google project flips
 * one constant to get them back, so the coverage is kept too and simply points
 * at the component instead of the screen that used to host it.
 *
 * `the disabled feature` below is the other half: it asserts the screen shows
 * the unlisted-playlist route rather than a sign-in button.
 */

const mockPush = jest.fn()
const mockParams: { google_error?: string } = {}
jest.mock('expo-router', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (effect: () => void) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react')
    React.useEffect(effect, [effect])
  },
}))

jest.mock('expo-linking', () => ({ openURL: jest.fn() }))

jest.mock('../src/library/songs', () => ({
  sourcesWithAudio: jest.fn(async () => new Set()),
  formatDuration: jest.requireActual('../src/api/songs').formatDuration,
}))

jest.mock('../src/library/playlistImport', () => ({ importPlaylistOnDevice: jest.fn() }))

const mockRunImport = jest.fn()
jest.mock('../src/library/googleImport', () => ({
  importGooglePlaylistOnDevice: (...args: unknown[]) => mockRunImport(...args),
}))

function status(overrides: Partial<GoogleStatus> = {}): GoogleStatus {
  return {
    configured: true,
    channel_id: 'UC123',
    channel_title: 'a personal channel',
    connected_at: '2026-08-13T00:00:00Z',
    ...overrides,
  }
}

const DISCONNECTED = status({ channel_id: null, channel_title: null, connected_at: null })

/** A router keyed on the URL: this screen asks four endpoints, and one canned
 *  body for all of them is a different server. */
function routes(table: [RegExp, unknown][], record?: { url: string; method: string }[]) {
  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    record?.push({ url: String(url), method: init?.method ?? 'GET' })
    const hit = table.find(([pattern]) => pattern.test(String(url)))
    return {
      ok: true,
      status: 200,
      json: async () => (hit ? hit[1] : { items: [], total: 0, limit: 50, offset: 0 }),
    }
  }) as unknown as typeof fetch
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function playlist(overrides: Partial<GooglePlaylist> = {}): GooglePlaylist {
  return { id: 'PL1', title: 'Late night', track_count: 12, privacy: 'private', ...overrides }
}

/**
 * A server that refuses, with a body of its own.
 *
 * The status alone is not the interesting part — two of these are 401 — so the
 * fake has to be able to answer with the code as well.
 */
function refuses(status: number, detail: unknown) {
  globalThis.fetch = jest.fn(async () => ({
    ok: false,
    status,
    json: async () => ({ detail }),
  })) as unknown as typeof fetch
}

beforeEach(() => {
  jest.clearAllMocks()
  delete mockParams.google_error
  resetListImportProgress()
  mockRunImport.mockResolvedValue({
    saved: 2,
    failed: 0,
    alreadyHere: 0,
    local_playlist_id: 'local-playlist',
  })
  useConnection.setState({
    serverUrl: 'https://mio.test/api',
    accessKey: 'a-key',
    usingDefaultServer: true,
    loaded: true,
  })
})

/**
 * What the import screen offers now that sign-in is off (#504, #106).
 *
 * The point of this block is that the *screen* changed, so it renders the
 * screen. Asserting on `GoogleSection` here would prove nothing — the section
 * still works, it is simply not mounted.
 *
 * The negative assertion is the load-bearing one: "Connect YouTube" is a real
 * string that a real component still renders, so this fails the moment the
 * section is wired back in without the flag being flipped deliberately.
 */
describe('the disabled feature', () => {
  it('offers the unlisted-playlist route instead of a sign-in button', async () => {
    routes([
      [/google\/status/, status()],
      [/spotify\/status/, { configured: false, accounts: [] }],
    ])

    await render(<ImportScreen />, { wrapper })

    await waitFor(() =>
      expect(screen.getByText(/change that playlist's privacy to Unlisted/)).toBeTruthy(),
    )
    expect(screen.queryByText('Connect YouTube')).toBeNull()
    expect(screen.queryByText('Connected as a personal channel.')).toBeNull()
  })

  it('does not warn about a weekly expiry that can no longer happen', async () => {
    // The standing note was correct while the consent screen was in Testing.
    // Left mounted with no way to sign in, it would be a warning about a
    // connection the user cannot make.
    routes([
      [/google\/status/, DISCONNECTED],
      [/spotify\/status/, { configured: false, accounts: [] }],
    ])

    await render(<ImportScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText(/Unlisted/)).toBeTruthy())
    expect(screen.queryByText(/Google signs MiO out about once a week/)).toBeNull()
  })
})

describe('connecting a YouTube account', () => {
  it('opens the backend login in a browser, telling it the app started it', async () => {
    routes([
      [/google\/status/, DISCONNECTED],
      [/spotify\/status/, { configured: false, accounts: [] }],
    ])

    await render(<GoogleSection />, { wrapper })
    await waitFor(() => expect(screen.getByText('Connect YouTube')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByText('Connect YouTube'))
    })

    // `client=app` is what makes the callback deep-link back to the app rather
    // than landing on the web client, where the phone never sees it.
    expect(Linking.openURL).toHaveBeenCalledWith('https://mio.test/api/google/login?client=app')
  })

  it('names the connected channel', async () => {
    routes([
      [/google\/status/, status()],
      [/spotify\/status/, { configured: false, accounts: [] }],
    ])

    await render(<GoogleSection />, { wrapper })

    await waitFor(() => expect(screen.getByText('Connected as a personal channel.')).toBeTruthy())
    expect(screen.queryByText('Connect YouTube')).toBeNull()
  })

  it('says the server is not set up rather than offering a button that 503s', async () => {
    // The third state, and the reason there are three: no amount of tapping in
    // the app adds a GOOGLE_CLIENT_ID to the server.
    routes([
      [/google\/status/, status({ configured: false, channel_id: null, channel_title: null })],
      [/spotify\/status/, { configured: false, accounts: [] }],
    ])

    await render(<GoogleSection />, { wrapper })

    await waitFor(() =>
      expect(
        screen.getByText(
          "Private playlist import isn't set up on this server, so there's nothing to connect to yet.",
        ),
      ).toBeTruthy(),
    )
    expect(screen.queryByText('Connect YouTube')).toBeNull()
  })

  it('explains a failed sign-in that came back through the deep link', async () => {
    // A failure has nothing to re-read from the server, so it is the one thing
    // the deep link has to be parsed for.
    mockParams.google_error = 'exchange_failed'
    routes([
      [/google\/status/, DISCONNECTED],
      [/spotify\/status/, { configured: false, accounts: [] }],
    ])

    await render(<GoogleSection />, { wrapper })

    await waitFor(() =>
      expect(screen.getByText(/no YouTube channel yet, create one first/)).toBeTruthy(),
    )
  })

  it('confirms before disconnecting, and then forgets the account', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    const calls: { url: string; method: string }[] = []
    routes(
      [
        [/google\/status/, status()],
        [/spotify\/status/, { configured: false, accounts: [] }],
      ],
      calls,
    )

    await render(<GoogleSection />, { wrapper })
    await waitFor(() => expect(screen.getByText('Connected as a personal channel.')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByText('Disconnect'))
    })

    const [, message, buttons] = alert.mock.calls[0]
    // The music is the thing a user will be afraid of losing, so the message
    // has to say it stays — the same reason the delete confirmation does.
    expect(message).toContain('stays on this device')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)

    await act(async () => {
      ;(buttons as { text: string; onPress?: () => void }[])
        .find((button) => button.text === 'Disconnect')
        ?.onPress?.()
    })

    await waitFor(() =>
      expect(
        calls.some((call) => call.method === 'DELETE' && call.url.includes('/google/account')),
      ).toBe(true),
    )
    alert.mockRestore()
  })
})

/**
 * The 7-day expiry, which the issue asks to be surfaced rather than discovered.
 *
 * `/google/status` reads our database and not Google, so it goes on saying
 * "connected" for an account whose refresh token expired hours ago. The note is
 * therefore standing text in **both** states: a warning that appears only once
 * the account is already broken arrives after the confusion it exists to
 * prevent.
 */
describe('the weekly expiry', () => {
  it.each([
    ['connected', status()],
    ['not connected', DISCONNECTED],
  ])('is explained while %s', async (_name, body) => {
    routes([
      [/google\/status/, body],
      [/spotify\/status/, { configured: false, accounts: [] }],
    ])

    await render(<GoogleSection />, { wrapper })

    await waitFor(() =>
      expect(screen.getByText(/Google signs MiO out about once a week/)).toBeTruthy(),
    )
  })
})

/**
 * Reading *which* failure a status carries (#106).
 *
 * Two unrelated things answer 401 on the listing endpoints — the access-key
 * gate and a dead Google authorization — and they ask for opposite actions.
 * The server names the second one; this is the client half of that contract,
 * and it is what the next slice's screen reasons about.
 */
describe('the error body', () => {
  const responseOf = (body: unknown) =>
    ({ status: 401, json: async () => body }) as unknown as Response

  it('carries a code when the server names one', async () => {
    expect(
      await errorFrom(responseOf({ detail: { code: 'google_reauth', message: 'expired' } })),
    ).toEqual({ message: 'expired', code: 'google_reauth' })
  })

  it('leaves the code null for an ordinary string detail', async () => {
    // What the access-key gate answers. Reading a code out of this one is what
    // would tell a locked-out tester to reconnect their YouTube account.
    expect(
      await errorFrom(responseOf({ detail: 'A valid access key is required to import' })),
    ).toEqual({ message: 'A valid access key is required to import', code: null })
  })

  it('still reads a validation error, which is a list and also an object', async () => {
    const body = { detail: [{ loc: ['body'], msg: 'field required', type: 'missing' }] }

    expect(await errorFrom(responseOf(body))).toEqual({ message: 'field required', code: null })
  })

  it('falls back to the status when the body is not JSON', async () => {
    const broken = {
      status: 502,
      json: async () => {
        throw new Error('not JSON')
      },
    } as unknown as Response

    expect(await errorFrom(broken)).toEqual({
      message: 'Request failed with status 502',
      code: null,
    })
  })

  it('defaults ApiError.code to null, so an older thrower is not a false name', () => {
    expect(new ApiError(404, 'gone').code).toBeNull()
  })
})

/**
 * Picking a playlist, and being told why when it will not list them.
 *
 * The failures are the point of this screen as much as the list is: the
 * connection expires **every 7 days** while the consent screen is in Testing,
 * so an unnamed error here is a feature that looks broken every week.
 */
describe('the playlist picker', () => {
  it('lists them, and says which ones are private', async () => {
    routes([
      [
        /google\/playlists/,
        [
          playlist(),
          playlist({ id: 'PL2', title: 'Public mix', privacy: 'public', track_count: 5 }),
        ],
      ],
    ])

    await render(<GooglePlaylistsScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('Late night')).toBeTruthy())
    expect(screen.getByText('12 videos')).toBeTruthy()
    /*
     * Only where it is not public — a private playlist is the whole reason this
     * screen exists, and a badge on everything says nothing.
     *
     * By test id rather than by the word: badging *every* row renders
     * `google.public` for a public one, which is a missing translation key and
     * not the word "Private", so an assertion on the text passes against the
     * broken behaviour. (It did.)
     */
    expect(screen.getByTestId('privacy-PL1')).toHaveTextContent('Private')
    expect(screen.queryByTestId('privacy-PL2')).toBeNull()
  })

  it('confirms before it starts, because tapping a row starts downloading', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    routes([[/google\/playlists/, [playlist()]]])

    await render(<GooglePlaylistsScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Late night')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByText('Late night'))
    })

    // There is no review step, so this confirmation is the only thing between a
    // mis-tap and a hundred videos over mobile data.
    const [title, message, buttons] = alert.mock.calls[0]
    expect(title).toBe('Late night')
    expect(message).toBe('12 videos')
    expect(mockRunImport).not.toHaveBeenCalled()

    await act(async () => {
      ;(buttons as { text: string; onPress?: () => void }[])
        .find((button) => button.text === 'Import')
        ?.onPress?.()
    })

    expect(mockRunImport).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'PL1', title: 'Late night' }),
      expect.any(Function),
    )
    alert.mockRestore()
  })

  it('names an expired connection and offers a way to fix it', async () => {
    // The weekly one. `google_reauth` is the server saying which 401 this is.
    refuses(401, { code: 'google_reauth', message: 'invalid_grant' })

    await render(<GooglePlaylistsScreen />, { wrapper })

    await waitFor(() =>
      expect(screen.getByText(/connection to your YouTube account has expired/)).toBeTruthy(),
    )
    await act(async () => {
      fireEvent.press(screen.getByText('Connect again'))
    })
    expect(Linking.openURL).toHaveBeenCalledWith('https://mio.test/api/google/login?client=app')
  })

  it('does not tell a locked-out tester to reconnect their YouTube account', async () => {
    /*
     * The other edge, and the whole reason the code exists (#392: a guard
     * proved only on the side it fires for is one a broken implementation
     * satisfies exactly as well).
     *
     * This is the *access-key* gate answering the same 401 — and it asks for
     * the opposite thing. Reading every 401 as an expiry would send someone
     * with no key round an OAuth loop that cannot help them.
     */
    refuses(401, 'A valid access key is required to import')

    await render(<GooglePlaylistsScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText(/needs an access key/)).toBeTruthy())
    expect(screen.queryByText('Connect again')).toBeNull()
  })

  it('says a spent quota resets, rather than calling it a broken connection', async () => {
    // The one failure waiting actually fixes, so it is the one message that may
    // say "try later" — and saying that about any of the others would be false.
    refuses(429, 'quota exceeded')

    await render(<GooglePlaylistsScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText(/used up today's YouTube allowance/)).toBeTruthy())
    expect(screen.queryByText('Connect again')).toBeNull()
  })

  it('joins a run that is already going instead of showing an idle picker', async () => {
    // The run is module state that outlives the screen (ADR-019). A screen that
    // opened on the picker while a download was running would offer to start it
    // a second time.
    useListImportProgress.setState({
      runs: {
        PL1: { done: 4, total: 12, saved: 4, failed: 0, alreadyHere: 0, running: true },
      },
    })
    routes([[/google\/playlists/, [playlist()]]])

    await render(<GooglePlaylistsScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('Downloading 4 of 12')).toBeTruthy())
    // And the warning that the screen has to stay open, which is the shipped
    // behaviour since background imports were de-scoped.
    expect(screen.getByText(/keep this screen open/i)).toBeTruthy()
  })

  it('reports what a finished run did, including what it did not have to do', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    // The real run publishes as it goes; the fake publishes what it finished
    // with, which is what the screen reads either way.
    mockRunImport.mockImplementation(async (chosen: { id: string }) => {
      useListImportProgress.setState({
        runs: {
          [chosen.id]: { done: 3, total: 3, saved: 3, failed: 1, alreadyHere: 9, running: false },
        },
      })
      return { saved: 3, failed: 1, alreadyHere: 9, local_playlist_id: 'local-playlist' }
    })
    routes([[/google\/playlists/, [playlist()]]])

    await render(<GooglePlaylistsScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Late night')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByText('Late night'))
    })
    await act(async () => {
      ;(alert.mock.calls[0][2] as { text: string; onPress?: () => void }[])
        .find((button) => button.text === 'Import')
        ?.onPress?.()
    })

    // "9 were already here" is not decoration: without it a playlist of 13
    // reporting 3 downloaded looks like ten lost tracks (#398).
    await waitFor(() => expect(screen.getByText(/9 were already on this device/)).toBeTruthy())
    expect(screen.getByText(/1 couldn't be downloaded/)).toBeTruthy()
    expect(screen.queryByText(/keep this screen open/i)).toBeNull()

    // And a way into what was just built, rather than hunting for it.
    await act(async () => {
      fireEvent.press(screen.getByText('Open playlist'))
    })
    expect(mockPush).toHaveBeenCalledWith('/playlists/local-playlist')
    alert.mockRestore()
  })
})
