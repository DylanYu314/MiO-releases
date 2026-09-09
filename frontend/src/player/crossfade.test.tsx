import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Song } from '../api/types'
import { getAudioGraph } from './audioGraph'
import { CROSSFADE_MAX_SECONDS, selectNextSong, usePlayerStore } from './store'
import { useAudioElement } from './useAudioElement'

/**
 * Crossfade (G2). The graph's two decks are finally both used: the incoming
 * track starts on the idle one while the outgoing fades on the other.
 *
 * jsdom has no audio clock, so a ramp cannot actually be heard here — these
 * assert on what was *scheduled* on which gain, plus which element ends up
 * carrying playback. The audible half is verified live against the real stack.
 */

function makeSong(id: number): Song {
  return {
    id,
    title: `Song ${id}`,
    artist: `Artist ${id}`,
    album: null,
    duration: 200,
    source_url: `https://example.com/${id}`,
    source_platform: 'Youtube',
    added_at: '2026-07-22T12:00:00Z',
  }
}

function Harness() {
  const { audioRef, seek } = useAudioElement()
  return (
    <>
      <audio ref={audioRef} data-testid="audio" hidden />
      <button type="button" onClick={() => seek(seekTarget)}>
        seek
      </button>
    </>
  )
}

/** Where the Harness's seek button jumps to; set per test. */
let seekTarget = 0

const deckA = () => screen.getByTestId('audio') as HTMLAudioElement
const graph = () => getAudioGraph(deckA())!

/** The curve, start time and duration of the most recent fade on a gain. */
function lastFade(gain: GainNode) {
  const calls = vi.mocked(gain.gain.setValueCurveAtTime).mock.calls
  const [values, startTime, duration] = calls.at(-1)!
  return { curve: values as Float32Array, startTime, duration }
}

/** Play `songs` and let the first one settle onto deck A, which is what makes
 *  a subsequent track change eligible to crossfade. */
function startPlaying(songs: Song[]) {
  act(() => {
    usePlayerStore.getState().playFromContext(songs)
  })
}

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
    crossfadeSeconds: 0,
    restartNonce: 0,
  })
})

describe('crossfade setting', () => {
  it('is off by default, so transitions sound as they always did', () => {
    expect(usePlayerStore.getState().crossfadeSeconds).toBe(0)
  })

  it('clamps to the slider range and takes whole seconds', () => {
    const set = usePlayerStore.getState().setCrossfadeSeconds

    act(() => set(-5))
    expect(usePlayerStore.getState().crossfadeSeconds).toBe(0)

    act(() => set(999))
    expect(usePlayerStore.getState().crossfadeSeconds).toBe(CROSSFADE_MAX_SECONDS)

    act(() => set(6.4))
    expect(usePlayerStore.getState().crossfadeSeconds).toBe(6)
  })
})

describe('selectNextSong', () => {
  it('is null with nothing playing', () => {
    expect(selectNextSong(usePlayerStore.getState())).toBeNull()
  })

  it('peeks the user queue before the context, without consuming it', () => {
    const [a, b, queued] = [makeSong(1), makeSong(2), makeSong(9)]
    usePlayerStore.getState().playFromContext([a, b])
    usePlayerStore.getState().addToQueue(queued)

    expect(selectNextSong(usePlayerStore.getState())?.id).toBe(9)
    // Peeking must not drain it — the crossfade looks several seconds early.
    expect(usePlayerStore.getState().userQueue).toHaveLength(1)
  })

  it('falls through to the context, then stops at the end', () => {
    usePlayerStore.getState().playFromContext([makeSong(1), makeSong(2)])
    expect(selectNextSong(usePlayerStore.getState())?.id).toBe(2)

    act(() => usePlayerStore.getState().next())
    expect(selectNextSong(usePlayerStore.getState())).toBeNull()
  })

  it('wraps when repeating the whole queue', () => {
    usePlayerStore.getState().playFromContext([makeSong(1), makeSong(2)])
    act(() => {
      usePlayerStore.setState({ repeat: 'all' })
      usePlayerStore.getState().next()
    })
    expect(selectNextSong(usePlayerStore.getState())?.id).toBe(1)
  })
})

