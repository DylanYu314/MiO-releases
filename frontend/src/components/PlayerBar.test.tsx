import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Song } from '../api/types'
import { usePlayerStore } from '../player/store'
import { PlayerBar } from './PlayerBar'

function makeSong(id: number, overrides: Partial<Song> = {}): Song {
  return {
    id,
    title: `Song ${id}`,
    artist: `Artist ${id}`,
    album: null,
    duration: 125,
    source_url: `https://example.com/${id}`,
    source_platform: 'Youtube',
    added_at: '2026-07-22T12:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  usePlayerStore.setState({
    contextQueue: [],
    contextOrder: [],
    contextIndex: -1,
    userQueue: [],
    current: null,
    isPlaying: false,
    shuffle: false,
    repeat: 'off',
    volume: 1,
    muted: false,
    restartNonce: 0,
    // These three are set by tests further down and are not part of the
    // persisted-queue reset above, so without them a sleep timer (or a changed
    // speed) leaks into every test that follows it.
    playbackRate: 1,
    sleepAt: null,
    sleepAfterTrack: false,
  })
})

describe('PlayerBar', () => {
  it('renders nothing visible until something is queued', () => {
    render(<PlayerBar />)

    expect(screen.queryByLabelText('Play')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Pause')).not.toBeInTheDocument()
  })

  it('keeps the same <audio> element when the first song starts', () => {
    // The Web Audio graph (ADR-012) binds this element permanently: one
    // element, one context, forever. Rendering it bare while idle and nested
    // once playing made React unmount and recreate it at exactly this moment,
    // which was harmless before the graph and would silently kill audio now.
    const { container } = render(<PlayerBar />)
    const before = container.querySelector('audio')
    expect(before).not.toBeNull()

    act(() => {
      usePlayerStore.getState().playFromContext([makeSong(1)])
    })

    expect(container.querySelector('audio')).toBe(before)
  })

  it('shows the current track', () => {
    usePlayerStore.getState().playFromContext([makeSong(1)])

    render(<PlayerBar />)

    expect(screen.getByText('Song 1')).toBeInTheDocument()
    expect(screen.getByText('Artist 1')).toBeInTheDocument()
  })

  it('toggles playback from the button', async () => {
    const user = userEvent.setup()
    usePlayerStore.getState().playFromContext([makeSong(1)])
    render(<PlayerBar />)

    await user.click(screen.getByLabelText('Pause'))

    expect(usePlayerStore.getState().isPlaying).toBe(false)
    await user.click(screen.getByLabelText('Play'))
    expect(usePlayerStore.getState().isPlaying).toBe(true)
  })

  it('moves between tracks', async () => {
    const user = userEvent.setup()
    usePlayerStore.getState().playFromContext([makeSong(1), makeSong(2)])
    render(<PlayerBar />)

    await user.click(screen.getByLabelText('Next track'))
    expect(usePlayerStore.getState().current?.song.id).toBe(2)

    await user.click(screen.getByLabelText('Previous track'))
    expect(usePlayerStore.getState().current?.song.id).toBe(1)
  })

  it('disables next on the last track when not repeating', () => {
    usePlayerStore.getState().playFromContext([makeSong(1)])

    render(<PlayerBar />)

    expect(screen.getByLabelText('Next track')).toBeDisabled()
  })

  it('exposes shuffle state to assistive tech', async () => {
    const user = userEvent.setup()
    usePlayerStore.getState().playFromContext([makeSong(1), makeSong(2)])
    render(<PlayerBar />)

    const shuffle = screen.getByLabelText('Shuffle')
    expect(shuffle).toHaveAttribute('aria-pressed', 'false')

    await user.click(shuffle)

    expect(screen.getByLabelText('Shuffle')).toHaveAttribute('aria-pressed', 'true')
  })

  it('cycles the repeat mode', async () => {
    const user = userEvent.setup()
    usePlayerStore.getState().playFromContext([makeSong(1)])
    render(<PlayerBar />)

    await user.click(screen.getByLabelText('Repeat: off'))

    expect(screen.getByLabelText('Repeat: all')).toBeInTheDocument()
  })

  it('mutes and unmutes', async () => {
    const user = userEvent.setup()
    usePlayerStore.getState().playFromContext([makeSong(1)])
    render(<PlayerBar />)

    await user.click(screen.getByLabelText('Mute'))

    expect(usePlayerStore.getState().muted).toBe(true)
    expect(screen.getByLabelText('Unmute')).toBeInTheDocument()
  })

  it('falls back to the stored duration before the audio loads', () => {
    usePlayerStore.getState().playFromContext([makeSong(1, { duration: 125 })])

    render(<PlayerBar />)

    // 125s formatted, shown as the seek bar's total.
    expect(screen.getByText('2:05')).toBeInTheDocument()
  })

  // The owner's report: an accent-tinted icon alone doesn't read as "on".
  it('shows shuffle as pressed, visually and to assistive tech', async () => {
    const user = userEvent.setup()
    usePlayerStore.getState().playFromContext([makeSong(1)])
    render(<PlayerBar />)

    const shuffle = screen.getByLabelText('Shuffle')
    expect(shuffle).toHaveAttribute('aria-pressed', 'false')
    const idleClass = shuffle.className

    await user.click(shuffle)

    expect(shuffle).toHaveAttribute('aria-pressed', 'true')
    // Not merely a different text colour — a filled, ringed control.
    expect(shuffle.className).not.toBe(idleClass)
    expect(shuffle.className).toMatch(/bg-accent-100/)
    expect(shuffle.className).toMatch(/ring-/)
  })

  it('shows repeat as pressed for both repeat modes, and not when off', async () => {
    const user = userEvent.setup()
    usePlayerStore.getState().playFromContext([makeSong(1)])
    render(<PlayerBar />)

    const repeat = screen.getByLabelText('Repeat: off')
    expect(repeat).toHaveAttribute('aria-pressed', 'false')
    expect(repeat.className).not.toMatch(/bg-accent-100/)

    await user.click(repeat)
    const all = screen.getByLabelText('Repeat: all')
    expect(all).toHaveAttribute('aria-pressed', 'true')
    expect(all.className).toMatch(/bg-accent-100/)

    await user.click(all)
    const one = screen.getByLabelText('Repeat: one')
    expect(one).toHaveAttribute('aria-pressed', 'true')
    expect(one.className).toMatch(/bg-accent-100/)

    await user.click(one)
    expect(screen.getByLabelText('Repeat: off')).toHaveAttribute('aria-pressed', 'false')
  })

  it('changes the playback speed', async () => {
    const user = userEvent.setup()
    usePlayerStore.getState().playFromContext([makeSong(1)])
    render(<PlayerBar />)

    await user.selectOptions(screen.getByLabelText('Playback speed'), '1.5')

    expect(usePlayerStore.getState().playbackRate).toBe(1.5)
  })

  it('offers 15-second skips in both directions', () => {
    usePlayerStore.getState().playFromContext([makeSong(1)])
    render(<PlayerBar />)

    expect(screen.getByLabelText('Back 15 seconds')).toBeInTheDocument()
    expect(screen.getByLabelText('Forward 15 seconds')).toBeInTheDocument()
  })

  it('sets a sleep timer from the menu', async () => {
    const user = userEvent.setup()
    usePlayerStore.getState().playFromContext([makeSong(1)])
    render(<PlayerBar />)

    await user.click(screen.getByLabelText('Sleep timer'))
    await user.click(screen.getByRole('menuitem', { name: '30 minutes' }))

    expect(usePlayerStore.getState().sleepAt).not.toBeNull()
    // Once running, the control names its stop time and reports itself as on.
    expect(screen.getByLabelText(/sleep timer: stops at/i)).toHaveAttribute('aria-pressed', 'true')
  })

  it('labels the sleep timer in words, not just an icon', () => {
    // The control was on screen but unfindable: a bare moon among ten other
    // monochrome glyphs. It has to read as a control.
    usePlayerStore.getState().playFromContext([makeSong(1)])
    render(<PlayerBar />)

    expect(screen.getByLabelText('Sleep timer')).toHaveTextContent('Sleep')
  })

  it('shows the stop time on the control once a timer is running', async () => {
    const user = userEvent.setup()
    usePlayerStore.getState().playFromContext([makeSong(1)])
    render(<PlayerBar />)

    await user.click(screen.getByLabelText('Sleep timer'))
    await user.click(screen.getByRole('menuitem', { name: '30 minutes' }))

    // A time like "11:30" — the state is legible without hovering for a tooltip.
    expect(screen.getByLabelText(/sleep timer: stops at/i)).toHaveTextContent(/\d{1,2}:\d{2}/)
  })

  it('says "track end" rather than a clock time when stopping after this track', async () => {
    const user = userEvent.setup()
    usePlayerStore.getState().playFromContext([makeSong(1)])
    render(<PlayerBar />)

    await user.click(screen.getByLabelText('Sleep timer'))
    await user.click(screen.getByRole('menuitem', { name: 'End of track' }))

    expect(screen.getByLabelText(/end of this track/i)).toHaveTextContent('Track end')
  })
})
