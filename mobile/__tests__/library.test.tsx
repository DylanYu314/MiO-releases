import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { GestureHandlerRootView, State } from 'react-native-gesture-handler'
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils'

import { FlatList } from 'react-native'

import LibraryScreen from '../app/(tabs)/index'
import { useConnection } from '../src/api/connection'
import { resetDeviceAdds, useDeviceAdds } from '../src/api/deviceAdds'
import { resetTrackStates, useTrackStates } from '../src/api/trackStates'
import { useToast } from '../src/components/Toast'
import { usePlayer } from '../src/player/store'
import { useOnboarding } from '../src/onboarding/store'
import type { Song } from '../src/api/types'
import '../src/i18n'

// Tests live outside `app/` on purpose: expo-router turns *every* file under
// `app/` into a route via `require.context`, so a co-located test is bundled
// into the shipped app. That is not just bloat — it breaks the build outright,
// because the testing library imports Node's `console`, which Metro cannot
// resolve (`expo export` fails with "Unable to resolve module console").
//
// `render` is async in @testing-library/react-native 14 (it returns a Promise
// and populates `screen`), unlike the destructured-queries form the web
// library uses.

/**
 * The library reads **this device** now (#216), so the rows come from SQLite
 * rather than `GET /songs`. Mocked here because `expo-sqlite` is native and
 * absent under jest — and because what these tests are about is the screen.
 */
const mockLocalSongs = jest.fn()
const mockRemoveLocalSong = jest.fn()
const mockRemoveLocalSongs = jest.fn(async (_ids: readonly string[]) => ({
  removed: 0,
  fileFailures: 0,
}))

jest.mock('../src/library/songs', () => ({
  listLocalSongs: () => mockLocalSongs(),
  removeLocalSong: (...args: unknown[]) => mockRemoveLocalSong(...args),
  removeLocalSongs: (ids: readonly string[]) => mockRemoveLocalSongs(ids),
}))

/** Selection's Move opens the playlist picker, which reads playlists out of
 *  SQLite. Stubbed to a marker: what matters here is *that* it opens with the
 *  right songs, and the picker has its own suite. */
jest.mock('../src/components/PlaylistPicker', () => {
  const { Text } = require('react-native')
  return {
    PlaylistPicker: ({ songs }: { songs: { title: string }[] }) => (
      <Text>{`picker:${songs.map((entry) => entry.title).join(',')}`}</Text>
    ),
  }
})

const mockImportToDevice = jest.fn()
jest.mock('../src/library/deviceImport', () => ({
  importToDevice: (...args: unknown[]) => mockImportToDevice(...args),
}))

function song(id: number, title: string, duration: number | null = 200): Song {
  return {
    id,
    title,
    artist: `Artist ${id}`,
    album: null,
    duration,
    source_url: `https://example.com/${id}`,
    source_platform: 'youtube',
    added_at: '2026-07-25T00:00:00Z',
    loudness_lufs: null,
    peak_dbfs: null,
  }
}

/** A device row: the API shape plus this device's id and where the audio is. */
function localRows(items: Song[]) {
  return items.map((item) => ({
    ...item,
    id: `local-${item.id}`,
    server_song_id: item.id,
    file_uri: `file:///library/local-${item.id}.opus`,
    file_size: 4096,
  }))
}

/** The client the last render built, so a test can make the list refetch — the
 *  only way to simulate a row leaving the library while the screen is open. */
let lastClient: QueryClient | null = null

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      // Retries off so an error state is asserted immediately rather than after
      // three backoffs.
      queries: { retry: false, gcTime: 0 },
      /**
       * `mutations` needs saying separately, and this suite is the cautionary
       * tale (a convention in this repo).
       *
       * They are different option groups and mutations keep their own
       * five-minute default, so a queries-only setting leaves a settled
       * mutation's collection timer holding the jest worker open for exactly
       * that long. This file only ever *read* until #268 added tapping an
       * undownloaded song, and that first mutation reintroduced the hang —
       * the mobile CI job went from ~2 minutes to 6m55s.
       *
       * **The symptom is a slow green run, not a red one**, and it does not
       * reproduce under `--detectOpenHandles`. The warning prints before
       * jest's summary, so `tail` hides it: grep for "did not exit".
       */
      mutations: { gcTime: 0 },
    },
  })
  lastClient = client
  // A root view since #316: a song row carries a swipe gesture now, and
  // gesture-handler refuses to render a detector without one.
  return (
    <GestureHandlerRootView>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </GestureHandlerRootView>
  )
}

