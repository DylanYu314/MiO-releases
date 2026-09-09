import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'

import { PlaylistPicker } from '../src/components/PlaylistPicker'
import type { PlayableSong } from '../src/api/types'
import '../src/i18n'

/**
 * Choosing which playlist a song goes into, and knowing where it already is
 * (#231).
 *
 * The membership half is the new part. Before it, the picker only knew what
 * *this session* had added — so a song added last week looked addable, and the
 * duplicate was discovered afterwards.
 */

const mockListPlaylists = jest.fn()
const mockPlaylistIdsForSong = jest.fn()
jest.mock('../src/library/playlists', () => ({
  listPlaylists: () => mockListPlaylists(),
  playlistIdsForSong: (...args: unknown[]) => mockPlaylistIdsForSong(...args),
  addSongsToPlaylist: jest.fn(async () => 0),
  createPlaylist: jest.fn(async () => 'new'),
  favouriteSongIds: jest.fn(async () => []),
  favouritesPlaylist: jest.fn(async () => ({ id: 'fav', kind: 'favourites' })),
  listPlaylistItems: jest.fn(async () => []),
  setFavourite: jest.fn(async () => {}),
  deletePlaylist: jest.fn(async () => {}),
  removePlaylistItems: jest.fn(async () => {}),
  renamePlaylist: jest.fn(async () => {}),
  reorderPlaylist: jest.fn(async () => {}),
  removeSongFromAllPlaylists: jest.fn(async () => {}),
}))

const SONG: PlayableSong = {
  id: 'local-1',
  title: 'Flower of Japan',
  artist: 'The Testers',
  album: null,
  duration: 200,
  source_url: 'https://youtube.com/watch?v=1',
  source_platform: 'Youtube',
  added_at: '2026-08-01T00:00:00Z',
  loudness_lufs: null,
  peak_dbfs: null,
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPlaylistIdsForSong.mockResolvedValue([])
  mockListPlaylists.mockResolvedValue([
    { id: 'p1', name: 'Road Trip', kind: 'user', item_count: 3 },
    { id: 'p2', name: 'Focus', kind: 'user', item_count: 1 },
  ])
})

describe('PlaylistPicker', () => {
  it('lists the playlists a song can go into', async () => {
    await render(<PlaylistPicker songs={[SONG]} onClose={jest.fn()} />, { wrapper })

    await waitFor(() => expect(screen.getByText('Road Trip')).toBeTruthy())
    expect(screen.getByText('Focus')).toBeTruthy()
  })

  it('marks a playlist the song is already in (#231)', async () => {
    mockPlaylistIdsForSong.mockResolvedValue(['p1'])

    await render(<PlaylistPicker songs={[SONG]} onClose={jest.fn()} />, { wrapper })

    await waitFor(() => expect(screen.getByText('Added')).toBeTruthy())
    // The other row still offers itself, with its count.
    expect(screen.getByText('1 song')).toBeTruthy()
  })

  it('asks about this song, not some other', async () => {
    await render(<PlaylistPicker songs={[SONG]} onClose={jest.fn()} />, { wrapper })

    await waitFor(() => expect(mockPlaylistIdsForSong).toHaveBeenCalledWith('local-1'))
  })

  it('leaves favourites out, because it has its own screen and its own button', async () => {
    mockListPlaylists.mockResolvedValue([
      { id: 'fav', name: 'Favourites', kind: 'favourites', item_count: 9 },
      { id: 'p1', name: 'Road Trip', kind: 'user', item_count: 3 },
    ])

    await render(<PlaylistPicker songs={[SONG]} onClose={jest.fn()} />, { wrapper })

    await waitFor(() => expect(screen.getByText('Road Trip')).toBeTruthy())
    expect(screen.queryByText('Favourites')).toBeNull()
  })
})
