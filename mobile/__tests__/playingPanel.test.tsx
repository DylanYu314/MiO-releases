import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import PlayingScreen from '../app/playing'
import { resetPlaybackStatus, usePlaybackStatus } from '../src/player/playbackStatus'
import { usePlayer } from '../src/player/store'
import type { Song } from '../src/api/types'
import '../src/i18n'

/**
 * The full-screen playing panel (#231) and its options sheet (#232).
 *
 * The panel is where everything the banner gave up now lives (#230), so these
 * tests are the other half of `miniPlayer.test.tsx`: that one proves the
 * controls *left*, this proves they arrived.
 *
 * It touches no audio. Position comes from `usePlaybackStatus` and scrubbing
 * writes a `seekRequest` back — a request the host applies — which is what keeps
 * this screen testable without a native module.
 */

const mockPush = jest.fn()
const mockBack = jest.fn()
jest.mock('expo-router', () => ({
  // The guard reads the current path to know a navigation landed (#375).
  usePathname: () => '/',
  useRouter: () => ({ push: mockPush, back: mockBack }),
}))

const mockFavouriteIds = jest.fn()
const mockSetFavourite = jest.fn()
jest.mock('../src/api/localPlaylists', () => ({
  useLocalFavouriteIds: () => mockFavouriteIds(),
  useSetLocalFavourite: () => ({ mutate: mockSetFavourite }),
  // `PlaylistPicker` reaches for these when the options sheet opens it.
  useLocalPlaylists: () => ({ data: [], isPending: false, isError: false, refetch: jest.fn() }),
  useAddToLocalPlaylist: () => ({ mutateAsync: jest.fn() }),
  useCreateLocalPlaylist: () => ({ mutateAsync: jest.fn(), isPending: false }),
}))

function song(id: number, title: string): Song {
  return {
    id,
    title,
    artist: `Artist ${id}`,
    album: null,
    duration: 180,
    source_url: `https://example.com/${id}`,
    source_platform: 'youtube',
    added_at: '2026-08-01T00:00:00Z',
    loudness_lufs: null,
    peak_dbfs: null,
  }
}

/**
 * The panel needs a `GestureHandlerRootView` above it since #302.
 *
 * The scrubber is a `GestureDetector` now, and gesture-handler refuses to
 * render one without a root view rather than silently never recognising the
 * gesture. The app has one in `app/_layout.tsx`, which every route sits inside;
 * this is that, for a screen rendered on its own.
 */
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  })
  return (
    <GestureHandlerRootView>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </GestureHandlerRootView>
  )
}

beforeEach(async () => {
  jest.clearAllMocks()
  mockFavouriteIds.mockReturnValue({ data: new Set<string>() })
  resetPlaybackStatus()
  await usePlayer.persist.rehydrate()
  usePlayer.getState().stop()
})

/**
 * Press, and let the store settle before the test ends.
 *
 * `usePlayer` is `persist`-wrapped over AsyncStorage, so a press that changes it
 * schedules a write which resolves *after* the test finishes — a React update
 * outside `act`, which then breaks the **next** test's act scope rather than
 * this one. The symptom is a suite where every test after the first press fails
 * to find anything, and each passes alone.
 *
 * `await act` flushes those microtasks while the scope is still open.
 */
async function press(label: string) {
  await act(async () => {
    fireEvent.press(screen.getByLabelText(label))
  })
}

async function pressText(text: string | RegExp) {
  await act(async () => {
    fireEvent.press(screen.getByText(text))
  })
}

async function play(songs: Song[] = [song(1, 'First'), song(2, 'Second')]) {
  await act(async () => {
    usePlayer.getState().playFromContext(songs, 0, { kind: 'playlist', name: 'Road Trip' })
  })
}

describe('when nothing is playing', () => {
  it('says so rather than showing a player with dead controls', async () => {
    await render(<PlayingScreen />, { wrapper })

    // A real state: the queue can end while the panel is open.
    expect(screen.getByText('Nothing is playing.')).toBeTruthy()
    expect(screen.queryByLabelText('Pause')).toBeNull()
  })
})

