import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import type { ReactNode } from 'react'

import { MiniPlayer } from '../src/components/MiniPlayer'
import { resetPlaybackStatus, usePlaybackStatus } from '../src/player/playbackStatus'
import { usePlayer } from '../src/player/store'
import type { Song } from '../src/api/types'
import '../src/i18n'

/**
 * The now-playing banner (#226's split, reshaped by #230).
 *
 * Two things are under test, and they are different halves of the app:
 *
 * - **the split**: `PlayerHost` owns the audio and renders nothing, this owns
 *   the bar and touches no audio. They agree only through `usePlaybackStatus`,
 *   so a bar wired to nothing would still render — just frozen at 0:00 forever.
 * - **the reshape**: the banner is a *summary that opens the panel* now, not the
 *   player. Previous and next moved to the panel, where they have room.
 */

const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  // The guard reads the current path to know a navigation landed (#375).
  usePathname: () => '/',
  useRouter: () => ({ push: mockPush }),
}))

const mockFavouriteIds = jest.fn()
const mockSetFavourite = jest.fn()
jest.mock('../src/api/localPlaylists', () => ({
  useLocalFavouriteIds: () => mockFavouriteIds(),
  useSetLocalFavourite: () => ({ mutate: mockSetFavourite }),
}))

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

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(async () => {
  jest.clearAllMocks()
  mockFavouriteIds.mockReturnValue({ data: new Set<string>() })
  // Both stores are module-level, so a value written by one test outlives it.
  resetPlaybackStatus()
  // A guard rather than a fix for anything observed: `usePlayer` is
  // `persist`-wrapped over AsyncStorage (#183), and rehydration *replaces* the
  // state it lands on.
  await usePlayer.persist.rehydrate()
  usePlayer.getState().stop()
})

/** Start playback after the mount, which is the order the real app uses. */
async function play(songs: Song[] = [SONG]) {
  await act(async () => {
    usePlayer.getState().playFromContext(songs, 0, { kind: 'library' })
  })
}

describe('MiniPlayer', () => {
  it('renders nothing when there is nothing playing', async () => {
    await render(<MiniPlayer />, { wrapper })
    expect(screen.queryByLabelText('Open the player')).toBeNull()
  })

  it('names the track and offers pausing', async () => {
    await render(<MiniPlayer />, { wrapper })
    await play()

    expect(screen.getByText('Keeps Playing')).toBeTruthy()
    expect(screen.getByText('The Testers')).toBeTruthy()
    // Playing, so the button offers the opposite action.
    expect(screen.getByLabelText('Pause')).toBeTruthy()
  })

  it('opens the playing panel when tapped (#230)', async () => {
    await render(<MiniPlayer />, { wrapper })
    await play()

    fireEvent.press(screen.getByLabelText('Open the player'))

    expect(mockPush).toHaveBeenCalledWith('/playing')
  })

  it('no longer carries previous and next, which moved to the panel', async () => {
    await render(<MiniPlayer />, { wrapper })
    await play()

    // A strip this size with five controls is a strip with five mis-taps. They
    // did not disappear — `playing.tsx` has them, with room to be pressed.
    expect(screen.queryByLabelText('Previous track')).toBeNull()
    expect(screen.queryByLabelText('Next track')).toBeNull()
  })

  it('hearts what is playing without opening the panel', async () => {
    await render(<MiniPlayer />, { wrapper })
    await play()

    fireEvent.press(screen.getByLabelText('Add Keeps Playing to favourites'))

    expect(mockSetFavourite).toHaveBeenCalledWith({ songId: '7', favourite: true })
    // Nested inside the row's own Pressable, so this proves the inner responder
    // wins — otherwise hearting would also open the panel.
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('shows the heart filled for a song already hearted', async () => {
    mockFavouriteIds.mockReturnValue({ data: new Set(['7']) })

    await render(<MiniPlayer />, { wrapper })
    await play()

    expect(screen.getByLabelText('Remove Keeps Playing from favourites')).toBeTruthy()
  })

  /**
   * The test that would have caught a bar wired to nothing.
   *
   * Progress reaches the bar only through `usePlaybackStatus`, so this drives
   * that store the way `PlayerHost` does. The timecode itself moved to the panel
   * with #230 — it is unreadable at this size — so what is asserted is the
   * progress *line*, which is what the banner still says.
   */
  it('follows the progress published by the audio half', async () => {
    await render(<MiniPlayer />, { wrapper })
    await play()

    await act(async () => {
      usePlaybackStatus.getState().setStatus({
        position: 90,
        duration: 180,
        isBuffering: false,
        error: null,
      })
    })

    // The style is an array — the base rule plus the computed width — so the
    // assertion looks for the width among its members rather than as the whole.
    expect(screen.getByTestId('banner-progress').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: '50%' })]),
    )
  })

  it('says so when a track will not play, rather than looking stalled', async () => {
    await render(<MiniPlayer />, { wrapper })
    await play()

    await act(async () => {
      usePlaybackStatus.getState().setStatus({
        position: 0,
        duration: 0,
        isBuffering: false,
        error: 'boom',
      })
    })

    expect(screen.getByText("Couldn't play this track.")).toBeTruthy()
  })
})
