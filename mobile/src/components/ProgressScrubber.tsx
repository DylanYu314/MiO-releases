import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'

import { formatDuration } from '../api/songs'
import { useThemedStyles, type Theme } from '../theme'

interface Props {
  /** Where playback actually is, in seconds. */
  position: number
  /** Track length in seconds; 0 until the stream's header has been read. */
  duration: number
  onSeek: (seconds: number) => void
}

/**
 * How far the finger must travel sideways before this becomes a scrub.
 *
 * Small, because the bar is 32px tall and anything starting on it is probably
 * meant for it — but not zero, because zero would claim every touch and the
 * panel behind it would stop scrolling.
 */
const GRAB_SLOP = 6

/** How far it may travel *down* before this gives up and lets the panel scroll.
 *  Larger than the sideways figure: a horizontal drag by a thumb is an arc. */
const SCROLL_SLOP = 12

/**
 * How close the player has to get before the bar stops showing the seek target.
 *
 * One second and a half is a little over two status ticks — near enough that
 * the difference is ordinary playback rather than "the seek has not landed".
 */
const ARRIVED_SECONDS = 1.5

/** How long the bar will wait for a seek that never lands before showing the
 *  real position again. A dropped seek must not freeze the display forever. */
const ARRIVAL_TIMEOUT_MS = 4_000

/**
 * The draggable progress bar (#231, rewritten for #302).
 *
 * ## Built on `Gesture.Pan()`, and why it was not
 *
 * This file used to say that `react-native-gesture-handler` was "unpinned and
 * unverified" and that `PanResponder` — core React Native, no rebuild, no
 * dependency — was therefore the safe choice. That reasoning expired with #233:
 * gesture-handler and Reanimated are pinned in `package.json` at the versions
 * already compiled into the dev build, the worklets plugin is proved applied,
 * and `GestureHandlerRootView` is in the root layout. `DraggableList` has been
 * built on them since.
 *
 * The stale note was not harmless. **Two of #302's four defects were
 * `PanResponder` itself:**
 *
 * - `event.nativeEvent.locationX` is relative to *the view actually touched*.
 *   The thumb is a 14px absolutely-positioned child, so grabbing the dot
 *   reported an x of 0–14 and seeked to the start of the track. A gesture
 *   event's `x` is relative to the view the `GestureDetector` wraps — the bar —
 *   whatever child the finger happens to be over.
 * - `onPanResponderTerminationRequest` defaults to `() => true`, so the parent
 *   `ScrollView` could take the responder *mid-drag* and the terminate handler
 *   committed a seek at whatever partial position the finger had reached. Under
 *   gesture-handler a pan that has activated cannot be taken: activation
 *   cancels the native scroll rather than the other way round.
 *
 * ## How this composes with the panel's `ScrollView` — the answer S4 reuses
 *
 * `docs/adr/0018-gestures-inside-scroll-views.md` is the full version, with the
 * platform source it was read off. In short, and as used here:
 *
 * - **The pan claims one axis.** `activeOffsetX` means it only ever activates
 *   on sideways movement, so a finger dragging *down* the bar scrolls the panel
 *   as if the bar were not there. `failOffsetY` makes that decision early
 *   rather than leaving both waiting.
 * - **A tap is a separate gesture, raced against the pan.** It has to be:
 *   Android's `PanGestureHandler` only tests for activation on the *second*
 *   motion event, so a release while still `BEGAN` calls `fail()`. A pan alone
 *   cannot see a tap that does not move, which is most taps.
 *
 * ## Why the bar holds its own value, twice
 *
 * While a finger is down it shows where the *finger* is: otherwise the thumb
 * fights the twice-a-second status tick and jumps back under the user.
 *
 * And on release it keeps showing the seek target until `position` arrives
 * there. That is #302's fourth defect: clearing straight back to `position`
 * showed the pre-seek position for up to half a second — a snap backwards
 * followed by a jump forwards, which is what "seeking has big latency" was.
 *
 * The seek is sent on release rather than continuously: scrubbing across a
 * three-minute track would otherwise issue a hundred of them, and each one
 * makes the native player re-buffer.
 */
