import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useJob } from './jobs'
import type { Job } from './types'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    source_url: 'https://example.com/watch?v=abc',
    status: 'queued',
    progress: null,
    song_id: null,
    error: null,
    error_code: null,
    created_at: '2026-07-22T12:00:00Z',
    updated_at: '2026-07-22T12:00:00Z',
    ...overrides,
  }
}

/** Minimal stand-in for the browser WebSocket, so tests can drive it directly. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { wasClean: boolean }) => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  close() {
    this.closed = true
  }

  emit(job: Job) {
    this.onmessage?.({ data: JSON.stringify(job) })
  }

  static get last() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  }
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

const fetchMock = vi.fn()

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => makeJob() } as Response)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('useJob', () => {
  it('opens a socket for the job', async () => {
    renderHook(() => useJob(1), { wrapper })

    await waitFor(() => expect(FakeWebSocket.last).toBeDefined())
    expect(FakeWebSocket.last.url).toContain('/api/jobs/1/ws')
  })

  it('does not open a socket when there is no job yet', () => {
    renderHook(() => useJob(null), { wrapper })

    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('applies pushed updates without refetching', async () => {
    const { result } = renderHook(() => useJob(1), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    fetchMock.mockClear()

    FakeWebSocket.last.emit(makeJob({ status: 'converting' }))

    await waitFor(() => expect(result.current.data?.status).toBe('converting'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores a malformed frame instead of breaking', async () => {
    const { result } = renderHook(() => useJob(1), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())

    FakeWebSocket.last.onmessage?.({ data: 'not json' })
    FakeWebSocket.last.emit(makeJob({ status: 'tagging' }))

    await waitFor(() => expect(result.current.data?.status).toBe('tagging'))
  })

  it('falls back to polling when the socket fails', async () => {
    const { result } = renderHook(() => useJob(1), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    fetchMock.mockClear()

    // Socket dies without ever delivering a message.
    FakeWebSocket.last.onclose?.({ wasClean: false })

    // Progress must keep working, which means falling back to refetching.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 3000 })
  })

  it('does not treat the server closing a finished job as a failure', async () => {
    const { result } = renderHook(() => useJob(1), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())

    FakeWebSocket.last.emit(makeJob({ status: 'done' }))
    FakeWebSocket.last.onclose?.({ wasClean: true })
    fetchMock.mockClear()

    // A clean close after a completed job should not start polling.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('closes the socket when the job id changes', async () => {
    const { rerender } = renderHook(({ id }) => useJob(id), {
      wrapper,
      initialProps: { id: 1 },
    })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const first = FakeWebSocket.last

    rerender({ id: 2 })

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    expect(first.closed).toBe(true)
    expect(FakeWebSocket.last.url).toContain('/api/jobs/2/ws')
  })
})
