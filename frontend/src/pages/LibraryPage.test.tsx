import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Page, Song } from '../api/types'
import { renderWithProviders } from '../test/renderWithProviders'
import { LibraryPage } from './LibraryPage'

function makeSong(overrides: Partial<Song> = {}): Song {
  return {
    id: 1,
    title: 'Me at the zoo',
    artist: 'jawed',
    album: null,
    duration: 19,
    source_url: 'https://example.com/watch?v=abc',
    source_platform: 'Youtube',
    added_at: '2026-07-22T12:00:00Z',
    ...overrides,
  }
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

function songPage(items: Song[]): Page<Song> {
  return { items, total: items.length, limit: 20, offset: 0 }
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(jsonResponse(songPage([makeSong()])))
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('LibraryPage', () => {
  it('renders songs returned by the API', async () => {
    renderWithProviders(<LibraryPage />)

    expect(await screen.findByText('Me at the zoo')).toBeInTheDocument()
    expect(screen.getByText('jawed')).toBeInTheDocument()
    expect(screen.getByText('0:19')).toBeInTheDocument()
  })

  it('shows an empty state when the library has no songs', async () => {
    fetchMock.mockResolvedValue(jsonResponse(songPage([])))

    renderWithProviders(<LibraryPage />)

    expect(await screen.findByText(/your library is empty/i)).toBeInTheDocument()
  })

  it('shows an error when the request fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ detail: 'Something broke' }),
    } as Response)

    renderWithProviders(<LibraryPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Something broke')
  })

  it('sends the typed text as a search query, debounced', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LibraryPage />)
    await screen.findByText('Me at the zoo')
    fetchMock.mockClear()

    await user.type(screen.getByLabelText('Search songs'), 'zoo')

    await waitFor(
      () => {
        const urls = fetchMock.mock.calls.map(([url]) => String(url))
        expect(urls.some((url) => url.includes('q=zoo'))).toBe(true)
      },
      { timeout: 2000 },
    )
    // Debounced: three keystrokes must not produce three separate requests.
    expect(fetchMock.mock.calls.length).toBeLessThan(3)
  })

  it('requests the chosen sort order', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LibraryPage />)
    await screen.findByText('Me at the zoo')
    fetchMock.mockClear()

    await user.selectOptions(screen.getByLabelText('Sort songs'), 'title:asc')

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([url]) => String(url))
      expect(urls.some((url) => url.includes('sort=title') && url.includes('order=asc'))).toBe(true)
    })
  })
})