export function ProgressScrubber({ position, duration, onSeek }: Props) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)

  const [width, setWidth] = useState(0)
  /** Where the finger is, while it is down. */
  const [drag, setDrag] = useState<number | null>(null)
  /** Where a released drag asked to go, until the player gets there. */
  const [pending, setPending] = useState<number | null>(null)

  /*
   * The player has arrived, so let go of the target — adjusted during render
   * rather than in an effect.
   *
   * This is React's documented way to react to a prop changing, and here it is
   * also the only correct one: an effect would commit a render still showing
   * the target and then immediately re-render (`react-hooks/set-state-in-effect`
   * says as much), which is a frame of the very lag this is fixing. Clearing it
   * rather than deriving "arrived" each render matters too — a derived flag
   * would re-latch onto the old target the moment ordinary playback carried the
   * position back past it, minutes later.
   */
  if (pending !== null && Math.abs(position - pending) <= ARRIVED_SECONDS) setPending(null)

  useEffect(() => {
    if (pending === null) return
    // A seek at a track the player has not finished preparing is dropped
    // silently, and a bar frozen on a position nothing will ever reach is a
    // worse lie than the one being fixed.
    const timeout = setTimeout(() => setPending(null), ARRIVAL_TIMEOUT_MS)
    return () => clearTimeout(timeout)
  }, [pending])

  /**
   * Send the seek — from a touch event, never from inside a state updater.
   *
   * That was #302's crash. `onSeek` writes to the zustand store, and calling it
   * inside a `setDrag` updater ran it during render: a store write while
   * rendering, which React may also run twice.
   */
  const commit = (seconds: number) => {
    setDrag(null)
    setPending(seconds)
    onSeek(seconds)
  }

  /*
   * Rebuilt every render, deliberately, and this is the other thing
   * `PanResponder` could not do. `PanResponder.create` captures its handlers
   * once, which is why this file used to keep `width` and `duration` in a ref
   * and explain at length why — a handler built on the first render closes over
   * `duration: 0` and seeks to the start forever.
   *
   * `GestureDetector` re-attaches on every render and assigns
   * `handler.handlers = newGestures[i].handlers`
   * (`GestureDetector/updateHandlers.ts`), and the event receiver reads
   * `handler.handlers` at dispatch time. So these closures are always the
   * current render's, and the ref is gone.
   *
   * The swap is one `setImmediate` behind the render — `ghQueueMicrotask` is
   * `setImmediate` where it exists — which matters nowhere near a finger, and
   * matters in a test that installs fake timers before laying the bar out.
   */
  const seconds = (x: number) => secondsAt(x, width, duration)

  const tap = Gesture.Tap()
    .withTestId('scrubber-tap')
    // Plain JS callbacks rather than worklets: everything here is React state
    // and a zustand write, so there is nothing for the UI thread to do that it
    // would not immediately hand back.
    .runOnJS(true)
    .onEnd((event, success) => {
      if (success) commit(seconds(event.x))
    })

  const pan = Gesture.Pan()
    .withTestId('scrubber-pan')
    .runOnJS(true)
    .maxPointers(1)
    .activeOffsetX([-GRAB_SLOP, GRAB_SLOP])
    .failOffsetY([-SCROLL_SLOP, SCROLL_SLOP])
    // The bar follows the finger absolutely rather than by displacement: grab
    // it anywhere and the value is where you are, which is what every other
    // player does and what makes grabbing the thumb mean nothing special.
    .onStart((event) => setDrag(seconds(event.x)))
    .onUpdate((event) => setDrag(seconds(event.x)))
    /*
     * A cancelled pan seeks nowhere — and `success` is load-bearing, because
     * `onEnd` runs for a cancellation as well as a release (`eventReceiver.ts`
     * calls it for `FAILED` and `CANCELLED` too, with `false`).
     *
     * `PanResponder` committed on termination — reasonably, since the parent
     * stealing the responder was the *normal* way a drag ended there — and that
     * is precisely how #302's "it jumps to a random position" happened. Here a
     * cancel means the gesture genuinely lost, and acting on it would be
     * inventing an instruction the user did not give.
     */
    .onEnd((event, success) => {
      if (success) commit(seconds(event.x))
      else setDrag(null)
    })

  const shown = drag ?? pending ?? position
  const fraction = duration > 0 ? Math.min(Math.max(shown / duration, 0), 1) : 0

  return (
    <View>
      <GestureDetector gesture={Gesture.Race(tap, pan)}>
        <View
          onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
          // The hit area is the padded wrapper, not the 4px line: a 4px target is
          // unhittable with a thumb, and the padding is what makes it a control.
          style={styles.touchArea}
          accessibilityRole="adjustable"
          accessibilityLabel={t('player.seek')}
          accessibilityValue={{
            min: 0,
            max: Math.round(duration),
            now: Math.round(shown),
            text: `${formatDuration(shown)} / ${formatDuration(duration)}`,
          }}
        >
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${fraction * 100}%` }]} />
          </View>
          <View style={[styles.thumb, { left: `${fraction * 100}%` }]} />
        </View>
      </GestureDetector>

      <View style={styles.times}>
        <Text style={styles.time}>{formatDuration(shown)}</Text>
        <Text style={styles.time}>{formatDuration(duration)}</Text>
      </View>
    </View>
  )
}

/** Where along the bar a touch landed, in seconds. */
function secondsAt(x: number, width: number, duration: number): number {
  if (width <= 0 || duration <= 0) return 0
  return clamp((x / width) * duration, duration)
}

function clamp(seconds: number, duration: number): number {
  return Math.min(Math.max(seconds, 0), Math.max(duration, 0))
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    touchArea: { paddingVertical: 14, justifyContent: 'center' },
    track: { height: 4, borderRadius: 999, backgroundColor: theme.surfaceMuted },
    fill: { height: 4, borderRadius: 999, backgroundColor: theme.accentSolid },
    thumb: {
      position: 'absolute',
      width: 14,
      height: 14,
      borderRadius: 999,
      backgroundColor: theme.accentSolid,
      // Centred on its position rather than starting at it, so the thumb sits
      // over the point it represents at both ends of the bar.
      transform: [{ translateX: -7 }],
    },
    times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -2 },
    time: { fontSize: 12, color: theme.textMuted, fontVariant: ['tabular-nums'] },
  })
