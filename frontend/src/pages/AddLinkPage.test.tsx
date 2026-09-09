import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Job } from '../api/types'
import { renderWithProviders } from '../test/renderWithProviders'
import { AddLinkPage } from './AddLinkPage'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 7,
    source_url: 'https://youtu.be/abc',
    status: 'downloading',
    progress: null,
    song_id: null,
    error: null,
    error_code: null,
    created_at: '2026-07-24T12:00:00Z',
    updated_at: '2026-07-24T12:00:00Z',
    ...overrides,
  }
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

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('AddLinkPage', () => {
  it('shows progress for a job id already in the URL (survives reload)', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(makeJob({ id: 5, status: 'done' })))

    renderWithProviders(<AddLinkPage />, { route: '/add?job=5' })

    expect(await screen.findByText('Added to your library')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/5', expect.anything())
  })

  it('puts the created job id in the URL and starts tracking it', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse(makeJob({ id: 7 }), 202)
      return jsonResponse(makeJob({ id: 7 }))
    })

    renderWithProviders(<AddLinkPage />, { route: '/add' })

    await userEvent.type(screen.getByLabelText('Link to import'), 'https://youtu.be/abc')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    // The progress panel only renders once useJob(7) resolves, which only
    // happens if the created id made it into the ?job= param.
    await waitFor(() => expect(screen.getByText('Downloading...')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/7', expect.anything())
  })

  it('ignores a non-numeric job param', () => {
    renderWithProviders(<AddLinkPage />, { route: '/add?job=nope' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
