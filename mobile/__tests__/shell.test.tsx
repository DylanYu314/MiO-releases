import { router } from 'expo-router'
import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library'
import { Text } from 'react-native'

/*
 * Static imports, despite pulling in layouts that render the mocked
 * `PlayerHost`. Babel hoists `jest.mock` above every import in the file, so the
 * layouts below already see the mock — `require`ing them lazily bought nothing
 * and tripped the no-require-imports rule.
 */
import RootLayout from '../app/_layout'
import TabsLayout from '../app/(tabs)/_layout'
import AddLayout from '../app/(tabs)/add/_layout'
import PlaylistsLayout from '../app/(tabs)/playlists/_layout'
import { usePlayer } from '../src/player/store'
import type { Song } from '../src/api/types'
import '../src/i18n'

/**
 * The app shell (#226) — the tab bar, and the `PlayerHost` split it forced.
 *
 * This is the one suite that mounts the **real navigator** rather than a screen
 * on its own, which matters here more than usual: every claim #226 makes is
 * about where components sit *relative to each other*, and a test that renders a
 * screen in isolation cannot see a layout at all. `docs/lessons.md` has the
 * general version — mocked suites hide whole classes of bug.
 *
 * ## Why it is one long test
 *
 * **`renderRouter` works once per file.** expo-router's router store is a module
 * singleton, and a second `renderRouter` in the same file renders nothing at
 * all; `jest.resetModules()` between them makes it worse, failing the first call
 * too. So the choice is one journey or seven files, and the journey is the
 * better fit anyway — "music keeps playing across every navigation" is a claim
 * about a sequence, and asserting it as one is more honest than seven fresh
 * mounts that never navigate anywhere.
 *
 * If this needs splitting later, split it by *file*, not by `it`.
 *
 * The screens are stubbed. Their content has its own suites, and pulling the
 * real ones in would drag SQLite, `expo-audio` and the query client into a test
 * about navigation.
 */

jest.mock('../src/components/ImportProgressPanel', () => ({
  ImportProgressPanel: () => null,
}))

/**
 * How often `PlayerHost` has been mounted.
 *
 * The audio engine must be constructed exactly once for the app's lifetime — it
 * owns the native player and the lock-screen session, and remounting it is
 * indistinguishable from the music stopping. Counting is the only way to see
 * that from outside, because a remount leaves no other trace.
 */
let playerHostMounts = 0
jest.mock('../src/player/PlayerHost', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')
  return {
    PlayerHost: () => {
      React.useEffect(() => {
        playerHostMounts += 1
      }, [])
      return null
    },
  }
})

const SONG: Song = {
  id: 7,
  title: 'Keeps Playing',
  artist: 'The Testers',
  album: 'Across Navigation',
  duration: 180,
  source_url: 'https://example.com/7',
  source_platform: 'youtube',
  added_at: '2026-07-25T00:00:00Z',
  loudness_lufs: null,
  peak_dbfs: null,
}

/** A screen that renders only its name, so navigation is what is asserted. */
function screenStub(label: string) {
  const Stub = () => <Text>{label}</Text>
  // Named, or `react/display-name` rightly objects to an anonymous component.
  Stub.displayName = label
  return Stub
}

function stubs() {
  return {
    _layout: RootLayout,
    setup: screenStub('SETUP SCREEN'),
    queue: screenStub('QUEUE SCREEN'),
    '(tabs)/_layout': TabsLayout,
    '(tabs)/index': screenStub('LIBRARY SCREEN'),
    '(tabs)/playlists/_layout': PlaylistsLayout,
    '(tabs)/playlists/index': screenStub('PLAYLISTS SCREEN'),
    // Declared because the layouts name them; stubbed because this suite is
    // about navigation, not their content.
    // Favourites is `[id]` too since #291, so there is no route to declare.
    '(tabs)/playlists/[id]': screenStub('PLAYLIST DETAIL SCREEN'),
    '(tabs)/add/_layout': AddLayout,
    '(tabs)/add/index': screenStub('ADD SCREEN'),
    '(tabs)/add/link': screenStub('ADD LINK SCREEN'),
    '(tabs)/add/search': screenStub('SEARCH SCREEN'),
    '(tabs)/add/import/index': screenStub('IMPORT SCREEN'),
    '(tabs)/add/import/[id]': screenStub('IMPORT DETAIL SCREEN'),
    '(tabs)/settings': screenStub('SETTINGS SCREEN'),
  }
}