/** The seam for #239: `scrollToIndex` lives on the FlatList instance the screen
 *  holds a ref to, and jsdom has no scrolling to observe. */
const mockScrollToIndex = jest.fn()

beforeEach(() => {
  useConnection.setState({
    serverUrl: 'http://192.168.1.10:8000',
    accessKey: null,
    loaded: true,
  })
  usePlayer.setState({ current: null, isPlaying: false })
  mockScrollToIndex.mockClear()
  mockRemoveLocalSong.mockReset().mockResolvedValue(undefined)
  jest
    .spyOn(FlatList.prototype, 'scrollToIndex')
    .mockImplementation((...args) => mockScrollToIndex(...args))
})

describe('opening on the playing track (#239)', () => {
  it('scrolls to the playing song', async () => {
    mockLocalSongs.mockResolvedValue(
      localRows([song(1, 'First song'), song(2, 'Second song'), song(3, 'Third song')]),
    )
    // The device row's id is `local-3`, not the server's 3 — the screen matches
    // on what it actually renders.
    usePlayer.setState({
      current: { source: 'context', song: localRows([song(3, 'Third song')])[0] as never },
    })

    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Third song')).toBeTruthy())
    await act(async () => {})

    expect(mockScrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 2, viewPosition: 0.5 }),
    )
  })

  it('stays at the top when the playing song is not in the library view', async () => {
    mockLocalSongs.mockResolvedValue(localRows([song(1, 'First song'), song(2, 'Second song')]))
    usePlayer.setState({
      current: { source: 'context', song: localRows([song(99, 'Elsewhere')])[0] as never },
    })

    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())
    await act(async () => {})

    expect(mockScrollToIndex).not.toHaveBeenCalled()
  })

  it('does not scroll when nothing is playing', async () => {
    mockLocalSongs.mockResolvedValue(localRows([song(1, 'First song')]))

    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())
    await act(async () => {})

    expect(mockScrollToIndex).not.toHaveBeenCalled()
  })
})

describe('LibraryScreen', () => {
  it('lists the songs it loads', async () => {
    mockLocalSongs.mockResolvedValue(localRows([song(1, 'First song'), song(2, 'Second song')]))

    await render(<LibraryScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())
    expect(screen.getByText('Second song')).toBeTruthy()
    expect(screen.getByText('2 songs')).toBeTruthy()
  })

  it('says the library is empty, not that music is hidden behind a key', async () => {
    useConnection.setState({ accessKey: 'a-key' })
    mockLocalSongs.mockResolvedValue(localRows([]))

    await render(<LibraryScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('No music yet.')).toBeTruthy())
    // Adding a link is offered first: it is the one import path needing no key.
    // Two matches — the empty state and the footer — so assert presence, not one.
    expect(screen.getAllByText('Add link').length).toBeGreaterThan(0)
    // Nothing to ask for — there is already a key.
    expect(screen.queryByText('Add your invite key')).toBeNull()
  })

  it('offers ways to add music, and never mentions a key', async () => {
    /*
     * This assertion has now been rewritten twice, and both rewrites were the
     * world moving rather than the test being wrong.
     *
     * Under P12 an empty library with no key genuinely meant "your music is
     * behind a key this device has not been given". #170 made that false —
     * ownership moved to the install id — so the key became a thing that
     * unlocked search and import rather than the music itself.
     *
     * #721 makes even that false: the app ships with no server (#613), so the
     * key gates nothing a normal install can reach. Offering it in an empty
     * library sends someone hunting for a credential when what they need is to
     * add a song.
     */
    mockLocalSongs.mockResolvedValue(localRows([]))

    await render(<LibraryScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('No music yet.')).toBeTruthy())

    // The control: the ways in are still offered. Without it, an empty screen
    // would satisfy the negative assertions below.
    expect(screen.getAllByText('Add link').length).toBeGreaterThan(0)
    expect(screen.getByText('Search')).toBeTruthy()

    expect(screen.queryByText('Add your invite key')).toBeNull()
    expect(screen.queryByText(/add it to see your music/i)).toBeNull()
  })

  it('offers a retry when the device library cannot be read', async () => {
    // A database that will not open. No longer a network failure, and the
    // server address is no longer shown — it has nothing to do with it.
    mockLocalSongs.mockRejectedValue(new Error('database is locked'))

    await render(<LibraryScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText("Couldn't load your library.")).toBeTruthy())
    expect(screen.getByText('Try again')).toBeTruthy()
  })

  it('reads the device and never asks the server (#216)', async () => {
    globalThis.fetch = jest.fn() as unknown as typeof fetch
    mockLocalSongs.mockResolvedValue(localRows([song(1, 'A')]))

    await render(<LibraryScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('A')).toBeTruthy())
    // The whole point: the library is what is on this phone. My first
    // successful device import downloaded a song that the library could not
    // show, because this read still went to `GET /songs`.
    expect(mockLocalSongs).toHaveBeenCalled()
    // Favourites are still a server playlist (#219), so the server is not
    // silent — but the *song list* never comes from it again.
    const urls = (globalThis.fetch as jest.Mock).mock.calls.map(([url]) => String(url))
    expect(urls.some((url) => url.includes('/songs'))).toBe(false)
  })
})

