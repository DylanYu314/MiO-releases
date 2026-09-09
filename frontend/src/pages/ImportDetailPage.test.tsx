import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Page, PlaylistImport, TrackMatch } from '../api/types'
import { renderWithProviders } from '../test/renderWithProviders'
import { ImportDetailPage } from './ImportDetailPage'

function makeImport(overrides: Partial<PlaylistImport> = {}): PlaylistImport {
  return {
    id: 1,
    service: 'spotify',
    account_id: 1,
    external_playlist_id: 'pl-1',
    name: 'Road Trip',
    status: 'matching',
    track_count: 40,
    matched_count: 12,
    import_total: null,
    imported_count: 0,
    failed_count: 0,
    playlist_id: null,
    error: null,
    created_at: '2026-07-23T12:00:00Z',
    updated_at: '2026-07-23T12:00:00Z',
    ...overrides,
  }
}

function makeMatch(overrides: Partial<TrackMatch> = {}): TrackMatch {
  return {
    id: 1,
    position: 0,
    external_id: 't1',
    title: 'Never Gonna Give You Up',
    artist: 'Rick Astley',
    album: null,
    duration_s: 213,
    candidates: [
      {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Rick Astley - Never Gonna Give You Up',
        uploader: 'Rick Astley',
        duration: 212,
        score: 0.93,
      },
    ],
    chosen_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    confidence: 0.93,
    status: 'auto_matched',
    import_job_id: null,
    song_id: null,
    error: null,
    ...overrides,
  }
}

function pageOf<T>(items: T[]): Page<T> {
  return { items, total: items.length, limit: 50, offset: 0 }
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response
}

/** The page opens a progress socket; jsdom has no WebSocket, so stub one. */
class FakeWebSocket {
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { wasClean: boolean }) => void) | null = null
  close() {}
}

const fetchMock = vi.fn()

function routeFetch(
  detail: PlaylistImport,
  matches: Page<TrackMatch> = pageOf([]),
  counts: Partial<Record<string, number>> = {},
) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST')
      return jsonResponse({ ...detail, status: 'importing', import_total: 2 }, 202)
    if (init?.method === 'PATCH') return jsonResponse(matches.items[0] ?? makeMatch())
    if (url.includes('/matches')) {
      // limit=1 queries are the importable-count probes, keyed by status.
      if (url.includes('limit=1')) {
        const status = new URLSearchParams(url.split('?')[1]).get('status') ?? ''
        return jsonResponse({ items: [], total: counts[status] ?? 0, limit: 1, offset: 0 })
      }
      return jsonResponse(matches)
    }
    if (url.startsWith('/api/playlist-imports/')) return jsonResponse(detail)
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

function patchCalls() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')
}

