import fs from 'node:fs'
import path from 'node:path'

import AsyncStorage from '@react-native-async-storage/async-storage'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { GestureHandlerRootView, State } from 'react-native-gesture-handler'
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils'

import { EqualizerPanel, gainAt } from '../src/components/EqualizerPanel'
import { useEqualizerReach } from '../src/player/equalizerReach'
import {
  EQ_PRESETS,
  FLAT_GAINS,
  MAX_GAIN_DB,
  loadAudioSettings,
  useAudioSettings,
} from '../src/player/audioSettings'
import '../src/i18n'

/**
 * The ten-band equaliser (#202).
 *
 * These cover the half that is JavaScript: the curve, the presets, what
 * survives a restart, and what the panel does when the native module is not
 * there. The half that actually filters audio is Kotlin
 * (`modules/mio-equalizer`) and cannot be exercised here at all — no jest, no
 * `DynamicsProcessing`, no audio session. It needs a rebuild and a listen.
 */

const mockNative = {
  isSupported: true,
  bandCount: 10,
  bandFrequencies: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
  maxGainDb: 12,
  setGains: jest.fn(() => true),
  release: jest.fn(),
}

/**
 * `requireOptionalNativeModule` returning **null** is the case worth modelling.
 *
 * It is what every build made before this module existed will do, including the
 * dev client currently on the phone. A mock that always supplied the module
 * would make the one state users are guaranteed to meet the one state never
 * tested.
 */
// `mock`-prefixed so the hoisted factory may reference it: jest exempts only
// names starting with "mock" from its out-of-scope guard (a convention in this repo).
let mockNativePresent = true
jest.mock('expo', () => ({
  requireOptionalNativeModule: () => (mockNativePresent ? mockNative : null),
}))

beforeEach(async () => {
  mockNativePresent = true
  mockNative.setGains.mockClear()
  await AsyncStorage.clear()
  useAudioSettings.setState({ eqGains: FLAT_GAINS, preset: 'flat' })
  // A module-level store outlives the test that wrote to it, and a leftover
  // "not reaching the audio" would leak into every panel test after it.
  useEqualizerReach.setState({ reaching: null, reason: null })
})

describe('the equaliser curve', () => {
  it('applies a preset to every band', async () => {
    await act(async () => {
      await useAudioSettings.getState().applyPreset('bass')
    })

    expect(useAudioSettings.getState().eqGains).toEqual(EQ_PRESETS.bass)
    expect(useAudioSettings.getState().preset).toBe('bass')
  })

  it('matches the web client preset for preset', () => {
    // Copied deliberately rather than re-derived: a preset meaning something
    // slightly different on each client is a bug you can only hear, and only by
    // switching between them. Ten bands each, so the shapes are comparable.
    for (const gains of Object.values(EQ_PRESETS)) {
      expect(gains).toHaveLength(10)
      expect(gains.every((gain) => Math.abs(gain) <= MAX_GAIN_DB)).toBe(true)
    }
    expect(EQ_PRESETS.flat).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(EQ_PRESETS.bass).toEqual([7, 6, 4, 2, -1, -1, 0, 0, 0, 1])
    expect(EQ_PRESETS.vocal).toEqual([-3, -2, -1, 1, 3, 4, 4, 2, 0, -1])
    expect(EQ_PRESETS.treble).toEqual([0, 0, 0, -1, -1, 0, 2, 4, 6, 7])
  })

  it('stops calling the curve a preset once a band is moved', async () => {
    await act(async () => {
      await useAudioSettings.getState().applyPreset('bass')
      await useAudioSettings.getState().setBandGain(4, 6)
    })

    // A UI still highlighting "Bass" after the user has pulled a band around is
    // describing a curve that does not exist.
    expect(useAudioSettings.getState().preset).toBeNull()
    expect(useAudioSettings.getState().eqGains[4]).toBe(6)
  })

  it('clamps a band to the range the native side accepts', async () => {
    await act(async () => {
      await useAudioSettings.getState().setBandGain(0, 99)
    })
    expect(useAudioSettings.getState().eqGains[0]).toBe(MAX_GAIN_DB)

    await act(async () => {
      await useAudioSettings.getState().setBandGain(0, -99)
    })
    expect(useAudioSettings.getState().eqGains[0]).toBe(-MAX_GAIN_DB)
  })

  it('ignores a band that does not exist rather than growing the curve', async () => {
    await act(async () => {
      await useAudioSettings.getState().setBandGain(99, 6)
    })

    expect(useAudioSettings.getState().eqGains).toHaveLength(10)
  })
})

