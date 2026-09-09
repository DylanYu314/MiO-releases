import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'

import { useThemedStyles, type Theme } from '../theme'

/**
 * A row you can swipe sideways to do one thing (#316, #379).
 *
 * Extracted from `SongRow`'s swipe-to-queue when the queue asked for
 * swipe-**left**-to-remove. ADR-018's instruction is to reuse the composition
 * answer rather than tune a gesture per screen, and two copies of this — one
 * per direction — is exactly the drift it warns about. The decider stayed a
 * pure function for the same reason it always was: jest cannot see a finger.
 *
 * ## How it composes with the two gestures already on these rows
 *
 * ADR-018 case 1 does the work: `activeOffsetX` claims sideways movement and
 * `failOffsetY` yields downward movement, so a list still scrolls normally when
 * a finger travels down a row.
 *
 * The other neighbour is `DraggableList`'s drag, ADR-018 case **2**, separated
 * by *time* — it activates after 120 ms of holding still. The two never compete
 * for one touch: a swipe has moved sideways long before that elapses, and a
 * hold has not moved at all. Nothing here needs to know about the drag, which
 * is the point of having decided the composition once.
 *
 * ## Why it renders nothing when there is no handler
 *
 * A gesture detector with nowhere to report is a row that appears to accept a
 * swipe and then ignores it, which is worse than a row that does not move. So
 * screens opt in, and the ones that do not are byte-for-byte what they were.
 */

/** How far the row must travel before letting go commits. Far enough that a
 *  wobble during a scroll is not an action, short enough to reach with a thumb
 *  on a wide phone. */
const SWIPE_COMMIT_PX = 96

/** How far it can be dragged at all, so the gesture has a visible end rather
 *  than the row sliding off the screen. */
const SWIPE_LIMIT_PX = 128

/** ADR-018 case 1: claim sideways movement, yield downward movement to the
 *  list. The same pair the scrubber and the equaliser bands use. */
const GRAB_SLOP = 12
const SCROLL_SLOP = 12

export type SwipeDirection = 'right' | 'left'

/**
 * Whether letting go here commits, and how far the row has moved.
 *
 * Pure, and tested as one, for the reason `secondsAt` and `marqueeRun` are.
 * `offset` is signed — negative for a leftward swipe — so the caller can hand it
 * straight to a transform, while `commits` is about distance travelled in the
 * direction the row actually offers.
 *
 * **Movement the other way is clamped to zero**, not mirrored: a row that
 * travels both ways implies two actions, and only one is on offer. A leftward
 * drag on a queue-only row is somebody scrolling or reaching for the back
 * gesture.
 */
export function swipeTravel(
  translationX: number,
  direction: SwipeDirection = 'right',
): { offset: number; commits: boolean } {
  const travelled = Math.min(
    Math.max(direction === 'right' ? translationX : -translationX, 0),
    SWIPE_LIMIT_PX,
  )
  return {
    // `travelled === 0` guarded rather than negated blindly: `-0` is a real
    // value that `Object.is` and `toEqual` both distinguish from `0`, and a
    // decider returning it is a trap for whoever compares two of these next.
    offset: travelled === 0 || direction === 'right' ? travelled : -travelled,
    commits: travelled >= SWIPE_COMMIT_PX,
  }
}

export interface SwipeableRowProps {
  /** Which way the row travels, and therefore which way commits. */
  direction: SwipeDirection
  /** Shown on the backdrop the row uncovers — what letting go will do. */
  label: string
  /** Absent means no gesture is created at all, and the children render bare. */
  onCommit?: () => void
  /** Distinguishes one row's gesture from another's for `fireGestureHandler`. */
  testId: string
  /** A destructive action gets the danger colour behind it, so the row does not
   *  say "remove" in the same tone it says "queue". */
  tone?: 'accent' | 'danger'
  children: ReactNode
}

export function SwipeableRow({
  direction,
  label,
  onCommit,
  testId,
  tone = 'accent',
  children,
}: SwipeableRowProps) {
  const styles = useThemedStyles(makeStyles)
  const offset = useSharedValue(0)

  const settle = () => {
    offset.value = withSpring(0, { damping: 20, stiffness: 220 })
  }

  const pan = Gesture.Pan()
    .withTestId(`swipe-${testId}`)
    .runOnJS(true)
    .maxPointers(1)
    .activeOffsetX([-GRAB_SLOP, GRAB_SLOP])
    .failOffsetY([-SCROLL_SLOP, SCROLL_SLOP])
    .onUpdate((event) => {
      offset.value = swipeTravel(event.translationX, direction).offset
    })
    .onEnd((event, success) => {
      if (success && swipeTravel(event.translationX, direction).commits) onCommit?.()
      // Always back to where it started: the row is a row, not a drawer that
      // stays open. What happened is visible in the list, not in the row.
      settle()
    })
    .onFinalize((_event, success) => {
      if (!success) settle()
    })

  const style = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }))

  if (!onCommit) return <>{children}</>

  return (
    <View style={styles.container}>
      {/* Revealed as the row moves off it. It says what letting go will do — a
          row sliding sideways with nothing behind it is a glitch. */}
      <View
        style={[
          styles.backdrop,
          direction === 'right' ? styles.fromLeft : styles.fromRight,
          tone === 'danger' && styles.danger,
        ]}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[style, styles.surface]}>{children}</Animated.View>
      </GestureDetector>
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { position: 'relative', overflow: 'hidden' },
    backdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.accentSolid,
      justifyContent: 'center',
      paddingHorizontal: 20,
    },
    // The label sits on the side the row uncovers, so it is read rather than
    // hidden under the part of the row that has not moved yet.
    fromLeft: { alignItems: 'flex-start' },
    fromRight: { alignItems: 'flex-end' },
    danger: { backgroundColor: theme.danger },
    label: { fontSize: 13, fontWeight: '600', color: theme.accentText },
    // Opaque, or the backdrop shows through the row that is meant to cover it.
    surface: { backgroundColor: theme.background },
  })
