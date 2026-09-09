import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Page, Playlist } from '../api/types'
import { renderWithProviders } from '../test/renderWithProviders'
import { PlaylistsPage } from './PlaylistsPage'

function makePlaylist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: 1,
    name: 'Road Trip',
    kind: 'user',
    item_count: 3,
    created_at: '2026-07-22T12:00:00Z',
    updated_at: '2026-07-22T12:00:00Z',
    ...overrides,
  }
}

function page(items: Playlist[]): Page<Playlist> {
  return { items, total: items.length, limit: 200, offset: 0 }
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(jsonResponse(page([makePlaylist()])))
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('PlaylistsPage', () => {
  it('lists playlists with their track counts', async () => {
    renderWithProviders(<PlaylistsPage />)

    expect(await screen.findByText('Road Trip')).toBeInTheDocument()
    expect(screen.getByText('3 songs')).toBeInTheDocument()
  })

  it('shows an empty state when there are none', async () => {
    fetchMock.mockResolvedValue(jsonResponse(page([])))

    renderWithProviders(<PlaylistsPage />)

    expect(await screen.findByText(/no playlists yet/i)).toBeInTheDocument()
  })

  it('creates a playlist from the form', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PlaylistsPage />)
    await screen.findByText('Road Trip')

    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(jsonResponse(makePlaylist({ id: 2, name: 'Focus' }), 201))
    fetchMock.mockResolvedValue(jsonResponse(page([makePlaylist(), makePlaylist({ id: 2 })])))

    await user.type(screen.getByLabelText('New playlist name'), 'Focus')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(JSON.parse(posts[0][1].body)).toEqual({ name: 'Focus' })
    })
  })

  it('disables create for a blank name', async () => {
    renderWithProviders(<PlaylistsPage />)
    await screen.findByText('Road Trip')

    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })
})