describe('what survives a restart', () => {
  it('restores a hand-made curve, and remembers it was hand-made', async () => {
    await act(async () => {
      await useAudioSettings.getState().setBandGain(2, 4)
    })
    const saved = [...useAudioSettings.getState().eqGains]

    useAudioSettings.setState({ eqGains: FLAT_GAINS, preset: 'flat' })
    await act(async () => {
      await loadAudioSettings()
    })

    expect(useAudioSettings.getState().eqGains).toEqual(saved)
    expect(useAudioSettings.getState().preset).toBeNull()
  })

  it('ignores a stored curve with the wrong number of bands', async () => {
    // A curve saved by a build with a different band count would otherwise
    // leave bands unset — and the ones it did set would be at the wrong
    // frequencies, which is worse than starting flat.
    await AsyncStorage.setItem('mio-eq-gains', JSON.stringify([1, 2, 3]))

    await act(async () => {
      await loadAudioSettings()
    })

    expect(useAudioSettings.getState().eqGains).toEqual(FLAT_GAINS)
  })

  it('survives unreadable stored settings rather than failing the launch', async () => {
    await AsyncStorage.setItem('mio-eq-gains', 'not json')

    await act(async () => {
      await loadAudioSettings()
    })

    expect(useAudioSettings.getState().eqGains).toEqual(FLAT_GAINS)
  })
})

