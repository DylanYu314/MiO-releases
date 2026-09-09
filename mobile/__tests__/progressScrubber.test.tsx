import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { GestureHandlerRootView, State } from 'react-native-gesture-handler'
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils'

import { ProgressScrubber } from '../src/components/ProgressScrubber'
import '../src/i18n'

/**
 * The draggable progress bar (#231), rewritten on gesture-handler for #302.
 *
 * The old file drove `PanResponder`'s handlers by hand, and building the touch
 * history it computes `gestureState` from took thirty lines. Worse, it had to
 * *synthesise `locationX` itself* — which is exactly the value the component was
 * reading wrongly, so the suite was green while grabbing the thumb seeked to the
 * start of the track. A test that supplies the broken input cannot see the bug.
 *
 * Gestures here are driven with gesture-handler's own `fireGestureHandler`,
 * which feeds the handler the event sequence the native side would, with the
 * fields it would carry. `x` is the one that matters: it is relative to the view
 * the `GestureDetector` wraps, which is the bar.
 */

/** The bar reports its own width through `onLayout`, and a 0-width bar can map
 *  no touch to a time — so every test lays it out first. */
async function layOut(width = 200) {
  await act(async () => {
    fireEvent(screen.getByLabelText('Seek'), 'layout', {
      nativeEvent: { layout: { width, height: 4, x: 0, y: 0 } },
    })
  })
  // gesture-handler hands each render's callbacks to the handler on a
  // `setImmediate`, and awaiting promises never reaches the event loop's check
  // phase. Without this the gesture is still holding the closures from before
  // the bar had a width, and every touch maps to zero seconds.
  await new Promise((resolve) => setImmediate(resolve))
}

function draw(position: number, duration: number, onSeek: jest.Mock) {
  return (
    <GestureHandlerRootView>
      <ProgressScrubber position={position} duration={duration} onSeek={onSeek} />
    </GestureHandlerRootView>
  )
}

/** A press and release at `x`, with no movement — which is most taps, and what
 *  a lone pan cannot see (see the component, and ADR-018). */
async function tapAt(x: number) {
  // Fired *inside* `act`, which is not decoration: React Native's scheduler
  // runs on `setImmediate`, so under fake timers an update scheduled outside
  // act is never flushed and the assertion reads the render before the touch.
  await act(async () => {
    fireGestureHandler(getByGestureTestId('scrubber-tap'), [
      { state: State.BEGAN, x },
      { state: State.ACTIVE, x },
      { state: State.END, x },
    ])
  })
}

/**
 * Put a drag in flight at `x` and leave it there, finger still down.
 *
 * `fireGestureHandler` always *completes* a gesture — it fills in the END the
 * caller left out — so it cannot express "the finger has not been lifted", which
 * is the state the bar's hold-its-own-value behaviour is entirely about. These
 * are the same callbacks the event receiver dispatches to; it looks
 * `handler.handlers` up at dispatch time, so this is that path minus the
 * completion.
 */
async function dragTo(x: number) {
  const pan = getByGestureTestId('scrubber-pan') as unknown as {
    handlers: { onStart?: (event: { x: number }) => void }
  }
  await act(async () => {
    pan.handlers.onStart?.({ x })
  })
}

/** A drag through each of `xs`, released at the last one. */
async function dragThrough(...xs: number[]) {
  await act(async () => {
    fireGestureHandler(getByGestureTestId('scrubber-pan'), [
      { state: State.BEGAN, x: xs[0] },
      ...xs.map((x) => ({ state: State.ACTIVE, x })),
      { state: State.END, x: xs[xs.length - 1] },
    ])
  })
}

