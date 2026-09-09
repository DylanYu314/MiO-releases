import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Song } from '../api/types'
import { usePlayerStore } from '../player/store'
import { QueuePanel } from './QueuePanel'

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

const songs = [makeSong(1), makeSong(2), makeSong(3)]

beforeEach(() => {
  usePlayerStore.setState({
    context: null,
    contextQueue: [],
    contextOrder: [],
    contextIndex: -1,
    userQueue: [],
    current: null,
    isPlaying: false,
    shuffle: false,
    repeat: 'off',
    restartNonce: 0,
  })
})

function section(name: RegExp) {
  return screen.getByRole('heading', { name }).closest('section') as HTMLElement
}

describe('QueuePanel', () => {
  it('renders nothing while closed', () => {
    usePlayerStore.getState().playFromContext(songs, 0, { kind: 'library' })

    render(<QueuePanel open={false} onClose={vi.fn()} />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the two tiers separately', () => {
    usePlayerStore
      .getState()
      .playFromContext(songs, 0, { kind: 'playlist', id: 5, name: 'Road Trip' })
    usePlayerStore.getState().addToQueue(makeSong(99))

    render(<QueuePanel open onClose={vi.fn()} />)

    // Now playing.
    expect(within(section(/now playing/i)).getByText('Song 1')).toBeInTheDocument()
    // The manual queue holds only what was queued by hand...
    expect(within(section(/next in queue/i)).getByText('Song 99')).toBeInTheDocument()
    // ...and the context section names its source and lists what's left.
    const context = section(/next from: Road Trip/i)
    expect(within(context).getByText('Song 2')).toBeInTheDocument()
    expect(within(context).getByText('Song 3')).toBeInTheDocument()
    expect(within(context).queryByText('Song 99')).not.toBeInTheDocument()
  })

  it('removes a hand-queued track without touching the context', async () => {
    const user = userEvent.setup()
    usePlayerStore.getState().playFromContext(songs, 0, { kind: 'library' })
    usePlayerStore.getState().addToQueue(makeSong(99))
    render(<QueuePanel open onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Remove Song 99 from the queue' }))

    expect(usePlayerStore.getState().userQueue).toEqual([])
    expect(usePlayerStore.getState().contextOrder).toHaveLength(3)
  })

  it('removes an upcoming context track by its real position in the order', async () => {
    const user = userEvent.setup()
    usePlayerStore.getState().playFromContext(songs, 0, { kind: 'library' })
    render(<QueuePanel open onClose={vi.fn()} />)

    // Song 3 is second in the up-next list but position 2 in the playback order.
    await user.click(screen.getByRole('button', { name: 'Remove Song 3 from the queue' }))

    expect(usePlayerStore.getState().contextOrder).toEqual([0, 1])
    expect(usePlayerStore.getState().current?.song.id).toBe(1)
  })

  it('clears the manual queue only', async () => {
    const user = userEvent.setup()
    usePlayerStore.getState().playFromContext(songs, 0, { kind: 'library' })
    usePlayerStore.getState().addToQueue(makeSong(99))
    render(<QueuePanel open onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Clear' }))

    expect(usePlayerStore.getState().userQueue).toEqual([])
    expect(usePlayerStore.getState().current?.song.id).toBe(1)
    expect(usePlayerStore.getState().contextOrder).toHaveLength(3)
  })

  it('gives every row a keyboard-reachable drag handle', () => {
    usePlayerStore.getState().playFromContext(songs, 0, { kind: 'library' })
    render(<QueuePanel open onClose={vi.fn()} />)

    // dnd-kit drives reordering from the handle, so it must be focusable —
    // a decorative grip would leave drag as pointer-only.
    const handle = screen.getByRole('button', { name: 'Reorder Song 2' })
    expect(handle.tagName).toBe('BUTTON')
    expect(handle).toHaveAttribute('tabindex', '0')
  })

  it('closes on Escape and on the close button', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<QueuePanel open onClose={onClose} />)

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Close the play queue' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('says so when there is nothing queued', () => {
    render(<QueuePanel open onClose={vi.fn()} />)

    expect(screen.getByText(/nothing is playing/i)).toBeInTheDocument()
    expect(screen.getByText(/nothing queued by hand/i)).toBeInTheDocument()
  })
})