describe('the panel', () => {
  it('says so when the device or the build has no equaliser', async () => {
    // The state every existing install is in until the next native build, and
    // the reason `requireOptionalNativeModule` is used at all.
    mockNativePresent = false

    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )

    expect(screen.getByText('No equaliser on this device')).toBeTruthy()
    // No controls at all, rather than controls that move numbers and change no
    // sound — which looks like it works, and is the worse failure.
    expect(screen.queryByText('Bass boost')).toBeNull()
  })

  it('offers the presets, including the two #242 asked for', async () => {
    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )

    expect(screen.getByText('Bass boost')).toBeTruthy()
    expect(screen.getByText('Podcast')).toBeTruthy()
    expect(screen.getByText('Loudness')).toBeTruthy()
  })

  it('raises a band by a step you can hear', async () => {
    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Raise the 1k band'))
    })

    // 2 dB: about the smallest step audible on a phone, and one that does not
    // turn ten bands into forty taps.
    expect(useAudioSettings.getState().eqGains[5]).toBe(2)
  })

  it('shows Custom only once the curve is nobody', async () => {
    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )
    expect(screen.queryByText('Custom')).toBeNull()

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Lower the 31 band'))
    })

    expect(screen.getByText('Custom')).toBeTruthy()
  })

  it('will not push a band past what the native side accepts', async () => {
    useAudioSettings.setState({ eqGains: [MAX_GAIN_DB, ...FLAT_GAINS.slice(1)], preset: null })

    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Raise the 31 band'))
    })

    expect(useAudioSettings.getState().eqGains[0]).toBe(MAX_GAIN_DB)
  })

  it('resets to flat', async () => {
    useAudioSettings.setState({ eqGains: EQ_PRESETS.bass, preset: 'bass' })

    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )
    await act(async () => {
      fireEvent.press(screen.getByText('Reset to flat'))
    })

    expect(useAudioSettings.getState().eqGains).toEqual(FLAT_GAINS)
    expect(useAudioSettings.getState().preset).toBe('flat')
  })

  /**
   * Saying when the curve is not on the audio.
   *
   * The equaliser has now failed twice on a device while looking perfectly
   * healthy — bands draw, numbers move, no sound changes. "Is there a module"
   * and "did the module take it" are different questions, and only the first
   * was ever asked out loud.
   */
  describe('when the curve is not reaching the audio', () => {
    it('says so, rather than showing controls that change nothing', async () => {
      useEqualizerReach.setState({ reaching: false })

      await render(
        <GestureHandlerRootView>
          <EqualizerPanel />
        </GestureHandlerRootView>,
      )

      expect(screen.getByText('Not reaching the audio')).toBeTruthy()
      // The controls stay: the setting is still recorded and will apply the
      // moment something accepts it. This is a statement, not a dead end.
      expect(screen.getByText('Bass boost')).toBeTruthy()
    })

    it('names the reason, so a refusal can be acted on rather than guessed at', async () => {
      // The whole of #303's third attempt: "refused" is not a diagnosis, and
      // this issue has now been diagnosed by reading twice, wrongly both times.
      useEqualizerReach.setState({ reaching: false, reason: 'session_blocked' })

      await render(
        <GestureHandlerRootView>
          <EqualizerPanel />
        </GestureHandlerRootView>,
      )

      expect(screen.getByText('session_blocked')).toBeTruthy()
    })

    it('stays quiet once it is on the audio', async () => {
      useEqualizerReach.setState({ reaching: true })

      await render(
        <GestureHandlerRootView>
          <EqualizerPanel />
        </GestureHandlerRootView>,
      )

      expect(screen.queryByText('Not reaching the audio')).toBeNull()
    })

    it('stays quiet when nothing is playing, which is not a refusal', async () => {
      // No track means no audio session to attach to, so there is nothing to
      // report. Saying "not reaching the audio" for silence is its own lie.
      useEqualizerReach.setState({ reaching: null, reason: null })

      await render(
        <GestureHandlerRootView>
          <EqualizerPanel />
        </GestureHandlerRootView>,
      )

      expect(screen.queryByText('Not reaching the audio')).toBeNull()
    })
  })
})

/**
 * Dragging a band (#317).
 *
 * The steppers exist because a slider was assumed to need a native module.
 * ADR-018 answers it without one — a horizontal control inside a vertical
 * scroll claims its own axis — which makes "needs a native module" wrong for
 * the third time in this repo, after the sleep fade (#241) and crossfade (#201).
 *
 * The arithmetic is a pure function and is tested as one, for the same reason
 * the scrubber's is: jest performs no layout, so the width in a gesture test is
 * one the test invented.
 */
describe('the gain a drag means', () => {
  it('reads the middle of the bar as flat', () => {
    expect(gainAt(100, 200)).toBe(0)
  })

  it('reads the ends as the full range, either way', () => {
    expect(gainAt(200, 200)).toBe(MAX_GAIN_DB)
    expect(gainAt(0, 200)).toBe(-MAX_GAIN_DB)
  })

  it('reads a point between as a proportion of it', () => {
    // Three quarters along is half way up: the bar runs -12..+12 across its
    // width, so the centre is 0 and 75% is +6.
    expect(gainAt(150, 200)).toBe(MAX_GAIN_DB / 2)
  })

  it('clamps a finger dragged past either end', () => {
    expect(gainAt(400, 200)).toBe(MAX_GAIN_DB)
    expect(gainAt(-80, 200)).toBe(-MAX_GAIN_DB)
  })

  it('answers flat before the bar has been measured', () => {
    // Both arrive from `onLayout`; a division by a width of zero is not a gain.
    expect(gainAt(100, 0)).toBe(0)
  })

  it('lands on whole decibels, so the number moves as the finger does', () => {
    expect(Number.isInteger(gainAt(137, 200))).toBe(true)
  })
})