describe('crossfade playback', () => {
  it('keeps everything on deck A while crossfade is off', () => {
    render(<Harness />)
    startPlaying([makeSong(1), makeSong(2)])

    act(() => usePlayerStore.getState().next())

    // The one visible element still carries the new track: no deck swap.
    expect(new URL(deckA().src).pathname).toBe('/api/songs/2/audio')
    expect(graph().fadeGainA.gain.linearRampToValueAtTime).not.toHaveBeenCalled()
  })

  it('fades the two decks past each other over the configured duration', () => {
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 8 })
    startPlaying([makeSong(1), makeSong(2)])

    act(() => usePlayerStore.getState().next())

    const { fadeGainA, fadeGainB, context } = graph()
    const out = lastFade(fadeGainA)
    const incoming = lastFade(fadeGainB)
    const outCurve = out.curve
    const inCurve = incoming.curve

    expect(out.startTime).toBe(context.currentTime)
    expect(incoming.startTime).toBe(context.currentTime)
    expect(out.duration).toBe(8)
    expect(incoming.duration).toBe(8)

    // Deck A ends silent, deck B ends open.
    expect(outCurve[0]).toBeCloseTo(1, 5)
    expect(outCurve.at(-1)).toBeCloseTo(0, 5)
    expect(inCurve[0]).toBeCloseTo(0, 5)
    expect(inCurve.at(-1)).toBeCloseTo(1, 5)
  })

  it('holds constant power across the whole fade, not constant amplitude', () => {
    // The point of the equal-power curve. Two *linear* ramps crossing at 0.5
    // sum to sqrt(0.5^2 + 0.5^2) = 0.707 — a 3 dB hole in the middle of every
    // transition, because uncorrelated signals add in power. cos/sin quarter
    // waves keep out^2 + in^2 = 1 the whole way across.
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 6 })
    startPlaying([makeSong(1), makeSong(2)])

    act(() => usePlayerStore.getState().next())

    const { fadeGainA, fadeGainB } = graph()
    const outCurve = lastFade(fadeGainA).curve
    const inCurve = lastFade(fadeGainB).curve

    for (let index = 0; index < outCurve.length; index++) {
      const power = outCurve[index] ** 2 + inCurve[index] ** 2
      expect(power).toBeCloseTo(1, 5)
    }

    // The midpoint is the signature: 0.707 each, not 0.5 each.
    const middle = Math.floor(outCurve.length / 2)
    expect(outCurve[middle]).toBeCloseTo(Math.SQRT1_2, 2)
    expect(inCurve[middle]).toBeCloseTo(Math.SQRT1_2, 2)
  })

  it('holds the current gain before fading, so an interrupted fade cannot click', () => {
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 5 })
    startPlaying([makeSong(1), makeSong(2)])

    act(() => usePlayerStore.getState().next())

    // cancelAndHoldAtTime freezes an automation where it stands; a plain cancel
    // would snap back to the value scheduled before the fade started.
    expect(graph().fadeGainA.gain.cancelAndHoldAtTime).toHaveBeenCalled()
  })

  it('starts an interrupted fade from where it actually is', () => {
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 6 })
    startPlaying([makeSong(1), makeSong(2), makeSong(3)])

    // Interrupt mid-fade: deck B is only partway up when the next skip lands.
    act(() => usePlayerStore.getState().next())
    graph().fadeGainB.gain.value = 0.4
    act(() => usePlayerStore.getState().next())

    // Deck B is now the outgoing one, and its fade must begin at 0.4 rather
    // than jumping to 1 first.
    const { curve } = lastFade(graph().fadeGainB)
    expect(curve[0]).toBeCloseTo(0.4, 5)
    expect(curve.at(-1)).toBeCloseTo(0, 5)
  })

  it('starts the incoming track on the idle deck, leaving the outgoing one alone', () => {
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 6 })
    startPlaying([makeSong(1), makeSong(2)])
    expect(new URL(deckA().src).pathname).toBe('/api/songs/1/audio')

    act(() => usePlayerStore.getState().next())

    // Deck A keeps the outgoing track — it is still fading out, not recycled.
    expect(new URL(deckA().src).pathname).toBe('/api/songs/1/audio')
    expect(new URL(graph().deckB.src).pathname).toBe('/api/songs/2/audio')
  })

  it('alternates decks across successive transitions', () => {
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 4 })
    startPlaying([makeSong(1), makeSong(2), makeSong(3)])

    act(() => usePlayerStore.getState().next())
    expect(new URL(graph().deckB.src).pathname).toBe('/api/songs/2/audio')

    act(() => usePlayerStore.getState().next())
    // Back to deck A, which is free again.
    expect(new URL(deckA().src).pathname).toBe('/api/songs/3/audio')
  })

  it('does not crossfade a track into itself on repeat-one', () => {
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 8, repeat: 'one' })
    startPlaying([makeSong(1), makeSong(2)])

    act(() => usePlayerStore.getState().next())

    expect(graph().fadeGainB.gain.linearRampToValueAtTime).not.toHaveBeenCalled()
  })

  it('does not crossfade while paused — there is nothing to fade out of', () => {
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 8 })
    startPlaying([makeSong(1), makeSong(2)])

    act(() => usePlayerStore.getState().setPlaying(false))
    act(() => usePlayerStore.getState().next())

    expect(graph().fadeGainB.gain.linearRampToValueAtTime).not.toHaveBeenCalled()
    expect(new URL(deckA().src).pathname).toBe('/api/songs/2/audio')
  })

  it('advances the queue early so the fade overlaps the end of the track', () => {
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 10 })
    startPlaying([makeSong(1), makeSong(2)])

    act(() => {
      const element = deckA()
      Object.defineProperty(element, 'duration', { value: 200, configurable: true })
      element.currentTime = 195 // 5s left, inside the 10s window
      element.dispatchEvent(new Event('timeupdate'))
    })

    // The store moved on before `ended` ever fired — that head start is what
    // makes the overlap possible at all.
    expect(usePlayerStore.getState().current?.song.id).toBe(2)
  })

  it('does not advance early when there is nothing to fade into', () => {
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 10 })
    startPlaying([makeSong(1)])

    act(() => {
      const element = deckA()
      Object.defineProperty(element, 'duration', { value: 200, configurable: true })
      element.currentTime = 195
      element.dispatchEvent(new Event('timeupdate'))
    })

    expect(usePlayerStore.getState().current?.song.id).toBe(1)
    expect(usePlayerStore.getState().isPlaying).toBe(true)
  })

  it('advances only once however many timeupdates arrive', () => {
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 10 })
    startPlaying([makeSong(1), makeSong(2), makeSong(3)])

    act(() => {
      const element = deckA()
      Object.defineProperty(element, 'duration', { value: 200, configurable: true })
      element.currentTime = 195
      for (let i = 0; i < 5; i++) element.dispatchEvent(new Event('timeupdate'))
    })

    // Five events, one advance — not a skip through the whole queue.
    expect(usePlayerStore.getState().current?.song.id).toBe(2)
  })

  it('does not skip the track when you seek into the crossfade window', () => {
    // Reported from real use: on a 1:30 track with a 12s crossfade, dragging
    // the progress bar to 1:18 jumped straight to the next song instead of
    // playing the last twelve seconds. Arriving at the window by *seeking* is
    // not the same as arriving by playing.
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 12 })
    startPlaying([makeSong(1), makeSong(2)])

    const element = deckA()
    Object.defineProperty(element, 'duration', { value: 90, configurable: true })
    seekTarget = 78 // 12s left — exactly on the boundary

    act(() => screen.getByRole('button', { name: 'seek' }).click())
    act(() => {
      element.dispatchEvent(new Event('timeupdate'))
    })

    expect(usePlayerStore.getState().current?.song.id).toBe(1)
  })

  it('does not skip twice when you seek into the window twice', () => {
    // The same report: clicking the bar twice skipped two songs.
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 12 })
    startPlaying([makeSong(1), makeSong(2), makeSong(3)])

    const element = deckA()
    Object.defineProperty(element, 'duration', { value: 90, configurable: true })

    for (const target of [80, 84]) {
      seekTarget = target
      act(() => screen.getByRole('button', { name: 'seek' }).click())
      act(() => {
        element.dispatchEvent(new Event('timeupdate'))
      })
    }

    expect(usePlayerStore.getState().current?.song.id).toBe(1)
  })

  it('still crossfades when you seek back out of the window and play on', () => {
    // The other half: a seek to safety must re-arm, or the track would reach
    // its end with no transition at all.
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 12 })
    startPlaying([makeSong(1), makeSong(2)])

    const element = deckA()
    Object.defineProperty(element, 'duration', { value: 90, configurable: true })

    seekTarget = 78 // into the window: suppressed
    act(() => screen.getByRole('button', { name: 'seek' }).click())
    seekTarget = 30 // back out: re-armed
    act(() => screen.getByRole('button', { name: 'seek' }).click())

    act(() => {
      element.currentTime = 79 // now *played* into the window
      element.dispatchEvent(new Event('timeupdate'))
    })

    expect(usePlayerStore.getState().current?.song.id).toBe(2)
  })

  it('ignores the outgoing deck once it is no longer active', () => {
    render(<Harness />)
    usePlayerStore.setState({ crossfadeSeconds: 6 })
    startPlaying([makeSong(1), makeSong(2), makeSong(3)])

    act(() => usePlayerStore.getState().next())
    const currentId = usePlayerStore.getState().current?.song.id

    // The outgoing deck is still playing out its tail; its events must not
    // advance the queue again or drag the progress bar backwards.
    act(() => {
      deckA().dispatchEvent(new Event('ended'))
    })

    expect(usePlayerStore.getState().current?.song.id).toBe(currentId)
  })
})
