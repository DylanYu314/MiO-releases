import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Page, TrackMatch } from '../api/types'
import { renderWithProviders } from '../test/renderWithProviders'
import { MatchReviewTable } from './MatchReviewTable'

function makeMatch(overrides: Partial<TrackMatch> = {}): TrackMatch {
  return {
    id: 1,
    position: 0,
    external_id: 't1',
    title: 'Alpha',
    artist: 'Artist',
    album: null,
    duration_s: 200,
    candidates: [
      {
        url: 'https://y/1',
        title: 'Candidate video',
        uploader: 'Artist',
        duration: 200,
        score: 0.9,
      },
    ],
    chosen_url: 'https://y/1',
    confidence: 0.9,
    status: 'needs_review',
    import_job_id: null,
    song_id: null,
    error: null,
    ...overrides,
  }
}

function pageOf(items: TrackMatch[]): Page<TrackMatch> {
  return { items, total: items.length, limit: 50, offset: 0 }
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

const matches = [
  makeMatch({ id: 1, position: 0, title: 'Alpha' }),
  makeMatch({ id: 2, position: 1, title: 'Beta' }),
]

describe('MatchReviewTable bulk actions', () => {
  it('has no bulk bar until a row is selected', async () => {
    fetchMock.mockResolvedValue(jsonResponse(pageOf(matches)))

    renderWithProviders(<MatchReviewTable importId={1} interactive />)

    await screen.findByText('Alpha')
    expect(screen.queryByRole('button', { name: 'Accept selected' })).not.toBeInTheDocument()
  })

  it('accepts the selected rows in a single bulk request', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return jsonResponse([{ ...matches[0], status: 'accepted' }])
      return jsonResponse(pageOf(matches))
    })

    renderWithProviders(<MatchReviewTable importId={1} interactive />)

    await screen.findByText('Alpha')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Alpha' }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Accept selected' }))

    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')
      expect(patches).toHaveLength(1)
      expect(patches[0][0]).toBe('/api/playlist-imports/1/matches')
      expect(JSON.parse(patches[0][1].body)).toEqual({ match_ids: [1], status: 'accepted' })
    })
  })

  it('select-all selects every visible row', async () => {
    fetchMock.mockResolvedValue(jsonResponse(pageOf(matches)))

    renderWithProviders(<MatchReviewTable importId={1} interactive />)

    await screen.findByText('Alpha')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))

    expect(screen.getByText('2 selected')).toBeInTheDocument()
  })
})
