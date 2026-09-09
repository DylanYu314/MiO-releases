import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PlaylistDetail, Song } from '../api/types'
import { usePlayerStore } from '../player/store'
import { renderWithProviders } from '../test/renderWithProviders'
import { FavouritesPage } from './FavouritesPage'

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

function makeFavourites(songIds: number[]): PlaylistDetail {
  return {
    id: 9,
    name: 'Favourites',
    kind: 'favourites',
    created_at: '2026-07-22T12:00:00Z',
    updated_at: '2026-07-22T12:00:00Z',
    items: songIds.map((songId, index) => ({
      id: 100 + index,
      position: index,
      song: makeSong(songId),
    })),
  }
}

const fetchMock = vi.fn()

function respondWith(favourites: PlaylistDetail) {
  fetchMock.mockImplementation(async (url: string) => {
    const body = String(url).includes('song-ids')
      ? { song_ids: favourites.items.map((item) => item.song.id) }
      : favourites
    return { ok: true, status: 200, json: async () => body } as Response
  })
}

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
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('FavouritesPage', () => {
  it('lists the hearted songs', async () => {
    respondWith(makeFavourites([1, 2]))

    renderWithProviders(<FavouritesPage />)

    expect(await screen.findByText('Song 1')).toBeInTheDocument()
    expect(screen.getByText('Song 2')).toBeInTheDocument()
  })

  it('explains itself when empty', async () => {
    respondWith(makeFavourites([]))

    renderWithProviders(<FavouritesPage />)

    expect(await screen.findByText(/no favourites yet/i)).toBeInTheDocument()
  })

  it('plays as a named context, so the queue panel can label it', async () => {
    const user = userEvent.setup()
    respondWith(makeFavourites([1, 2]))
    renderWithProviders(<FavouritesPage />)
    await screen.findByText('Song 1')

    await user.click(screen.getByRole('button', { name: 'Play all' }))

    const state = usePlayerStore.getState()
    expect(state.contextQueue.map((song) => song.id)).toEqual([1, 2])
    expect(state.context?.name).toBe('Favourites')
  })

  it('shows rows already hearted, since every row here is a favourite', async () => {
    respondWith(makeFavourites([1]))

    renderWithProviders(<FavouritesPage />)

    expect(
      await screen.findByRole('button', { name: 'Remove Song 1 from favourites' }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('un-hearting a row calls the favourites endpoint, not a playlist delete', async () => {
    const user = userEvent.setup()
    respondWith(makeFavourites([1]))
    renderWithProviders(<FavouritesPage />)
    // Wait for the heart itself, not just the row — the favourite ids arrive
    // on a separate query and the label depends on them.
    const heart = await screen.findByRole('button', { name: 'Remove Song 1 from favourites' })
    fetchMock.mockClear()

    await user.click(heart)

    await waitFor(() => {
      const deletes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
      expect(deletes).toHaveLength(1)
      expect(String(deletes[0][0])).toContain('/playlists/favourites/items/1')
    })
  })
})
