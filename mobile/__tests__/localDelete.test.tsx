import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { Alert } from 'react-native'

import LibraryScreen from '../app/(tabs)/index'
import { useConnection } from '../src/api/connection'
import '../src/i18n'

/**
 * Deleting a song removes it from **this device** (#220).
 *
 * The library is the device since #216, so `DELETE /songs/{id}` would leave the
 * song on the phone — playable — while the app insisted it was gone.
 *
 * Two of these exist because mutation testing found both gaps: nothing covered
 * the cache invalidation, and nothing covered delete being offered for a song
 * with no server row. The first is the same omission that made a successful
 * import look like a failure, so it is worth a test of its own rather than an
 * assumption that the pattern is obvious by now.
 */

const mockRemoveLocalSong = jest.fn()
const mockLocalSongs = jest.fn()

jest.mock('../src/library/songs', () => ({
  listLocalSongs: () => mockLocalSongs(),
  removeLocalSong: (...args: unknown[]) => mockRemoveLocalSong(...args),
}))

jest.mock('expo-router', () => ({
  // The guard reads the current path to know a navigation landed (#375).
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

/** A song this device fetched itself: local string id, no server row. */
function deviceSong() {
  return {
    id: 'local-abc',
    server_song_id: null,
    title: 'Flower of Japan',
    artist: 'A Channel',
    album: null,
    duration: 214,
    source_url: 'https://www.youtube.com/watch?v=DruvTra8swY',
    source_platform: 'Youtube',
    added_at: '2026-07-31T00:00:00Z',
    loudness_lufs: -14.3,
    peak_dbfs: null,
    file_uri: 'file:///library/local-abc.opus',
    file_size: 4096,
  }
}

let client: QueryClient
function wrapper({ children }: { children: ReactNode }) {
  // A root view since #316: a song row carries a swipe gesture now, and
  // gesture-handler refuses to render a detector without one rather than
  // silently never recognising it.
  return (
    <GestureHandlerRootView>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </GestureHandlerRootView>
  )
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  })
  mockRemoveLocalSong.mockReset().mockResolvedValue(undefined)
  mockLocalSongs.mockReset().mockResolvedValue([deviceSong()])
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ song_ids: [] }),
  }) as unknown as typeof fetch
  useConnection.setState({
    serverUrl: 'https://mio.test/api',
    accessKey: null,
    usingDefaultServer: true,
    loaded: true,
  })
})

async function confirmDelete() {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})

  await render(<LibraryScreen />, { wrapper })
  await waitFor(() => expect(screen.getByText('Flower of Japan')).toBeTruthy())

  await act(async () => {
    fireEvent(screen.getByLabelText('Play Flower of Japan'), 'longPress')
  })
  await act(async () => {})
  await act(async () => {
    fireEvent.press(screen.getByText('Delete'))
  })

  const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[]
  await act(async () => {
    buttons.find((button) => button.text === 'Delete')?.onPress?.()
  })

  alert.mockRestore()
}

describe('deleting a song the device fetched itself (#220)', () => {
  it('is offered at all, which it was not while delete was a server call', async () => {
    // This song has no `server_song_id`. While delete meant `DELETE /songs/{id}`
    // the option was hidden for it, leaving no way to remove it from the phone.
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})

    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Flower of Japan')).toBeTruthy())
    await act(async () => {
      fireEvent(screen.getByLabelText('Play Flower of Japan'), 'longPress')
    })
    await act(async () => {})

    expect(screen.getByText('Delete')).toBeTruthy()
    alert.mockRestore()
  })

  it('removes it by its local id, and never asks the server', async () => {
    await confirmDelete()

    await waitFor(() => expect(mockRemoveLocalSong).toHaveBeenCalledWith('local-abc'))
    const urls = (globalThis.fetch as jest.Mock).mock.calls.map(([url]) => String(url))
    expect(urls.some((url) => url.includes('/songs/'))).toBe(false)
  })

  it('refreshes the library, without which the song stays on screen', async () => {
    const invalidate = jest.spyOn(client, 'invalidateQueries')

    await confirmDelete()

    // The same omission that made a successful import look like a failure
    // (#216): the list reads the device, so it shows the old rows until it is
    // told to look again.
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['local-library'] }))
  })
})

describe('every song can be added to a playlist (#219)', () => {
  it('offers it for a song the device fetched itself', async () => {
    // Hidden while playlists were a server thing, and left hidden by mistake
    // when #219 made them local — so a device-imported song had no way into
    // any playlist. I found it by long-pressing a track.
    await render(<LibraryScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Flower of Japan')).toBeTruthy())

    await act(async () => {
      fireEvent(screen.getByLabelText('Play Flower of Japan'), 'longPress')
    })
    await act(async () => {})

    expect(screen.getByText('Add to playlist...')).toBeTruthy()
  })
})