it('is a tab bar with a mini player above it, and audio that never unmounts', async () => {
  await usePlayer.persist.rehydrate()
  usePlayer.getState().stop()
  playerHostMounts = 0

  renderRouter(stubs(), { initialUrl: '/' })

  // ---- The app opens on the library, with four destinations offered --------
  await waitFor(() => expect(screen.getByText('LIBRARY SCREEN')).toBeTruthy())
  expect(playerHostMounts).toBe(1)

  // The labels are load-bearing: the icons are hand-drawn shapes, not a
  // recognised icon set, so a bar without them is four guesses. `getAllBy`
  // because the Library tab also shows a header with the same title.
  expect(screen.getAllByText('Library').length).toBeGreaterThan(0)
  expect(screen.getAllByText('Playlists').length).toBeGreaterThan(0)
  expect(screen.getAllByText('Add').length).toBeGreaterThan(0)
  expect(screen.getAllByText('Settings').length).toBeGreaterThan(0)

  // ---- The mini player appears when something plays ------------------------
  await act(async () => {
    usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
  })
  await waitFor(() => expect(screen.getByText('Keeps Playing')).toBeTruthy())

  // ---- It survives a tab change, and so does the bar -----------------------
  act(() => router.navigate('/playlists'))
  await waitFor(() => expect(screen.getByText('PLAYLISTS SCREEN')).toBeTruthy())
  // Rendered as part of the tab bar, so switching tabs re-renders the screen
  // and leaves the player alone. This is the assertion the split exists for.
  expect(screen.getByText('Keeps Playing')).toBeTruthy()
  expect(screen.getAllByText('Library').length).toBeGreaterThan(0)

  // ---- A screen pushed *inside* a tab keeps both ---------------------------
  act(() => router.navigate('/add'))
  await waitFor(() => expect(screen.getByText('ADD SCREEN')).toBeTruthy())
  act(() => router.push('/add/link'))
  await waitFor(() => expect(screen.getByText('ADD LINK SCREEN')).toBeTruthy())
  // The reason Add and Playlists have stacks of their own rather than pushing
  // onto the root stack: covering the tabs would also hide the transport
  // controls, and browsing is exactly when you want to skip a track.
  expect(screen.getAllByText('Add').length).toBeGreaterThan(0)
  expect(screen.getByText('Keeps Playing')).toBeTruthy()

  // ---- The queue covers the tabs, deliberately ----------------------------
  act(() => router.push('/queue'))
  await waitFor(() => expect(screen.getByText('QUEUE SCREEN')).toBeTruthy())
  // The queue *is* the expanded player, so a mini player beneath it would be
  // the same thing twice.
  expect(screen.queryByText('Keeps Playing')).toBeNull()

  // ---- And the audio outlives all of it, including the setup redirect ------
  //
  // This is the failure #226 exists to prevent. `_layout.tsx` calls
  // `router.replace('/setup')`, which unmounts whatever the navigator held —
  // so while the bar and the audio were one component, that stopped the music.
  act(() => router.replace('/setup'))
  await waitFor(() => expect(screen.getByText('SETUP SCREEN')).toBeTruthy())

  expect(playerHostMounts).toBe(1)
  expect(usePlayer.getState().current?.song.title).toBe('Keeps Playing')
  // Setup covers the tabs too: every tab leads somewhere that cannot load when
  // there is no server.
  expect(screen.queryAllByText('Library')).toHaveLength(0)
})
