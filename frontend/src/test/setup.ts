import '@testing-library/jest-dom/vitest'

// Initialise i18next for every test. The real app always has it set up, and
// components render translated text either way — without this, tests using a
// bare render() (no I18nextProvider) would see raw keys instead of English.
import '../i18n'

import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

import { resetAudioGraphForTests } from '../player/audioGraph'

// jsdom implements the <audio> element but none of its playback methods, so
// anything touching the player would throw "not implemented" without these.
window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
window.HTMLMediaElement.prototype.pause = vi.fn()
window.HTMLMediaElement.prototype.load = vi.fn()

// jsdom has no Web Audio API at all. Without this stub every test would
// silently take the graph's fallback path, and the graph itself (ADR-012) would
// ship with zero coverage behind a green suite.
//
// It mirrors the real API's constraints rather than just its shape — in
// particular that an element can only ever be bound to one source node.
// Verified in Chromium: a second createMediaElementSource for the same element
// throws InvalidStateError, and so does binding it to a different context. That
// is the constraint most likely to be violated by a remount, so the stub has to
// be able to catch it.
const boundElements = new WeakSet<HTMLMediaElement>()

class FakeAudioNode {
  connect(target: unknown) {
    return target
  }
  disconnect() {}
}

class FakeGainNode extends FakeAudioNode {
  // The mono downmix is expressed purely through these, so they have to be
  // real properties for a test to observe the channel mode at all.
  channelCount = 2
  channelCountMode: ChannelCountMode = 'max'
  channelInterpretation: ChannelInterpretation = 'speakers'

  // Ramps record their target rather than animating it: tests assert on what
  // was *scheduled*, since jsdom has no audio clock to run a ramp against.
  gain = {
    value: 1,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    cancelAndHoldAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn(),
  }
}

class FakeBiquadFilterNode extends FakeAudioNode {
  type: BiquadFilterType = 'peaking'
  frequency = { value: 350 }
  Q = { value: 1 }
  gain = { value: 0 }
}

class FakeStereoPannerNode extends FakeAudioNode {
  pan = { value: 0 }
}

class FakeAudioContext {
  state: AudioContextState = 'suspended'
  sampleRate = 48_000
  currentTime = 0
  destination = new FakeAudioNode()

  createGain() {
    return new FakeGainNode()
  }

  createBiquadFilter() {
    return new FakeBiquadFilterNode()
  }

  createStereoPanner() {
    return new FakeStereoPannerNode()
  }

  createMediaElementSource(element: HTMLMediaElement) {
    if (boundElements.has(element)) {
      const error = new Error(
        'Failed to execute createMediaElementSource: HTMLMediaElement already connected',
      )
      error.name = 'InvalidStateError'
      throw error
    }
    boundElements.add(element)
    return new FakeAudioNode()
  }

  resume() {
    this.state = 'running'
    return Promise.resolve()
  }

  close() {
    this.state = 'closed'
    return Promise.resolve()
  }
}

vi.stubGlobal('AudioContext', FakeAudioContext)

// jsdom has no matchMedia; the theme store reads it at import to resolve
// "system" mode, so stub it (defaults to light).
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  }),
})

// Media Session isn't in jsdom either. Stubbed so the player's OS-integration
// code runs in tests instead of being skipped by the 'mediaSession' guard.
vi.stubGlobal('MediaMetadata', class {})
Object.defineProperty(navigator, 'mediaSession', {
  configurable: true,
  value: { metadata: null, playbackState: 'none', setActionHandler: vi.fn() },
})

afterEach(() => {
  cleanup()
  // The graph is a page-lifetime singleton bound to one element forever, so
  // without this only the *first* test in a file would exercise the graph path
  // and every test after it would quietly fall back to the bare element —
  // green, and testing the wrong thing.
  resetAudioGraphForTests()
})
