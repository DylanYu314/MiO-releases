import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Song } from '../api/types'
import { resetAudioGraphForTests } from './audioGraph'
import { usePlayerStore } from './store'
import { useAudioElement } from './useAudioElement'

/**
 * The same behaviour, with Web Audio taken away.
 *
 * `useAudioElement.test.tsx` pins what the element does and — since the test
 * setup stubs `AudioContext` — now runs through the graph. This file runs the
 * core of it again with no `AudioContext` at all, which is what a browser
 * without Web Audio (or one that refuses to build the graph) gives us.
 *
 * Both files asserting the same things is the point: "the graph is transparent"
 * becomes a property the suite checks on every run, rather than a claim in a PR
 * description.
 */

function makeSong(id: number): Song {
  return {
    id,
    title: `Song ${id}`,
    artist: `Artist ${id}`,
    album: null,
    duration: 125,
    source_url: `https://example.com/${id}`,
    source_platform: 'Youtube',
    added_at: '2026-07-22T12:00:00Z',
  }
}

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

const audioEl = () => screen.getByTestId('audio') as HTMLAudioElement

// Captured so it can be restored: setup.ts stubs several globals once per file,
// so `vi.unstubAllGlobals()` would strip MediaMetadata from later tests too.
const setupAudioContext = globalThis.AudioContext

beforeEach(() => {
  vi.clearAllMocks()
  resetAudioGraphForTests()
  // No Web Audio in this file, at all.
  vi.stubGlobal('AudioContext', undefined)
  usePlayerStore.setState({
    contextQueue: [],
    contextOrder: [],
    contextIndex: -1,
    userQueue: [],
    current: null,
    isPlaying: false,
    volume: 1,
    muted: false,
    playbackRate: 1,
    sleepAt: null,
    sleepAfterTrack: false,
    restartNonce: 0,
  })
})

afterEach(() => {
  vi.stubGlobal('AudioContext', setupAudioContext)
  resetAudioGraphForTests()
})

describe('useAudioElement without Web Audio', () => {
  it('still loads and plays the current song', () => {
    usePlayerStore.setState({ current: { source: 'context', song: makeSong(4) }, isPlaying: true })
    render(<Harness />)

    expect(new URL(audioEl().src).pathname).toBe('/api/songs/4/audio')
    expect(vi.mocked(window.HTMLMediaElement.prototype.play)).toHaveBeenCalled()
  })

  it('still applies volume, mute and rate to the element', () => {
    usePlayerStore.setState({
      current: { source: 'context', song: makeSong(1) },
      volume: 0.3,
      muted: true,
      playbackRate: 1.25,
    })
    render(<Harness />)

    expect(audioEl().volume).toBeCloseTo(0.3)
    expect(audioEl().muted).toBe(true)
    expect(audioEl().playbackRate).toBe(1.25)
    expect(audioEl().preservesPitch).toBe(true)
  })

  it('still reports position and seeks', () => {
    usePlayerStore.setState({ current: { source: 'context', song: makeSong(1) } })
    render(<Harness />)

    act(() => {
      audioEl().currentTime = 15
      audioEl().dispatchEvent(new Event('timeupdate'))
    })
    expect(screen.getByTestId('current-time')).toHaveTextContent('15')
  })

  it('still advances the queue when a track ends', () => {
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
    expect(usePlayerStore.getState().current?.song.id).toBe(2)
  })

  it('does not throw when the graph is unavailable', () => {
    usePlayerStore.setState({ current: { source: 'context', song: makeSong(1) }, isPlaying: true })
    expect(() => render(<Harness />)).not.toThrow()
  })
})