describe('dragging a band on the panel', () => {
  it('sets the band from where the finger is', async () => {
    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )

    await act(async () => {
      fireEvent(screen.getAllByTestId('band-meter')[0], 'layout', {
        nativeEvent: { layout: { width: 200, height: 8, x: 0, y: 0 } },
      })
    })
    await new Promise((resolve) => setImmediate(resolve))
    await act(async () => {
      fireGestureHandler(getByGestureTestId('band-0'), [
        { state: State.BEGAN, x: 200 },
        { state: State.ACTIVE, x: 200 },
        { state: State.END, x: 200 },
      ])
    })

    expect(useAudioSettings.getState().eqGains[0]).toBe(MAX_GAIN_DB)
  })

  it('follows the finger across the bar, not just where it landed', async () => {
    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )
    await act(async () => {
      fireEvent(screen.getAllByTestId('band-meter')[0], 'layout', {
        nativeEvent: { layout: { width: 200, height: 8, x: 0, y: 0 } },
      })
    })
    await new Promise((resolve) => setImmediate(resolve))

    await act(async () => {
      fireGestureHandler(getByGestureTestId('band-0'), [
        // Starts at the centre — 0 dB — and travels to the far end.
        { state: State.BEGAN, x: 100 },
        { state: State.ACTIVE, x: 100 },
        { state: State.ACTIVE, x: 200 },
        { state: State.END, x: 200 },
      ])
    })

    // Without the update handler this stops at 0: the band would take the value
    // where the finger *started* and ignore the whole drag, which is a tap with
    // extra steps.
    expect(useAudioSettings.getState().eqGains[0]).toBe(MAX_GAIN_DB)
  })

  it('keeps the steppers, which are the accessible path', async () => {
    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )

    // #317 asked for the drag *alongside* them. A −/+ pair has a label a screen
    // reader can read and a target that needs no aiming, and it is the only way
    // to be exact.
    expect(screen.getByLabelText('Raise the 1k band')).toBeTruthy()
    expect(screen.getByLabelText('Lower the 31 band')).toBeTruthy()
  })
})

/**
 * What a drag costs (#317, from the device).
 *
 * "The EQ band is draggable now, but it's too laggy and huge latency." Not the
 * gesture and not the equaliser — the **saving**. `setBandGain` ends in an
 * `await persistEq(...)`, an AsyncStorage write, and a drag calls it sixty
 * times a second: a storage round-trip per pixel of finger travel.
 */