describe('navigation (#226)', () => {
  /**
   * This used to assert an "Import" link was still on screen once the library
   * had songs — #199, which was a real bug: importing a playlist was linked only
   * from the empty state, so it vanished the moment anyone had music.
   *
   * #226 deleted the link, and every other footer link with it, because a tab
   * bar is what replaces them. The guarantee did not go anywhere — it just is
   * not the library's job any more, and `addChooser.test.tsx` holds it now.
   * What is worth asserting *here* is that the row is really gone, since leaving
   * both would give every destination two front doors that behave differently.
   */
  it('leaves navigation to the tab bar', async () => {
    mockLocalSongs.mockResolvedValue(localRows([song(1, 'First song')]))

    await render(<LibraryScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())
    expect(screen.queryByText('Import')).toBeNull()
    expect(screen.queryByText('Playlists')).toBeNull()
    expect(screen.queryByText('Settings')).toBeNull()
  })
})

describe('a song the library knows but has not downloaded (#268)', () => {
  /** What a playlist import leaves when it could not fetch a track: the row and
   *  its place in the playlist, no audio, and no server copy either. */
  function notDownloaded() {
    return {
      id: 'local-x',
      server_song_id: null,
      title: 'Missing song',
      artist: 'An Artist',
      album: null,
      duration: 200,
      source_url: 'https://youtu.be/missing',
      source_platform: 'Youtube',
      added_at: '2026-07-31T00:00:00Z',
      loudness_lufs: null,
      peak_dbfs: null,
      file_uri: null,
      file_size: null,
    }
  }

  beforeEach(() => {
    mockImportToDevice.mockReset().mockResolvedValue({ local_id: 'local-x' })
    // Module-level and shared across files: a run left here would make the
    // *next* test's rows unexpectedly untappable.
    resetTrackStates()
    resetDeviceAdds()
  })

  it('says so, rather than looking like an ordinary track', async () => {
    mockLocalSongs.mockResolvedValue([notDownloaded()])

    await render(<LibraryScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText(/Not downloaded/)).toBeTruthy())
  })

  it('fetches it when tapped, instead of playing silence', async () => {
    mockLocalSongs.mockResolvedValue([notDownloaded()])

    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Missing song')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Play Missing song'))
    })

    // There is no audio anywhere for this row, so playing it would be silence —
    // which reads as a broken app rather than a missing download.
    await waitFor(() => expect(mockImportToDevice).toHaveBeenCalledWith('https://youtu.be/missing'))
  })

  it('says downloading, and refuses a second tap, while anything is fetching it', async () => {
    /*
     * #571 — *"the tracks that is downloading always show in the
     * library… and its clickable, i afraied user click it to cause any error"*.
     *
     * It was worse than an error. The screen kept the in-flight URL in its own
     * `useState`, set only when the user tapped a row **here**, so a track
     * being fetched by a playlist import read "Not downloaded — tap to
     * download" — and tapping it started a **second concurrent download of the
     * same track**. `downloadAudioFromUrl` appends 2 MiB chunks to one path, so
     * two writers interleaving produce a file of plausible length that will not
     * play.
     *
     * A **playlist import** is the fixture on purpose: it writes
     * `useTrackStates` and never touches `useDeviceAdds`, so a fix that read
     * only the adds store would pass a test written around an add-link and
     * still ship the bug. That is #555's shape exactly.
     */
    mockLocalSongs.mockResolvedValue([notDownloaded()])
    useTrackStates
      .getState()
      .set('9', 'https://youtu.be/missing', { phase: 'downloading', attempt: 1, failure: null })

    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Missing song')).toBeTruthy())

    expect(screen.getByText(/Downloading/)).toBeTruthy()
    expect(screen.queryByText(/Not downloaded/)).toBeNull()

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Play Missing song'))
    })

    expect(mockImportToDevice).not.toHaveBeenCalled()
  })

  it('sees an add-link or search download too, not only a playlist import', async () => {
    /*
     * The other store, and the mutation that caught its absence: deleting the
     * `useDeviceAdds` branch of `useFetchingUrls` passed every test until this
     * one existed, because the pure `isFetching` covered it and nothing
     * rendering did.
     *
     * The real scenario is ordinary: paste a link on the Add tab, switch to the
     * Library while it downloads, and the row for it is right there.
     */
    mockLocalSongs.mockResolvedValue([notDownloaded()])
    useDeviceAdds.getState().started('https://youtu.be/missing', 'link')

    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Missing song')).toBeTruthy())

    expect(screen.getByText(/Downloading/)).toBeTruthy()
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Play Missing song'))
    })

    expect(mockImportToDevice).not.toHaveBeenCalled()
  })

  it('still offers the tap once that run has finished with it', async () => {
    // The half that keeps #268 working. A track a playlist import *failed* on
    // must stay tappable — tapping it is the only way to recover it.
    mockLocalSongs.mockResolvedValue([notDownloaded()])
    useTrackStates
      .getState()
      .set('9', 'https://youtu.be/missing', { phase: 'failed', attempt: 3, failure: 'refused' })

    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText(/Not downloaded/)).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Play Missing song'))
    })

    await waitFor(() => expect(mockImportToDevice).toHaveBeenCalledWith('https://youtu.be/missing'))
  })

  /**
   * The message goes when the song does (2026-08-10 device pass).
   *
   * I tapped a track a playlist import had failed on, got "This video is
   * not available", removed the track, and the red line stayed at the top of
   * my library: *"it just sticked there even if i remove the failed track"*.
   * It was cleared only when another download *started*, so on a library the
   * user was not downloading into it never cleared at all.
   */
  it('stops showing a download failure once the song is gone', async () => {
    mockImportToDevice.mockRejectedValue(new Error('This video is not available'))
    mockLocalSongs.mockResolvedValue([notDownloaded()])

    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Missing song')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Play Missing song'))
    })
    await waitFor(() => expect(screen.getByText(/This video is not available/)).toBeTruthy())

    // The row leaves the library — deleted, or swept because it had no file.
    mockLocalSongs.mockResolvedValue([])
    await act(async () => {
      await lastClient?.invalidateQueries()
    })

    await waitFor(() => expect(screen.queryByText(/This video is not available/)).toBeNull())
  })

  it('leaves a song that can stream alone', async () => {
    // A row from a server import has no file yet but the server still has a
    // copy, so it plays and nothing is wrong.
    mockLocalSongs.mockResolvedValue([{ ...notDownloaded(), server_song_id: 7 }])

    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Missing song')).toBeTruthy())

    expect(screen.queryByText(/Not downloaded/)).toBeNull()
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Play Missing song'))
    })
    expect(mockImportToDevice).not.toHaveBeenCalled()
  })
})

