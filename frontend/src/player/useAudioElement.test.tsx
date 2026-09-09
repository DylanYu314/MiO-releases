import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Song } from '../api/types'
import { selectCurrentSong, usePlayerStore } from './store'
import { useAudioElement } from './useAudioElement'

/**
 * A characterization suite: it pins what `useAudioElement` does to the real
 * <audio> element *today*, before the Web Audio graph (G1/ADR-012) re-plumbs
 * playback through an A/B element pair and an AudioContext.
 *
 * The point is that these tests were written against the single-element
 * implementation and must keep passing, unedited, once the graph lands. Any
 * assertion that has to change is, by definition, an audible change and needs
 * justifying rather than absorbing. So: assert on observable element state, not
 * on how the hook arrives at it.
 */

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

/** Stands in for PlayerBar: binds the hook to an element and surfaces what it
 *  reports back, so the tests never reach into the hook's internals. */
function Harness() {
  const { audioRef, currentTime, duration, seek } = useAudioElement()
  return (
    <>
      <audio ref={audioRef} data-testid="audio" hidden />
      <span data-testid="current-time">{currentTime}</span>
      <span data-testid="duration">{duration}</span>
      <button type="button" onClick={() => seek(42)}>
        seek
      </button>
    </>
  )
}

function audioEl() {
  return screen.getByTestId('audio') as HTMLAudioElement
}

/** jsdom resolves `src` against the document's base URL, so compare paths. */
function srcPath(audio: HTMLAudioElement) {
  return audio.src ? new URL(audio.src).pathname : null
}

const play = () => vi.mocked(window.HTMLMediaElement.prototype.play)
const pause = () => vi.mocked(window.HTMLMediaElement.prototype.pause)
const load = () => vi.mocked(window.HTMLMediaElement.prototype.load)

beforeEach(() => {
  vi.clearAllMocks()
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
    volume: 1,
    muted: false,
    playbackRate: 1,
    sleepAt: null,
    sleepAfterTrack: false,
    restartNonce: 0,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAudioElement — source loading', () => {
  it('leaves the element unloaded while nothing is playing', () => {
    render(<Harness />)
    expect(audioEl().getAttribute('src')).toBeNull()
    expect(load()).not.toHaveBeenCalled()
  })

  it('points the element at the current song and loads it', () => {
    usePlayerStore.setState({ current: { source: 'context', song: makeSong(7) } })
    render(<Harness />)

    expect(srcPath(audioEl())).toBe('/api/songs/7/audio')
    expect(load()).toHaveBeenCalled()
  })

  it('swaps the source when the song changes', () => {
    usePlayerStore.setState({ current: { source: 'context', song: makeSong(1) } })
    render(<Harness />)
    expect(srcPath(audioEl())).toBe('/api/songs/1/audio')

    act(() => {
      usePlayerStore.setState({ current: { source: 'context', song: makeSong(2) } })
    })
    expect(srcPath(audioEl())).toBe('/api/songs/2/audio')
    expect(load()).toHaveBeenCalledTimes(2)
  })
})

describe('useAudioElement — play and pause', () => {
  it('plays when the store says playing', () => {
    usePlayerStore.setState({ current: { source: 'context', song: makeSong(1) }, isPlaying: true })
    render(<Harness />)
    expect(play()).toHaveBeenCalled()
  })

  it('pauses when the store says paused', () => {
    usePlayerStore.setState({ current: { source: 'context', song: makeSong(1) }, isPlaying: true })
    render(<Harness />)

    act(() => usePlayerStore.setState({ isPlaying: false }))
    expect(pause()).toHaveBeenCalled()
  })

  it('reflects a refused autoplay back into the store instead of lying', async () => {
    play().mockRejectedValueOnce(new Error('NotAllowedError'))
    usePlayerStore.setState({ current: { source: 'context', song: makeSong(1) } })
    render(<Harness />)

    await act(async () => {
      usePlayerStore.setState({ isPlaying: true })
    })
    expect(usePlayerStore.getState().isPlaying).toBe(false)
  })
})

describe('useAudioElement — volume, mute and rate', () => {
  it('mirrors volume and mute onto the element', () => {
    usePlayerStore.setState({
      current: { source: 'context', song: makeSong(1) },
      volume: 0.4,
      muted: false,
    })
    render(<Harness />)
    expect(audioEl().volume).toBeCloseTo(0.4)
    expect(audioEl().muted).toBe(false)

    act(() => usePlayerStore.setState({ volume: 0.9, muted: true }))
    expect(audioEl().volume).toBeCloseTo(0.9)
    expect(audioEl().muted).toBe(true)
  })

  it('applies volume as a plain multiplier, not squared', () => {
    // Guards the gain-staging trap the Web Audio graph introduces: if volume is
    // applied both on the element and on a graph GainNode, 0.5 becomes 0.25.
    usePlayerStore.setState({ current: { source: 'context', song: makeSong(1) }, volume: 0.5 })
    render(<Harness />)
    expect(audioEl().volume).toBeCloseTo(0.5, 5)
  })

  it('mirrors the playback rate and keeps pitch corrected', () => {
    usePlayerStore.setState({
      current: { source: 'context', song: makeSong(1) },
      playbackRate: 1.5,
    })
    render(<Harness />)
    expect(audioEl().playbackRate).toBe(1.5)
    expect(audioEl().preservesPitch).toBe(true)

    act(() => usePlayerStore.setState({ playbackRate: 0.75 }))
    expect(audioEl().playbackRate).toBe(0.75)
    expect(audioEl().preservesPitch).toBe(true)
  })
})