describe('the playing panel (#231)', () => {
  it('names the track and where the queue came from', async () => {
    await render(<PlayingScreen />, { wrapper })
    await play()

    expect(screen.getByText('First')).toBeTruthy()
    expect(screen.getByText('Artist 1')).toBeTruthy()
    // "Playing from" is the thing a queue panel can answer and a banner cannot.
    expect(screen.getByText('Road Trip')).toBeTruthy()
  })

  it('falls back to the library when the queue has no name', async () => {
    await render(<PlayingScreen />, { wrapper })
    await act(async () => {
      usePlayer.getState().playFromContext([song(1, 'First')], 0, { kind: 'library' })
    })

    expect(screen.getByText('Your library')).toBeTruthy()
  })

  it('carries the transport the banner gave up', async () => {
    await render(<PlayingScreen />, { wrapper })
    await play()

    await press('Next track')
    expect(usePlayer.getState().current?.song.id).toBe(2)

    await press('Previous track')
    expect(usePlayer.getState().current?.song.id).toBe(1)
  })

  it('toggles shuffle and cycles repeat', async () => {
    await render(<PlayingScreen />, { wrapper })
    await play()

    await press('Shuffle')
    expect(usePlayer.getState().shuffle).toBe(true)

    await press('Repeat: off')
    expect(usePlayer.getState().repeat).toBe('all')
  })

  /**
   * What the repeat button shows, per mode (#326).
   *
   * The digit `1` went away because `Repeat1` draws it inside the mark, so
   * showing both said the same thing twice. The `∞` stayed, because nothing
   * else distinguishes *all* from *off* — the note this replaced was right that
   * colour alone is not a state anyone can read, and the web client leaving
   * that to colour is not a reason to copy it.
   */
  /** Lucide's digit path — the one stroke that tells `repeat-one` from
   *  `repeat`. Asserting on it is how this test knows the panel picked the
   *  right *icon*, not merely the right text beside it. */
  const REPEAT_ONE_DIGIT = 'M11 10h1v4'

  function renderedPaths(tree: unknown, found: string[] = []): string[] {
    if (!tree || typeof tree !== 'object') return found
    const node = tree as { props?: Record<string, unknown>; children?: unknown[] }
    if (typeof node.props?.d === 'string') found.push(node.props.d)
    for (const child of node.children ?? []) renderedPaths(child, found)
    return found
  }

  it.each([
    ['one', true],
    ['all', false],
    ['off', false],
  ] as const)('draws the repeat-one mark for repeat-%s: %s', async (mode, expected) => {
    const view = await render(<PlayingScreen />, { wrapper })
    await play()
    await act(async () => {
      usePlayer.setState({ repeat: mode })
    })

    expect(renderedPaths(view.toJSON()).includes(REPEAT_ONE_DIGIT)).toBe(expected)
  })

  it.each([
    ['all', true],
    ['one', false],
    ['off', false],
  ] as const)('shows the infinity mark for repeat-%s: %s', async (mode, shown) => {
    /*
     * The mode is set rather than cycled into. `repeat` survives `stop()` and
     * is restored by `persist.rehydrate()` in `beforeEach`, so it carries over
     * from whichever test ran before — cycling from "off" only works if the
     * previous test happened to leave it there.
     */
    await render(<PlayingScreen />, { wrapper })
    await play()
    await act(async () => {
      usePlayer.setState({ repeat: mode })
    })

    expect(screen.queryByText('∞') !== null).toBe(shown)
    // Never the digit: `repeat-one` draws it inside the mark, so showing both
    // said the same thing twice.
    expect(screen.queryByText('1')).toBeNull()
  })

  it('pauses and resumes', async () => {
    await render(<PlayingScreen />, { wrapper })
    await play()
    expect(usePlayer.getState().isPlaying).toBe(true)

    await press('Pause')

    expect(usePlayer.getState().isPlaying).toBe(false)
  })

  it('skips forward and back by fifteen seconds, without leaving the track', async () => {
    await render(<PlayingScreen />, { wrapper })
    await play()
    await act(async () => {
      usePlaybackStatus
        .getState()
        .setStatus({ position: 100, duration: 180, isBuffering: false, error: null })
    })

    await press('Back 15 seconds')
    expect(usePlayer.getState().seekRequest?.seconds).toBe(85)

    await press('Forward 15 seconds')
    expect(usePlayer.getState().seekRequest?.seconds).toBe(115)
  })

  it('clamps a forward skip to the end of the track', async () => {
    await render(<PlayingScreen />, { wrapper })
    await play()
    await act(async () => {
      usePlaybackStatus
        .getState()
        .setStatus({ position: 175, duration: 180, isBuffering: false, error: null })
    })

    await press('Forward 15 seconds')

    // Seeking past the end is undefined on the native player, and "skip
    // forward" must never quietly mean "next track".
    expect(usePlayer.getState().seekRequest?.seconds).toBe(180)
  })

  it('hearts what is playing', async () => {
    await render(<PlayingScreen />, { wrapper })
    await play()

    await press('Add First to favourites')

    expect(mockSetFavourite).toHaveBeenCalledWith({ songId: '1', favourite: true })
  })

  it('closes back to wherever it was opened from', async () => {
    await render(<PlayingScreen />, { wrapper })
    await play()

    await press('Done')

    expect(mockBack).toHaveBeenCalled()
  })

  it('opens the queue', async () => {
    await render(<PlayingScreen />, { wrapper })
    await play()

    await pressText('Open queue')

    expect(mockPush).toHaveBeenCalledWith('/queue')
  })
})

describe('the playing options sheet (#232)', () => {
  it('opens from the 3-dot', async () => {
    await render(<PlayingScreen />, { wrapper })
    await play()

    await press('More')

    expect(screen.getByText('Queue')).toBeTruthy()
    expect(screen.getByText('Add to playlist...')).toBeTruthy()
  })

  it('sets the playback speed', async () => {
    await render(<PlayingScreen />, { wrapper })
    await play()
    await press('More')

    // Speed is a choice, so it opens its own sheet rather than growing this one
    // into a settings page.
    await pressText(/Playback speed/)
    await pressText('1.5×')

    expect(usePlayer.getState().playbackRate).toBe(1.5)
  })

  it('sets a sleep timer', async () => {
    await render(<PlayingScreen />, { wrapper })
    await play()
    await press('More')

    await pressText(/Sleep timer/)
    await pressText('End of track')

    expect(usePlayer.getState().sleepAfterTrack).toBe(true)
  })

  it('queues what is playing', async () => {
    await render(<PlayingScreen />, { wrapper })
    await play()
    await press('More')

    await pressText('Queue')

    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([1])
  })
})