describe('choosing several tracks at once (#336)', () => {
  const threeSongs = () =>
    mockLocalSongs.mockResolvedValue(
      localRows([song(1, 'First song'), song(2, 'Second song'), song(3, 'Third song')]),
    )

  /** Enter selection mode through the button, which is the only way in. */
  async function startSelecting() {
    await act(async () => {
      fireEvent.press(screen.getByText('Select'))
    })
  }

  it('offers a Select button rather than claiming a gesture', async () => {
    /*
     * I asked for a button, and it is also the only option left: long-press
     * already means "open the sheet" on a song row and "start dragging" on a
     * playlist. A third meaning for one gesture is a conflict.
     */
    threeSongs()
    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())

    expect(screen.getByText('Select')).toBeTruthy()
  })

  it('ticking a row selects it instead of playing it', async () => {
    threeSongs()
    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())
    await startSelecting()

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select First song'))
    })

    expect(screen.getByText('1 selected')).toBeTruthy()
    // The whole point of the mode: a tap must not start the track.
    expect(usePlayer.getState().current).toBeNull()
  })

  it('selects and clears everything', async () => {
    threeSongs()
    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())
    await startSelecting()

    await act(async () => {
      fireEvent.press(screen.getByText('Select all'))
    })
    expect(screen.getByText('3 selected')).toBeTruthy()

    await act(async () => {
      fireEvent.press(screen.getByText('Clear'))
    })
    expect(screen.getByText('0 selected')).toBeTruthy()
  })

  it('deletes every selected track in one call, not one at a time (#569)', async () => {
    /*
     * The whole reason the feature exists: removing ten tracks was ten
     * journeys through the same sheet.
     *
     * And since #569, in **one** call. It used to loop the single-song
     * mutation, and every iteration invalidated the library query — so the
     * screen re-read SQLite and rebuilt the whole list between each song, which
     * is what was on screen when I said they were "being deleted one by
     * one".
     */
    threeSongs()
    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())
    await startSelecting()

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select First song'))
    })
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select Third song'))
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Delete'))
    })

    await waitFor(() => expect(mockRemoveLocalSongs).toHaveBeenCalledTimes(1))
    expect(mockRemoveLocalSongs.mock.calls[0][0]).toEqual(['local-1', 'local-3'])
    // The per-song path is not what a batch uses, and calling both would put
    // the refresh back where it was.
    expect(mockRemoveLocalSong).not.toHaveBeenCalled()
  })

  it('says Delete in the library, because the track really is gone', async () => {
    // A playlist says Remove. Wording them alike is how someone loses a track
    // they only meant to unfile.
    threeSongs()
    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())
    await startSelecting()

    expect(screen.getByText('Delete')).toBeTruthy()
    expect(screen.queryByText('Remove')).toBeNull()
  })

  it('hands the chosen songs to the playlist picker on Move', async () => {
    threeSongs()
    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())
    await startSelecting()

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select Second song'))
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Move'))
    })

    expect(screen.getByText('picker:Second song')).toBeTruthy()
  })

  it('leaves selection mode, restoring play on tap', async () => {
    threeSongs()
    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())
    await startSelecting()

    await act(async () => {
      fireEvent.press(screen.getByText('Done'))
    })

    // The Select button is back, and the rows are playable again.
    expect(screen.getByText('Select')).toBeTruthy()
    expect(screen.queryByText('0 selected')).toBeNull()
  })
})

