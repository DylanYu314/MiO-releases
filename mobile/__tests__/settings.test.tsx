import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'

import SettingsScreen from '../app/(tabs)/settings'
import { exportLibrary } from '../src/library/libraryExport'
import { pickLibraryFile, runLibraryImport } from '../src/library/libraryImport'
import { useListImportProgress } from '../src/api/listImportProgress'
import { useConnection } from '../src/api/connection'
import i18n from '../src/i18n'
import { useAudioSettings } from '../src/player/audioSettings'
import { usePlayer } from '../src/player/store'

jest.mock('../src/library/libraryExport', () => ({
  exportLibrary: jest.fn(),
}))

jest.mock('../src/library/libraryImport', () => ({
  ...jest.requireActual('../src/library/libraryImport'),
  pickLibraryFile: jest.fn(),
  runLibraryImport: jest.fn(),
}))

jest.mock('expo-router', () => ({
  // The guard reads the current path to know a navigation landed (#375).
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

/*
 * The screen reads a query client since #729: finishing an import has to
 * invalidate the library list, or the songs it just added are invisible until
 * the app restarts.
 */
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      // Both groups, per the recorded lesson: a `queries`-only setting leaves a
      // settled mutation's five-minute timer holding the worker open.
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper })

beforeEach(async () => {
  jest.clearAllMocks()
  await i18n.changeLanguage('en')
  useConnection.setState({
    serverUrl: 'https://mio.test/api',
    accessKey: null,
    usingDefaultServer: true,
    loaded: true,
  })
  useAudioSettings.setState({ normalizeLoudness: true })
})

describe('SettingsScreen', () => {
  it('offers no access-key field, with or without a key stored', async () => {
    /*
     * There used to be three tests here — the "no key" caption, saving a pasted
     * key, and clearing one. All three described a screen that made sense while
     * the key decided whether search and import worked at all.
     *
     * It no longer does (#721). #613 ships the app with no server, #637 deleted
     * the one screen that handed a link to one, and #614 put `POST /jobs`
     * behind a key on a server the user runs themselves. So the field asked a
     * normal user for a credential to a server they do not have.
     *
     * Asserted in both states, because a field hidden only when a key exists
     * would satisfy a one-state test and still be wrong.
     */
    await render(<SettingsScreen />)
    expect(screen.queryByLabelText('Access key')).toBeNull()
    expect(screen.queryByText(/No key on this device/)).toBeNull()

    await act(async () => {
      useConnection.setState({ accessKey: 'existing' })
    })
    expect(screen.queryByLabelText('Access key')).toBeNull()
    expect(screen.queryByText('Clear')).toBeNull()

    // The control: the screen still rendered. Without it, a crashed render
    // would satisfy every assertion above. Re-anchored from the server row,
    // which has moved to /diagnostics.
    expect(screen.getByText('Privacy policy')).toBeTruthy()
  })

  it('shows a normal user nothing about servers at all', async () => {
    /*
     * ⛔ This used to assert the opposite, and the opposite was wrong.
     *
     * #721 removed the access-key field on the reasoning that "a credential
     * field for a server you do not have is worse than no field" — and left the
     * button that opens `/setup`, which asks for exactly that key, on the same
     * screen. So a normal user tapped *Change server* and was asked to connect
     * to something that does not exist. The reasoning was applied to the screen
     * and not to the door out of it.
     *
     * The app ships with no server and needs none (#613, ADR-020), so this is a
     * self-hoster's control. It lives on `/diagnostics` now, which is the
     * screen a self-hoster already reads and the one that already prints the
     * address (#374).
     */
    await render(<SettingsScreen />)

    expect(screen.queryByText('Server address')).toBeNull()
    expect(screen.queryByText('Change server')).toBeNull()
    expect(screen.queryByText('No server. Everything stays on this device.')).toBeNull()
  })

  it('switches language and re-renders in it', async () => {
    await render(<SettingsScreen />)
    expect(screen.getByText('Privacy policy')).toBeTruthy()

    await act(async () => {
      fireEvent.press(screen.getByText('中文'))
    })

    await waitFor(() => expect(i18n.language).toBe('zh'))
    // Proof the switch reached the tree, not just the i18n instance. Re-anchored
    // on the privacy link: the server row this used to read has moved off this
    // screen entirely, and before that #721 removed the Save button.
    await waitFor(() => expect(screen.getByText('隐私政策')).toBeTruthy())
  })

  it('leaves the export result on screen, because a toast cannot carry it', async () => {
    /*
     * ⚠️ Reported from a device: the export worked, said something had been
     * left out, and vanished before it could be read. A toast is 2200 ms
     * (`Toast.tsx`) and the skipped message is two sentences carrying a count
     * and a reason — it was announcing information it had no time to deliver.
     *
     * Asserted on the *rendered tree*, not on the toast: a longer toast would
     * still be a toast, and this has to survive being read slowly.
     */
    jest.mocked(exportLibrary).mockResolvedValue({
      uri: 'content://tree/whatever',
      songCount: 28,
      playlistCount: 3,
      skippedLocal: 1,
    })

    await render(<SettingsScreen />)
    await act(async () => {
      fireEvent.press(screen.getByText('Save a copy'))
    })

    await waitFor(() => expect(screen.getByText(/28 songs/)).toBeTruthy())
    // The reason, which is the half that needed reading.
    expect(screen.getByText(/1 song were left out|1 song was left out|1 song/)).toBeTruthy()
  })

  it('says nothing about skipped files when nothing was skipped', async () => {
    // The control: the result line must be able to *not* mention omissions, or
    // it would always have something alarming to say and stop being read.
    jest.mocked(exportLibrary).mockResolvedValue({
      uri: 'content://tree/whatever',
      songCount: 29,
      playlistCount: 3,
      skippedLocal: 0,
    })

    await render(<SettingsScreen />)
    await act(async () => {
      fireEvent.press(screen.getByText('Save a copy'))
    })

    await waitFor(() => expect(screen.getByText(/Saved 29 songs\./)).toBeTruthy())
    expect(screen.queryByText(/left out/)).toBeNull()
  })

  it('shows how far a library import has got, like every other import does', async () => {
    /*
     * ⚠️ Reported from a device: a library copy downloaded with no progress at
     * all, unlike a Spotify or Bilibili import, so there was no way to tell it
     * apart from a hung app.
     *
     * The run always reported into `useListImportProgress`; nothing rendered
     * it. Asserted by seeding the store the way the run writes it, so this
     * covers the *display* rather than the loop that already had tests.
     */
    jest.mocked(pickLibraryFile).mockResolvedValue({
      format: 'mio.library',
      version: 1,
      exported_at: '2026-09-08T12:00:00.000Z',
      songs: [{ source_url: 'https://youtu.be/a' }],
      playlists: [],
      skipped_local: 0,
    } as never)
    jest.mocked(runLibraryImport).mockReturnValue(new Promise(() => {}) as never)

    await render(<SettingsScreen />)
    await act(async () => {
      fireEvent.press(screen.getByText('Load a copy'))
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Download them'))
    })
    await act(async () => {
      useListImportProgress.getState().report('libraryCopy:2026-09-08T12:00:00.000Z', {
        done: 3,
        total: 10,
        saved: 2,
        failed: 1,
        alreadyHere: 4,
        running: true,
      })
    })

    expect(screen.getByText(/3 of 10/)).toBeTruthy()
    expect(screen.getByText(/2 saved, 1 failed/)).toBeTruthy()
    // The 4 the run is not counting as work, which a bare "3 of 10" leaves
    // unexplained on a list of 14.
    expect(screen.getByText(/4 were already on this phone/)).toBeTruthy()
  })

  it('turns loudness normalization off, and keeps it off', async () => {
    await render(<SettingsScreen />)

    const toggle = screen.getByLabelText('Even out volume')
    expect(toggle.props.value).toBe(true)

    await act(async () => {
      fireEvent(toggle, 'valueChange', false)
    })

    await waitFor(() => expect(useAudioSettings.getState().normalizeLoudness).toBe(false))
    // The switch has to show the new state, not just record it.
    expect(screen.getByLabelText('Even out volume').props.value).toBe(false)
  })
})

describe('crossfade (#201)', () => {
  it('offers Off and a few lengths, and records the choice', async () => {
    await render(<SettingsScreen />)

    await act(async () => {
      fireEvent.press(screen.getByText('6 seconds'))
    })

    expect(usePlayer.getState().crossfadeSeconds).toBe(6)
  })

  it('can be turned back off, which is the default and the single-deck path', async () => {
    usePlayer.setState({ crossfadeSeconds: 6 })

    await render(<SettingsScreen />)
    await act(async () => {
      fireEvent.press(screen.getByText('Off'))
    })

    expect(usePlayer.getState().crossfadeSeconds).toBe(0)
  })
})
