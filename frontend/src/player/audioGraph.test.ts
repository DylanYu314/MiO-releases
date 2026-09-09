import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAudioGraph, resetAudioGraphForTests } from './audioGraph'

function element() {
  return document.createElement('audio')
}

// The stub installed by src/test/setup.ts, captured so the tests that replace
// it can put it back. `vi.unstubAllGlobals()` is wrong here: setup.ts stubs
// several globals once per file, so unstubbing all of them mid-file strips
// MediaMetadata and AudioContext from every test that follows.
const setupAudioContext = globalThis.AudioContext

beforeEach(() => {
  resetAudioGraphForTests()
})

afterEach(() => {
  vi.stubGlobal('AudioContext', setupAudioContext)
  resetAudioGraphForTests()
})

describe('audioGraph', () => {
  it('builds a graph around the element it is given', () => {
    const deckA = element()
    const graph = getAudioGraph(deckA)

    expect(graph).not.toBeNull()
    expect(graph!.deckA).toBe(deckA)
    // Deck B exists from the start, wired and silent, so G2 has somewhere to
    // crossfade into without re-plumbing.
    expect(graph!.deckB).toBeInstanceOf(HTMLAudioElement)
    expect(graph!.deckB).not.toBe(deckA)
  })

  it('leaves the audible path at unity, with deck B silent', () => {
    // With crossfade off this is the whole signal path, and it has to be a
    // pass-through: anything other than 1.0 on deck A's chain is an audible
    // change. Deck B must be at 0 or a preloaded track would play underneath.
    const graph = getAudioGraph(element())!
    expect(graph.normGainA.gain.value).toBe(1)
    expect(graph.normGainB.gain.value).toBe(1)
    expect(graph.master.gain.value).toBe(1)
    expect(graph.fadeGainA.gain.value).toBe(1)
    expect(graph.fadeGainB.gain.value).toBe(0)
  })

  it('is a singleton — the same element gets the same graph', () => {
    const deckA = element()
    expect(getAudioGraph(deckA)).toBe(getAudioGraph(deckA))
  })

  it('binds each element exactly once, however many times it is asked', () => {
    // createMediaElementSource throws InvalidStateError on a second call for
    // the same element, so a hook effect that ran twice (React StrictMode
    // double-mounts in development) would kill audio outright.
    const deckA = element()
    const first = getAudioGraph(deckA)

    expect(() => getAudioGraph(deckA)).not.toThrow()
    expect(getAudioGraph(deckA)).toBe(first)
  })

  it('falls back rather than driving a dead deck after a remount', () => {
    // An element can never be re-pointed at a new context. If React hands over
    // a replacement element, direct playback is correct; a stale binding is not.
    getAudioGraph(element())
    expect(getAudioGraph(element())).toBeNull()
  })

  it('falls back when the browser has no AudioContext', () => {
    vi.stubGlobal('AudioContext', undefined)
    expect(getAudioGraph(element())).toBeNull()
  })

  it('falls back when constructing the context throws', () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('blocked by policy')
        }
      },
    )
    expect(getAudioGraph(element())).toBeNull()
  })

  it('falls back when wiring the graph throws', () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'suspended'
        destination = {}
        createGain() {
          return { gain: { value: 1 }, connect: () => {} }
        }
        createMediaElementSource(): never {
          const error = new Error('already connected')
          error.name = 'InvalidStateError'
          throw error
        }
      },
    )
    // Playback must survive a graph that refuses to build.
    expect(getAudioGraph(element())).toBeNull()
  })

  it('stops retrying once the environment has proved it cannot', () => {
    const construct = vi.fn(() => {
      throw new Error('nope')
    })
    vi.stubGlobal('AudioContext', construct)

    getAudioGraph(element())
    getAudioGraph(element())
    getAudioGraph(element())

    // Retrying on every render would mean a failed context construction on
    // every frame of playback.
    expect(construct).toHaveBeenCalledTimes(1)
  })

  it('starts suspended and resumes on demand', () => {
    // A suspended context wired to the destination is silence behind a moving
    // progress bar, so resume() has to actually change state.
    const graph = getAudioGraph(element())!
    expect(graph.context.state).toBe('suspended')

    graph.resume()
    expect(graph.context.state).toBe('running')
  })

  it('does not resume a context that is already running', () => {
    const graph = getAudioGraph(element())!
    graph.resume()
    const resumeSpy = vi.spyOn(graph.context, 'resume')

    graph.resume()
    expect(resumeSpy).not.toHaveBeenCalled()
  })
})