/**
 * Swiping a row to queue it says so (#379, UI 7).
 *
 * the swipe "add[s] to the user queue and says nothing". The queue is a
 * screen away, so a gesture with no visible result is indistinguishable from a
 * gesture that missed — which is the same complaint as #377's missing hints,
 * one step further on.
 */
describe('queueing a song by swipe', () => {
  beforeEach(() => {
    useToast.setState({ message: null })
  })

  it('confirms it, naming the song', async () => {
    mockLocalSongs.mockResolvedValue(localRows([song(1, 'Blue')]))

    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Blue')).toBeTruthy())

    await act(async () => {
      fireGestureHandler(getByGestureTestId('swipe-local-1'), [
        { state: State.BEGAN, translationX: 0 },
        { state: State.ACTIVE, translationX: 120 },
        { state: State.END, translationX: 120 },
      ])
    })

    // Nothing is playing here, and `addToQueue` makes the first queued song
    // *current* rather than parking it in a queue nobody can hear — so this is
    // where a swipe lands on an idle player.
    expect(usePlayer.getState().current?.song.title).toBe('Blue')
    // Named, not "Added": with forty rows on screen, which one was queued is
    // the part worth saying.
    expect(useToast.getState().message).toBe('Queued \u201cBlue\u201d')
  })

  it('says nothing when the swipe did not go far enough', async () => {
    mockLocalSongs.mockResolvedValue(localRows([song(1, 'Blue')]))

    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Blue')).toBeTruthy())

    await act(async () => {
      fireGestureHandler(getByGestureTestId('swipe-local-1'), [
        { state: State.BEGAN, translationX: 0 },
        { state: State.ACTIVE, translationX: 30 },
        { state: State.END, translationX: 30 },
      ])
    })

    // Confirming something that did not happen is worse than saying nothing.
    expect(usePlayer.getState().current).toBeNull()
    expect(useToast.getState().message).toBeNull()
  })
})