describe('ProgressScrubber', () => {
  it('shows elapsed and total', async () => {
    await render(draw(65, 180, jest.fn()))

    expect(screen.getByText('1:05')).toBeTruthy()
    expect(screen.getByText('3:00')).toBeTruthy()
  })

  it('seeks where a tap landed', async () => {
    const onSeek = jest.fn()
    await render(draw(0, 180, onSeek))
    await layOut(200)

    // Half way along a 200px bar through a 180s track.
    await tapAt(100)

    expect(onSeek).toHaveBeenCalledWith(90)
  })

  it('seeks where a drag was let go', async () => {
    const onSeek = jest.fn()
    await render(draw(0, 180, onSeek))
    await layOut(200)

    await dragThrough(20, 60, 120)

    expect(onSeek).toHaveBeenCalledTimes(1)
    expect(onSeek).toHaveBeenCalledWith(108)
  })

  /**
   * #302's second defect, as a scenario.
   *
   * The thumb is a 14px absolutely-positioned child, and `PanResponder`'s
   * `locationX` is relative to the view actually touched — so grabbing the dot
   * reported 0–14px and seeked to ≈0 seconds however far along the track it was.
   * A gesture event's `x` is relative to the bar whatever is under the finger,
   * which is why this reads 135 seconds and not the start.
   */
  it('grabs the thumb where the thumb is, not at the start of the track', async () => {
    const onSeek = jest.fn()
    // Playing at 2:15 of 3:00, so the thumb sits at 150px along a 200px bar.
    await render(draw(135, 180, onSeek))
    await layOut(200)

    await dragThrough(150, 152)

    expect(onSeek).toHaveBeenCalledWith(136.8)
  })

  it('follows the finger, not the playhead, while dragging', async () => {
    const onSeek = jest.fn()
    const view = await render(draw(0, 180, onSeek))
    await layOut(200)

    await dragTo(50)

    // The status tick arrives mid-drag, as it does twice a second. Without the
    // bar holding its own value the thumb jumps back under the user's finger.
    await act(async () => {
      view.rerender(draw(3, 180, onSeek))
    })

    // 50px of 200 through a 180s track.
    expect(screen.getByText('0:45')).toBeTruthy()
    // And nothing is sent until release: scrubbing a whole track would
    // otherwise issue a hundred seeks, each making the native player re-buffer.
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('clamps a drag past either end to the track', async () => {
    const onSeek = jest.fn()
    await render(draw(0, 180, onSeek))
    await layOut(200)

    await dragThrough(100, 600)
    expect(onSeek).toHaveBeenLastCalledWith(180)

    await dragThrough(100, -400)
    expect(onSeek).toHaveBeenLastCalledWith(0)
  })

  /**
   * #302's third defect, inverted.
   *
   * `PanResponder` set no `onPanResponderTerminationRequest`, so the parent
   * `ScrollView` could take the responder mid-drag — and `onPanResponderTerminate`
   * was wired to commit, which seeked to wherever the finger had got to. That is
   * "it jumps to a random position". Under gesture-handler an activated pan
   * cannot be taken by the scroll view, so a cancel means the gesture genuinely
   * lost, and the only honest response is to seek nowhere.
   */
  it('seeks nowhere when the gesture is cancelled', async () => {
    const onSeek = jest.fn()
    await render(draw(30, 180, onSeek))
    await layOut(200)

    await act(async () => {
      fireGestureHandler(getByGestureTestId('scrubber-pan'), [
        { state: State.BEGAN, x: 100 },
        { state: State.ACTIVE, x: 120 },
        { state: State.FAILED, x: 120 },
      ])
    })

    expect(onSeek).not.toHaveBeenCalled()
    // And the bar goes back to reporting playback rather than sitting on the
    // abandoned drag.
    expect(screen.getByText('0:30')).toBeTruthy()
  })

  /**
   * #302's fourth defect — the one reported as "seeking has big latency".
   *
   * On release the bar used to show `position` again immediately, and that is
   * still the *pre-seek* position until the next status tick up to half a second
   * later: a visible snap backwards, then a jump forwards.
   */
  describe('holding the seek target until the player gets there', () => {
    it('keeps showing where the seek asked for, not where playback still is', async () => {
      const onSeek = jest.fn()
      const view = await render(draw(0, 180, onSeek))
      await layOut(200)

      await tapAt(100)
      expect(screen.getByText('1:30')).toBeTruthy()

      // A status tick from before the seek landed. Believing it is the snap back.
      await act(async () => {
        view.rerender(draw(0.5, 180, onSeek))
      })
      expect(screen.getByText('1:30')).toBeTruthy()
    })

    it('lets go the moment the player arrives, and does not grab back', async () => {
      const onSeek = jest.fn()
      const view = await render(draw(0, 180, onSeek))
      await layOut(200)

      await tapAt(100)
      await act(async () => {
        view.rerender(draw(90, 180, onSeek))
      })
      expect(screen.getByText('1:30')).toBeTruthy()

      // Playback carries on. A bar that decided "arrived" by comparing distance
      // each render would re-latch onto the old target here and show 1:30 for
      // the rest of the track.
      await act(async () => {
        view.rerender(draw(120, 180, onSeek))
      })
      expect(screen.getByText('2:00')).toBeTruthy()
    })

    it('gives up on a seek that never lands', async () => {
      const onSeek = jest.fn()
      await render(draw(0, 180, onSeek))
      await layOut(200)

      // Fake timers *after* the layout, not before. gesture-handler hands the
      // current render's callbacks to the handler on a `setImmediate`, which
      // jest's modern fake timers replace — so installing them first freezes the
      // gesture on the closures from the render before the bar had a width, and
      // every touch maps to 0 seconds.
      jest.useFakeTimers()
      try {
        // A seek at a track the player has not finished preparing is dropped
        // silently, and a bar frozen on a position nothing will reach is a
        // worse lie than the one this fixes.
        await tapAt(100)
        expect(screen.getByText('1:30')).toBeTruthy()

        await act(async () => {
          jest.advanceTimersByTime(4_000)
        })

        expect(screen.getByText('0:00')).toBeTruthy()
      } finally {
        jest.useRealTimers()
      }
    })
  })

  it('does nothing before the track length is known', async () => {
    const onSeek = jest.fn()
    // `duration` is 0 until the stream's header has been read, and a fraction of
    // an unknown length is not a position.
    await render(draw(0, 0, onSeek))
    await layOut(200)

    await tapAt(100)

    expect(onSeek).toHaveBeenCalledWith(0)
  })

  /**
   * The bug the old file kept a ref to avoid, and the reason the ref is gone.
   *
   * `PanResponder.create` captures its handlers once, so a handler closing over
   * `duration` kept seeing the value from the render that built it — 0, because
   * the length arrives after the track loads — and every drag seeked to the
   * start. `GestureDetector` re-attaches on every render and replaces
   * `handler.handlers`, so the closures are always the current render's. This
   * pins that, because it is the whole reason the rewrite is simpler rather than
   * merely different.
   */
  it('uses the duration it has now, not the one it was built with', async () => {
    const onSeek = jest.fn()
    const view = await render(draw(0, 0, onSeek))
    await layOut(200)

    // The track loads and reports its length, exactly as it does in the app.
    await act(async () => {
      view.rerender(draw(0, 180, onSeek))
    })

    await tapAt(100)

    expect(onSeek).toHaveBeenCalledWith(90)
  })
})