describe('useAudioElement — position', () => {
  it('seeks the element and reports the new position immediately', async () => {
    const user = userEvent.setup()
    usePlayerStore.setState({ current: { source: 'context', song: makeSong(1) } })
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'seek' }))
    expect(audioEl().currentTime).toBe(42)
    expect(screen.getByTestId('current-time')).toHaveTextContent('42')
  })

  it('follows the element as it plays', () => {
    usePlayerStore.setState({ current: { source: 'context', song: makeSong(1) } })
    render(<Harness />)

    act(() => {
      audioEl().currentTime = 12
      audioEl().dispatchEvent(new Event('timeupdate'))
    })
    expect(screen.getByTestId('current-time')).toHaveTextContent('12')
  })

  it('takes the duration from the element once metadata arrives', () => {
    usePlayerStore.setState({ current: { source: 'context', song: makeSong(1) } })
    render(<Harness />)

    act(() => {
      Object.defineProperty(audioEl(), 'duration', { value: 200, configurable: true })
      audioEl().dispatchEvent(new Event('loadedmetadata'))
    })
    expect(screen.getByTestId('duration')).toHaveTextContent('200')
  })

  it('resets reported position and duration when the song changes', () => {
    usePlayerStore.setState({ current: { source: 'context', song: makeSong(1) } })
    render(<Harness />)

    act(() => {
      audioEl().currentTime = 30
      audioEl().dispatchEvent(new Event('timeupdate'))
    })
    expect(screen.getByTestId('current-time')).toHaveTextContent('30')

    act(() => {
      usePlayerStore.setState({ current: { source: 'context', song: makeSong(2) } })
    })
    expect(screen.getByTestId('current-time')).toHaveTextContent('0')
    expect(screen.getByTestId('duration')).toHaveTextContent('0')
  })

  it('restarts from zero when the store bumps the restart nonce', () => {
    usePlayerStore.setState({ current: { source: 'context', song: makeSong(1) } })
    render(<Harness />)

    act(() => {
      audioEl().currentTime = 60
      usePlayerStore.setState({ restartNonce: 1 })
    })
    expect(audioEl().currentTime).toBe(0)
    expect(play()).toHaveBeenCalled()
  })
})

describe('useAudioElement — end of track', () => {
  it('hands the ended event to the store, which advances the queue', () => {
    const songs = [makeSong(1), makeSong(2)]
    usePlayerStore.setState({
      contextQueue: songs,
      contextOrder: [0, 1],
      contextIndex: 0,
      current: { source: 'context', song: songs[0] },
      isPlaying: true,
    })
    render(<Harness />)

    act(() => {
      audioEl().dispatchEvent(new Event('ended'))
    })
    expect(selectCurrentSong(usePlayerStore.getState())?.id).toBe(2)
  })
})

describe('useAudioElement — OS media controls', () => {
  it('publishes the current track to the media session', () => {
    usePlayerStore.setState({
      current: { source: 'context', song: makeSong(3, { title: 'Nightcall', artist: 'Kavinsky' }) },
      isPlaying: true,
    })
    render(<Harness />)

    expect(navigator.mediaSession.metadata).not.toBeNull()
    expect(navigator.mediaSession.playbackState).toBe('playing')
  })

  it('registers handlers for the hardware media keys', () => {
    render(<Harness />)
    const actions = vi
      .mocked(navigator.mediaSession.setActionHandler)
      .mock.calls.map(([action]) => action)
    expect(actions).toEqual(expect.arrayContaining(['play', 'pause', 'previoustrack', 'nexttrack']))
  })
})

describe('useAudioElement — sleep timer', () => {
  it('fades the element out over the final seconds, then stops and restores volume', () => {
    vi.useFakeTimers()
    usePlayerStore.setState({
      current: { source: 'context', song: makeSong(1) },
      isPlaying: true,
      volume: 1,
    })
    render(<Harness />)

    // One minute from now; the fade covers the last five seconds.
    act(() => usePlayerStore.setState({ sleepAt: Date.now() + 60_000 }))

    act(() => void vi.advanceTimersByTime(55_000))
    expect(audioEl().volume).toBeCloseTo(1)

    // Halfway through the 5s fade the element should be at half volume.
    act(() => void vi.advanceTimersByTime(2_500))
    expect(audioEl().volume).toBeCloseTo(0.5, 1)

    act(() => void vi.advanceTimersByTime(2_500))
    expect(usePlayerStore.getState().isPlaying).toBe(false)
    expect(usePlayerStore.getState().sleepAt).toBeNull()
    // The timer must not leave the player silently muted for next time.
    expect(audioEl().volume).toBeCloseTo(1)
  })
})