function renderPage() {
  return renderWithProviders(<ImportDetailPage />, { route: '/import/1', path: '/import/:id' })
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('ImportDetailPage', () => {
  it('shows numeric matching progress', async () => {
    routeFetch(makeImport({ status: 'matching', matched_count: 12, track_count: 40 }))

    renderPage()

    expect(await screen.findByText('Finding tracks on YouTube')).toBeInTheDocument()
    expect(screen.getByText('12 of 40')).toBeInTheDocument()
  })

  it('shows the review table once matching finishes', async () => {
    routeFetch(makeImport({ status: 'review' }), pageOf([makeMatch()]))

    renderPage()

    expect(await screen.findByText('Never Gonna Give You Up')).toBeInTheDocument()
    expect(screen.getByText('93%')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /listen/i })).toHaveAttribute(
      'href',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    )
    expect(screen.getByRole('tab', { name: 'Needs review' })).toBeInTheDocument()
  })

  it('explains rows with no usable candidate', async () => {
    routeFetch(
      makeImport({ status: 'review' }),
      pageOf([
        makeMatch({
          status: 'no_match',
          chosen_url: null,
          confidence: null,
          candidates: [],
          error: 'search blocked',
        }),
      ]),
    )

    renderPage()

    expect(await screen.findByText(/no candidate found — search blocked/i)).toBeInTheDocument()
  })

  it('shows the failure state with the stored error', async () => {
    routeFetch(makeImport({ status: 'failed', error: 'Premium may have lapsed' }))

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Import failed: Premium may have lapsed',
    )
  })

  it('links to the created playlist when done', async () => {
    routeFetch(
      makeImport({ status: 'done', imported_count: 11, failed_count: 1, playlist_id: 5 }),
      pageOf([makeMatch({ status: 'imported' })]),
    )

    renderPage()

    expect(await screen.findByText(/11 imported, 1 failed/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the playlist' })).toHaveAttribute(
      'href',
      '/playlists/5',
    )
  })

  it('shows the importable count and confirms the import', async () => {
    const user = userEvent.setup()
    routeFetch(makeImport({ status: 'review' }), pageOf([makeMatch()]), {
      auto_matched: 2,
      accepted: 1,
    })

    renderPage()

    expect(await screen.findByText('3 tracks ready to import.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm & download' }))

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(posts[0][0]).toBe('/api/playlist-imports/1/confirm')
    })
    // The 202 body flips the cached import to `importing`.
    expect(await screen.findByText('Downloading confirmed tracks')).toBeInTheDocument()
  })

  it('disables confirm when nothing is importable', async () => {
    routeFetch(makeImport({ status: 'review' }), pageOf([makeMatch({ status: 'rejected' })]))

    renderPage()

    expect(await screen.findByText('0 tracks ready to import.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm & download' })).toBeDisabled()
  })

  it('accepts and rejects matches from the review table', async () => {
    const user = userEvent.setup()
    routeFetch(makeImport({ status: 'review' }), pageOf([makeMatch({ status: 'needs_review' })]))

    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Accept' }))

    await waitFor(() => {
      expect(patchCalls()).toHaveLength(1)
      expect(patchCalls()[0][0]).toBe('/api/playlist-imports/1/matches/1')
      expect(JSON.parse(patchCalls()[0][1].body)).toEqual({ status: 'accepted' })
    })

    await user.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => {
      expect(JSON.parse(patchCalls()[1][1].body)).toEqual({ status: 'rejected' })
    })
  })

  it('switches the chosen URL to another candidate', async () => {
    const user = userEvent.setup()
    const match = makeMatch({
      status: 'needs_review',
      candidates: [
        {
          url: 'https://www.youtube.com/watch?v=first',
          title: 'First Candidate',
          uploader: 'A',
          duration: 213,
          score: 0.7,
        },
        {
          url: 'https://www.youtube.com/watch?v=second',
          title: 'Second Candidate',
          uploader: 'B',
          duration: 214,
          score: 0.6,
        },
      ],
      chosen_url: 'https://www.youtube.com/watch?v=first',
    })
    routeFetch(makeImport({ status: 'review' }), pageOf([match]))

    renderPage()
    await user.click(await screen.findByRole('button', { name: /change/i }))
    await user.click(screen.getByRole('menuitem', { name: /second candidate/i }))

    await waitFor(() => {
      expect(JSON.parse(patchCalls()[0][1].body)).toEqual({
        chosen_url: 'https://www.youtube.com/watch?v=second',
      })
    })
  })

  it('sends a custom URL from the change menu', async () => {
    const user = userEvent.setup()
    routeFetch(makeImport({ status: 'review' }), pageOf([makeMatch({ status: 'needs_review' })]))

    renderPage()
    await user.click(await screen.findByRole('button', { name: /change/i }))
    await user.click(screen.getByRole('menuitem', { name: 'Custom URL…' }))
    await user.type(screen.getByLabelText('Custom URL'), 'https://example.com/video')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(JSON.parse(patchCalls()[0][1].body)).toEqual({
        chosen_url: 'https://example.com/video',
      })
    })
  })

  it('offers no review controls while downloads run', async () => {
    routeFetch(
      makeImport({ status: 'importing', imported_count: 1, import_total: 2 }),
      pageOf([makeMatch({ status: 'imported' })]),
    )

    renderPage()

    expect(await screen.findByText('Downloading confirmed tracks')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  })

  it('offers a retry for failed tracks on a finished import', async () => {
    const user = userEvent.setup()
    routeFetch(
      makeImport({ status: 'done', imported_count: 119, failed_count: 11, playlist_id: 5 }),
      pageOf([makeMatch({ status: 'failed', error: 'HTTP Error 403: Forbidden' })]),
    )

    renderPage()

    expect(await screen.findByText(/11 tracks failed to download/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry failed' }))

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(posts[0][0]).toBe('/api/playlist-imports/1/retry-failed')
    })
  })

  it('retries a single failed row', async () => {
    const user = userEvent.setup()
    routeFetch(
      makeImport({ status: 'done', imported_count: 1, failed_count: 1, playlist_id: 5 }),
      pageOf([makeMatch({ id: 42, status: 'failed', error: 'HTTP Error 403: Forbidden' })]),
    )

    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Retry download' }))

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(posts[0][0]).toBe('/api/playlist-imports/1/matches/42/retry')
    })
  })

  it('shows the failure reason next to a failed row', async () => {
    routeFetch(
      makeImport({ status: 'done', failed_count: 1, playlist_id: 5 }),
      pageOf([makeMatch({ status: 'failed', error: 'HTTP Error 403: Forbidden' })]),
    )

    renderPage()

    expect(await screen.findByText('HTTP Error 403: Forbidden')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Failed' })).toBeInTheDocument()
  })

  it('offers no retry when nothing failed', async () => {
    routeFetch(
      makeImport({ status: 'done', imported_count: 12, failed_count: 0, playlist_id: 5 }),
      pageOf([makeMatch({ status: 'imported' })]),
    )

    renderPage()

    await screen.findByText(/12 imported/)
    expect(screen.queryByRole('button', { name: 'Retry failed' })).not.toBeInTheDocument()
  })
})
