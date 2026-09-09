import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PlaylistDetail, Song } from '../api/types'
import { usePlayerStore } from '../player/store'
import { renderWithProviders } from '../test/renderWithProviders'
import { PlaylistDetailPage } from './PlaylistDetailPage'

function makeSong(id: number): Song {
  return {
    id,
    title: `Song ${id}`,
    artist: `Artist ${id}`,
    album: null,
    duration: 100,
    source_url: `https://example.com/${id}`,
    source_platform: 'Youtube',
    added_at: '2026-07-22T12:00:00Z',
  }
}

function makeDetail(): PlaylistDetail {
  return {
    id: 5,
    name: 'Road Trip',
    kind: 'user',
    created_at: '2026-07-22T12:00:00Z',
    updated_at: '2026-07-22T12:00:00Z',
    items: [
      { id: 10, position: 0, song: makeSong(1) },
      { id: 11, position: 1, song: makeSong(2) },
      { id: 12, position: 2, song: makeSong(3) },
    ],
  }
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response
}

const fetchMock = vi.fn()

beforeEach(() => {
  usePlayerStore.setState({
    contextQueue: [],
    contextOrder: [],
    contextIndex: -1,
    userQueue: [],
    current: null,
    isPlaying: false,
  })
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(jsonResponse(makeDetail()))
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('PlaylistDetailPage', () => {
  it('renders the songs in order', async () => {
    renderWithProviders(<PlaylistDetailPage />, { route: '/playlists/5', path: '/playlists/:id' })

    expect(await screen.findByText('Song 1')).toBeInTheDocument()
    expect(screen.getByText('Song 2')).toBeInTheDocument()
    expect(screen.getByText('Song 3')).toBeInTheDocument()
  })

  it('plays the whole playlist from the start on Play all', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PlaylistDetailPage />, { route: '/playlists/5', path: '/playlists/:id' })
    await screen.findByText('Song 1')

    await user.click(screen.getByRole('button', { name: 'Play all' }))

    const state = usePlayerStore.getState()
    expect(state.contextQueue.map((song) => song.id)).toEqual([1, 2, 3])
    expect(state.isPlaying).toBe(true)
  })

  it('plays from the clicked track', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PlaylistDetailPage />, { route: '/playlists/5', path: '/playlists/:id' })
    await screen.findByText('Song 2')

    await user.click(screen.getByRole('button', { name: 'Play Song 2' }))

    expect(usePlayerStore.getState().current?.song.id).toBe(2)
  })

  it('sends the reordered ids when moving a track down', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PlaylistDetailPage />, { route: '/playlists/5', path: '/playlists/:id' })
    await screen.findByText('Song 1')
    fetchMock.mockClear()

    await user.click(screen.getByRole('button', { name: 'Move Song 1 down' }))

    await waitFor(() => {
      const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')
      expect(puts).toHaveLength(1)
      // Song 1 (item 10) swaps with Song 2 (item 11).
      expect(JSON.parse(puts[0][1].body)).toEqual({ item_ids: [11, 10, 12] })
    })
  })

  it('disables moving the first track up and the last down', async () => {
    renderWithProviders(<PlaylistDetailPage />, { route: '/playlists/5', path: '/playlists/:id' })
    await screen.findByText('Song 1')

    expect(screen.getByRole('button', { name: 'Move Song 1 up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move Song 3 down' })).toBeDisabled()
  })

  it('removes a track', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PlaylistDetailPage />, { route: '/playlists/5', path: '/playlists/:id' })
    await screen.findByText('Song 2')
    fetchMock.mockClear()

    await user.click(screen.getByRole('button', { name: 'Remove Song 2 from playlist' }))

    await waitFor(() => {
      const deletes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
      expect(deletes).toHaveLength(1)
      expect(String(deletes[0][0])).toContain('/playlists/5/items/11')
    })
  })

  // A song in a playlist is still a song: the same actions the library offers
  // have to be there too, and mean the same things.
  it('queues a track from inside the playlist', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PlaylistDetailPage />, { route: '/playlists/5', path: '/playlists/:id' })
    await screen.findByText('Song 2')

    // Something has to be playing for "queue" to mean "play after this" — with
    // nothing playing the track just becomes the current one.
    await user.click(screen.getByRole('button', { name: 'Play Song 1' }))
    await user.click(screen.getByRole('button', { name: 'Add Song 2 to queue' }))

    expect(usePlayerStore.getState().userQueue.map((song) => song.id)).toEqual([2])
    expect(usePlayerStore.getState().current?.song.id).toBe(1)
  })

  it('offers add-to-playlist on every track', async () => {
    renderWithProviders(<PlaylistDetailPage />, { route: '/playlists/5', path: '/playlists/:id' })
    await screen.findByText('Song 1')

    expect(screen.getByRole('button', { name: 'Add Song 1 to a playlist' })).toBeInTheDocument()
  })

  it('deletes a track from the library, distinct from removing it here', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PlaylistDetailPage />, { route: '/playlists/5', path: '/playlists/:id' })
    await screen.findByText('Song 2')
    fetchMock.mockClear()

    await user.click(screen.getByRole('button', { name: 'Delete Song 2' }))
    // Deleting is destructive, so it goes through the confirm dialog first.
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    )

    await waitFor(() => {
      const deletes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
      expect(deletes).toHaveLength(1)
      // /songs/2, not /playlists/5/items/11 — a different action entirely.
      expect(String(deletes[0][0])).toContain('/songs/2')
    })
  })

  it('renames the playlist', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PlaylistDetailPage />, { route: '/playlists/5', path: '/playlists/:id' })
    await screen.findByText('Road Trip')
    fetchMock.mockClear()

    await user.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByLabelText('Playlist name')
    await user.clear(input)
    await user.type(input, 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')
      expect(patches).toHaveLength(1)
      expect(JSON.parse(patches[0][1].body)).toEqual({ name: 'Renamed' })
    })
  })
})
