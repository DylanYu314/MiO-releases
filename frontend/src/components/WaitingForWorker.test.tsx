import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WaitingForWorker } from './WaitingForWorker'

const NOW = new Date('2026-07-23T18:00:00Z')

function secondsAgo(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('WaitingForWorker', () => {
  it('stays quiet while queueing is still normal', () => {
    render(<WaitingForWorker since={secondsAgo(3)} />)

    expect(screen.queryByText(/waiting for a worker/i)).not.toBeInTheDocument()
  })

  it('speaks up once work has sat in the queue too long', () => {
    render(<WaitingForWorker since={secondsAgo(60)} />)

    expect(screen.getByText(/waiting for a worker/i)).toBeInTheDocument()
    expect(screen.getByText(/worker process is running/i)).toBeInTheDocument()
  })

  it('appears without a reload once the wait gets long', async () => {
    render(<WaitingForWorker since={secondsAgo(10)} />)
    expect(screen.queryByText(/waiting for a worker/i)).not.toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(10_000)

    expect(screen.getByText(/waiting for a worker/i)).toBeInTheDocument()
  })
})