/**
 * The hint that teaches this swipe (#502).
 *
 * I asked for the undiscoverable gestures to be taught, and the issue's
 * requirement is that the hint retires on **first use of the gesture**, not on
 * a button press — it exists to cause a first swipe, so a first swipe is what
 * it should cost.
 *
 * These render the real screen and fire the real gesture, because the thing
 * worth pinning is the wiring: `onSwipeEnqueue` is the only caller of
 * `enqueue`, and it is that fact which makes dismissing there mean "the user
 * swiped" rather than "the user queued a song somehow".
 */
describe('the swipe hint', () => {
  beforeEach(() => {
    // Armed: the tour is done, and the gesture has not been used.
    useOnboarding.setState({ completed: true, hydrated: true, dismissedHints: {} })
  })

  it('is shown above a library that has something to swipe', async () => {
    mockLocalSongs.mockResolvedValue(localRows([song(1, 'Blue')]))

    await render(<LibraryScreen />, { wrapper })

    await waitFor(() =>
      expect(screen.getByText('Tip: swipe a song right to add it to your queue.')).toBeTruthy(),
    )
  })

  it('is not shown on an empty library, where there is nothing to swipe', async () => {
    mockLocalSongs.mockResolvedValue(localRows([]))

    await render(<LibraryScreen />, { wrapper })

    await waitFor(() => expect(mockLocalSongs).toHaveBeenCalled())
    expect(screen.queryByText('Tip: swipe a song right to add it to your queue.')).toBeNull()
  })

  it('retires for good the first time the gesture is used', async () => {
    mockLocalSongs.mockResolvedValue(localRows([song(1, 'Blue')]))

    await render(<LibraryScreen />, { wrapper })
    await waitFor(() =>
      expect(screen.getByText('Tip: swipe a song right to add it to your queue.')).toBeTruthy(),
    )

    await act(async () => {
      fireGestureHandler(getByGestureTestId('swipe-local-1'), [
        { state: State.BEGAN, translationX: 0 },
        { state: State.ACTIVE, translationX: 120 },
        { state: State.END, translationX: 120 },
      ])
    })

    await waitFor(() =>
      expect(screen.queryByText('Tip: swipe a song right to add it to your queue.')).toBeNull(),
    )
    // Stored, not merely hidden — otherwise it returns on the next launch.
    expect(useOnboarding.getState().dismissedHints.swipeToQueue).toBe(true)
  })

  it('is left alone by a swipe that did not go far enough', async () => {
    mockLocalSongs.mockResolvedValue(localRows([song(1, 'Blue')]))

    await render(<LibraryScreen />, { wrapper })
    await waitFor(() =>
      expect(screen.getByText('Tip: swipe a song right to add it to your queue.')).toBeTruthy(),
    )

    await act(async () => {
      fireGestureHandler(getByGestureTestId('swipe-local-1'), [
        { state: State.BEGAN, translationX: 0 },
        { state: State.ACTIVE, translationX: 30 },
        { state: State.END, translationX: 30 },
      ])
    })

    // A gesture that did not commit taught nothing, so the hint stays.
    expect(useOnboarding.getState().dismissedHints.swipeToQueue).toBeUndefined()
    expect(screen.getByText('Tip: swipe a song right to add it to your queue.')).toBeTruthy()
  })
})
