import { useEffect, useState } from 'react'
import {
  AccessibilityInfo,
  ScrollView,
  StyleSheet,
  Text,
  type LayoutChangeEvent,
} from 'react-native'
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from 'react-native-reanimated'

interface Props {
  children: string
  /** Text styling. The container is laid out by the caller as usual. */
  style?: React.ComponentProps<typeof Text>['style']
}

/** How fast the text travels, in points per second. Slow enough to read while
 *  it moves, which is the whole objection a marquee has to answer. */
const SPEED = 32

export interface MarqueeRun {
  /** How far the text has to travel, in points. */
  distance: number
  /** How long one pass takes, so the speed is the same for a title that is
   *  barely too long and one that is twice the width. */
  durationMs: number
}

/**
 * Whether this text has to move at all, and how far — the whole decision, with
 * no animation in it.
 *
 * Kept apart from the component for the reason `crossfade.ts` is: this half can
 * be *checked*, and the other half is a Reanimated shared value that a test can
 * only observe through several layers of mock. Everything worth getting wrong
 * is here.
 *
 * A single point of overflow is not overflow: measured widths are floats, and
 * `content` and `viewport` land a fraction apart for text that fits exactly.
 * Animating that produces a title that twitches forever.
 */
export function marqueeRun(
  contentWidth: number,
  viewportWidth: number,
  reduceMotion: boolean,
): MarqueeRun | null {
  if (reduceMotion) return null
  // Nothing has been measured yet. Both arrive from `onLayout`, a frame apart.
  if (contentWidth <= 0 || viewportWidth <= 0) return null
  const distance = contentWidth - viewportWidth
  if (distance <= 1) return null
  return { distance, durationMs: (distance / SPEED) * 1000 }
}

/** How long it sits still at each end. The start pause is longer because that
 *  is where a title is read from — it should be legible before anything moves,
 *  and a title that scrolls the instant it appears is the one people complain
 *  about. */
const START_PAUSE_MS = 1_600
const END_PAUSE_MS = 900

/**
 * A title that scrolls itself when it is too long to fit (#306).
 *
 * ## Only where it was asked for
 *
 * *"we do want scrolling marquee title for the track that is currently
 * playing, not every track."* So this is a component the two now-playing
 * surfaces opt into, not a replacement for `<Text numberOfLines={1}>`. A list
 * where every row scrolls is motion sickness.
 *
 * ## It overrules a docblock that argued the other way
 *
 * `playing.tsx` used to carry a note explaining why the title was *not* a
 * marquee: an animation loop running for as long as the panel is open, and text
 * that cannot be read while it moves. The first half was accepted and the
 * second is answered rather than ignored — it travels at {@link SPEED} points a
 * second and **stops at both ends**, so the beginning of a title is stationary
 * and legible for {@link START_PAUSE_MS} before anything happens. A continuous
 * loop would have been simpler and is the thing that reads as unreadable.
 *
 * ## Nothing moves unless it has to
 *
 * The animation only exists when the text is genuinely wider than the space —
 * measured, not guessed from character counts, because a CJK title is far wider
 * per character than a Latin one and this library is full of both. A title that
 * fits starts no timers at all.
 *
 * It also stops for anyone who has asked their phone to stop animating things.
 *
 * ## Why the measurement is a `ScrollView` — the bug this shipped with
 *
 * The first version put the text in a plain `View` with
 * `alignSelf: 'flex-start'` and measured it with `onLayout`, on the reasoning
 * that a flex-start child sizes to its content instead of stretching. **It
 * never scrolled once on a device**, and the reason is that the trick answers
 * the wrong question: `alignSelf` decides how wide the box is *allowed* to be,
 * and Yoga still measures the text node with the parent's width as its
 * available width. A `<Text numberOfLines={1}>` handed 200 points of available
 * width reports that it is 200 points wide — truncated — however long the
 * string is. So the measured content width came back **exactly equal to the
 * viewport**, the overflow was always zero, and the marquee correctly concluded
 * it had nothing to do.
 *
 * A horizontal `ScrollView` is the platform's own unbounded-width measurement:
 * its content is laid out with no width constraint along the scroll axis, and
 * `onContentSizeChange` reports the natural width. That is the number this
 * needs and there is no way to get it from a constrained parent.
 *
 * **No test could have caught this**, which is worth knowing before writing one
 * that pretends otherwise: jest performs no layout, so every width in
 * `marquee.test.tsx` is one the test supplied. The tests check the arithmetic,
 * which was right the whole time. Only a phone measures text.
 */
export function MarqueeText({ children, style }: Props) {
  const [viewport, setViewport] = useState(0)
  const [content, setContent] = useState(0)
  const [reduceMotion, setReduceMotion] = useState(false)

  useEffect(() => {
    let cancelled = false
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) setReduceMotion(enabled)
    })
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)
    return () => {
      cancelled = true
      subscription.remove()
    }
  }, [])

  const run = marqueeRun(content, viewport, reduceMotion)
  const distance = run?.distance ?? 0
  const durationMs = run?.durationMs ?? 0

  const offset = useSharedValue(0)

  useEffect(() => {
    if (distance <= 0) {
      // Back to the start, and no animation left running. A title that stops
      // scrolling half way along and stays there is worse than one that never
      // moved.
      cancelAnimation(offset)
      offset.value = 0
      return
    }

    offset.value = withRepeat(
      withSequence(
        withDelay(
          START_PAUSE_MS,
          withTiming(-distance, { duration: durationMs, easing: Easing.linear }),
        ),
        withDelay(END_PAUSE_MS, withTiming(0, { duration: durationMs, easing: Easing.linear })),
      ),
      -1,
    )

    return () => {
      cancelAnimation(offset)
    }
  }, [distance, durationMs, offset])

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }))

  return (
    <ScrollView
      testID="marquee-viewport"
      horizontal
      // Nobody scrolls this by hand; the ScrollView is here to *measure*, and
      // it clips as a side effect. `pointerEvents` matters as much as
      // `scrollEnabled`: the now-playing bar is one big `Pressable`, and a
      // scroll view sitting in the middle of it would eat the tap that opens
      // the panel.
      scrollEnabled={false}
      pointerEvents="none"
      showsHorizontalScrollIndicator={false}
      style={styles.viewport}
      onLayout={(event: LayoutChangeEvent) => setViewport(event.nativeEvent.layout.width)}
      onContentSizeChange={(width: number) => setContent(width)}
    >
      <Animated.View testID="marquee-content" style={animatedStyle}>
        <Text
          // Never wraps: this is one line that moves sideways. Without it a long
          // title would wrap to two lines, both of which fit, and the marquee
          // would correctly conclude it has nothing to do.
          numberOfLines={1}
          style={style}
        >
          {children}
        </Text>
      </Animated.View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  // `flexGrow: 0` so a horizontal scroll view does not try to fill the column
  // it is sitting in.
  viewport: { flexGrow: 0 },
})