describe('the cost of moving a band', () => {
  it('writes nothing to storage while the finger is moving', async () => {
    const writes = jest.spyOn(AsyncStorage, 'multiSet')
    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )
    await act(async () => {
      fireEvent(screen.getAllByTestId('band-meter')[0], 'layout', {
        nativeEvent: { layout: { width: 200, height: 8, x: 0, y: 0 } },
      })
    })
    await new Promise((resolve) => setImmediate(resolve))
    writes.mockClear()

    /*
     * Driven through the handler's own callbacks rather than
     * `fireGestureHandler`, which always *completes* a gesture — it fills in
     * the END the caller left out, and the commit fires with it. "The finger is
     * still down" cannot be expressed any other way, and it is the whole state
     * this test is about.
     */
    const band = getByGestureTestId('band-0') as unknown as {
      handlers: {
        onStart?: (event: { x: number }) => void
        onUpdate?: (event: { x: number }) => void
      }
    }
    await act(async () => {
      band.handlers.onStart?.({ x: 100 })
      band.handlers.onUpdate?.({ x: 140 })
      band.handlers.onUpdate?.({ x: 160 })
    })

    // The bands have moved and the audio has followed — only the record of it
    // is waiting for the finger to lift.
    expect(useAudioSettings.getState().eqGains[0]).toBeGreaterThan(0)
    expect(writes).not.toHaveBeenCalled()
    writes.mockRestore()
  })

  it('writes it down once the finger lifts', async () => {
    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )
    await act(async () => {
      fireEvent(screen.getAllByTestId('band-meter')[0], 'layout', {
        nativeEvent: { layout: { width: 200, height: 8, x: 0, y: 0 } },
      })
    })
    await new Promise((resolve) => setImmediate(resolve))
    const writes = jest.spyOn(AsyncStorage, 'multiSet')

    await act(async () => {
      fireGestureHandler(getByGestureTestId('band-0'), [
        { state: State.BEGAN, x: 100 },
        { state: State.ACTIVE, x: 200 },
        { state: State.END, x: 200 },
      ])
    })

    // Or the curve is gone at the next launch, which is a worse bug than a slow
    // drag.
    expect(writes).toHaveBeenCalled()
    writes.mockRestore()
  })

  it('still saves a drag the OS interrupts', async () => {
    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )
    await act(async () => {
      fireEvent(screen.getAllByTestId('band-meter')[0], 'layout', {
        nativeEvent: { layout: { width: 200, height: 8, x: 0, y: 0 } },
      })
    })
    await new Promise((resolve) => setImmediate(resolve))
    const writes = jest.spyOn(AsyncStorage, 'multiSet')

    await act(async () => {
      fireGestureHandler(getByGestureTestId('band-0'), [
        { state: State.BEGAN, x: 100 },
        { state: State.ACTIVE, x: 200 },
        { state: State.FAILED, x: 200 },
      ])
    })

    // The bands moved and the audio changed before it was cancelled, so the
    // only question left is whether it survives a restart. Unlike the scrubber,
    // where a cancelled drag must *not* seek, there is nothing to undo here.
    expect(writes).toHaveBeenCalled()
    writes.mockRestore()
  })

  /**
   * What a drag costs **React** (#372, from the production build).
   *
   * The storage write was #317's answer and it was only half of it. I on the
   * release build: *"this equalizer component is completely local, this
   * shouldn't happen, maybe your approach of ui is wrong."* It was — the gesture
   * wrote a store the whole panel subscribed to, on every frame, so a finger
   * moving one dot re-rendered ten bands.
   *
   * The gain is a whole number of decibels, so most frames of a drag mean
   * nothing at all. These pin that: the bar follows the finger from a shared
   * value, and React hears about it only when the number changes.
   */
  it('says nothing to the store while the finger moves within one decibel', async () => {
    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )
    await act(async () => {
      fireEvent(screen.getAllByTestId('band-meter')[0], 'layout', {
        nativeEvent: { layout: { width: 200, height: 8, x: 0, y: 0 } },
      })
    })
    await new Promise((resolve) => setImmediate(resolve))

    let updates = 0
    const stop = useAudioSettings.subscribe(() => {
      updates += 1
    })

    /*
     * Each frame is flushed before the next, which is what a device does: touch
     * events arrive about 16 ms apart as separate tasks, with React's render in
     * between. The gate compares against **this render's** gain (ADR-018 case
     * 5), so a test that fired four frames into one tick would be asking the
     * component a question a finger never asks.
     */
    const band = () =>
      getByGestureTestId('band-0') as unknown as {
        handlers: {
          onStart?: (event: { x: number }) => void
          onUpdate?: (event: { x: number }) => void
        }
      }
    // The bar is 200 px across a 24 dB range, so a decibel is about eight
    // pixels: after the grab, these three frames all mean +6 dB, which is what
    // a finger resting against a control looks like sixty times a second.
    for (const [handler, x] of [
      ['onStart', 150],
      ['onUpdate', 151],
      ['onUpdate', 152],
      ['onUpdate', 153],
    ] as const) {
      await act(async () => {
        band().handlers[handler]?.({ x })
      })
    }
    stop()

    // One: the grab itself, which moved the band from 0 to +6. The three frames
    // after it said the same thing.
    expect(updates).toBe(1)
    expect(useAudioSettings.getState().eqGains[0]).toBe(MAX_GAIN_DB / 2)
  })

  it('says nothing at all for a grab that changes nothing', async () => {
    // Landing on the value the band already holds is not an edit. It used to
    // publish one anyway, which re-rendered the panel to say so.
    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )
    await act(async () => {
      fireEvent(screen.getAllByTestId('band-meter')[0], 'layout', {
        nativeEvent: { layout: { width: 200, height: 8, x: 0, y: 0 } },
      })
    })
    await new Promise((resolve) => setImmediate(resolve))

    let updates = 0
    const stop = useAudioSettings.subscribe(() => {
      updates += 1
    })
    const band = getByGestureTestId('band-0') as unknown as {
      handlers: { onStart?: (event: { x: number }) => void }
    }
    // The centre of the bar is 0 dB, and the band is already flat.
    await act(async () => {
      band.handlers.onStart?.({ x: 100 })
    })
    stop()

    expect(updates).toBe(0)
    // Including the preset, which is what "Custom" is drawn from: a curve
    // nobody changed is still the preset it came from.
    expect(useAudioSettings.getState().preset).toBe('flat')
  })

  it('does still tell it when the finger crosses one', async () => {
    // The other half, and the reason the gate is a comparison rather than a
    // throttle: the audio follows the finger because `PlayerHost` re-applies
    // the curve when `eqGains` changes, and a drag you cannot hear is a stepper
    // with extra steps.
    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )
    await act(async () => {
      fireEvent(screen.getAllByTestId('band-meter')[0], 'layout', {
        nativeEvent: { layout: { width: 200, height: 8, x: 0, y: 0 } },
      })
    })
    await new Promise((resolve) => setImmediate(resolve))

    let updates = 0
    const stop = useAudioSettings.subscribe(() => {
      updates += 1
    })
    const band = () =>
      getByGestureTestId('band-0') as unknown as {
        handlers: {
          onStart?: (event: { x: number }) => void
          onUpdate?: (event: { x: number }) => void
        }
      }
    for (const [handler, x] of [
      ['onStart', 100],
      ['onUpdate', 125],
      ['onUpdate', 150],
    ] as const) {
      await act(async () => {
        band().handlers[handler]?.({ x })
      })
    }
    stop()

    // Two, not three: the grab at the centre changed nothing, and the two
    // frames after it each crossed into a new decibel.
    expect(updates).toBe(2)
    expect(useAudioSettings.getState().eqGains[0]).toBe(MAX_GAIN_DB / 2)
  })

  it('shows a dot on the bar, so it reads as a control', async () => {
    await render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )

    // Without it the bar is a readout that happens to respond to a finger —
    // the same complaint the drag handle answered for the queue.
    expect(screen.getAllByTestId('band-thumb', { includeHiddenElements: true })).toHaveLength(10)
  })
})

/**
 * Who subscribes to the curve (#372).
 *
 * The frame cost above is only half the fix. The other half is *how much* a
 * frame that does count costs: the panel used to select `eqGains` itself, so
 * one band moving re-rendered ten rows, their steppers and their labels.
 *
 * A render count is not observable from a test here, so this reads the source
 * the way `pressFeedbackConsistency.test.ts` does — the regression it guards
 * against is a one-line edit that would look perfectly reasonable in review.
 */
describe('who subscribes to the curve', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'EqualizerPanel.tsx'),
    'utf8',
  )

  it('subscribes to one band at a time, never to the whole curve', () => {
    // A row selects `state.eqGains[index]` — a number, which zustand compares
    // with `Object.is`, so a row whose gain did not change does not render.
    // Selecting the array instead re-renders whatever holds the subscription on
    // every change, and the panel holds all ten rows.
    expect([...source.matchAll(/state\.eqGains/g)]).toHaveLength(1)
  })

  it('does subscribe to a band, so the check above cannot pass vacuously', () => {
    // A file that read the curve some third way would satisfy the count above
    // forever. This is the mutation that would otherwise survive.
    expect(source).toContain('state.eqGains[index]')
  })
})
