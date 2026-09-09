import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated'

import { logInfo } from '../diagnostics/log'
import { useTheme } from '../theme'
import { useScrollWindow, windowFor } from './ScrollWindow'

/**
 * Which gesture actually started a drag, and how long it took (#448).
 *
 * The handle has been "fixed" twice — #315 added it, #379 moved it off the edge
 * Android's back gesture claims **and** made it activate with no hold — and
 * I reports it still needs a long press. That is two failed attempts, and
 * this project's rule for that is to make the failure say more rather than to
 * guess a third time.
 *
 * `via` separates the two candidates outright: `handle` means the handle's own
 * gesture ran and something else is slow; `row` means the handle never received
 * the touch at all and the 120 ms long press is what is actually being felt. They need
 * completely different fixes.
 *
 * `held` is the gap between the finger landing (`onBegin`) and the drag taking
 * over (`onStart`) — the thing being complained about, measured rather than
 * described. Module-level because `runOnJS` wants a stable function and this
 * needs nothing from the component.
 */
function noteDragStart(via: string, held: number): void {
  logInfo('queue.dragStarted', `via=${via} held=${Math.round(held)}ms`)
}

/**
 * How a row looks while it is being dragged (#448).
 *
 * It was `opacity: 0.9` and nothing else, with a comment explaining that a
 * background colour was impossible because the row is drawn by the caller
 * against whatever the screen uses. That was true when this component knew
 * nothing about the theme; it does now, and `surfacePressed` is the app's one
 * token for "a finger is on this" (#378). *"make its background darker
 * or greyed out, so user know this track is selected"*.
 *
 * A function rather than an inline conditional because it is the only part of
 * the drag a test can reach: `fireGestureHandler` completes a gesture as it
 * dispatches it, so the row is dropped before the rendered tree can be read,
 * and the transient style is not observable through that harness. The decision
 * is, and it is the part that can be wrong.
 */
export function liftedRowStyle(
  isDragging: boolean,
  theme: { surfacePressed: string },
): { opacity: number; backgroundColor: string } | null {
  if (!isDragging) return null
  return { opacity: 0.9, backgroundColor: theme.surfacePressed }
}

/**
 * How long a finger must hold still before the drag takes over.
 *
 * Was 200 ms, chosen without a device and unverified until 2026-08-02, when
 * I ran it and said grabbing a row felt slow. 120 ms is short enough to feel
 * like the row is waiting for you, and still long enough that a flick reads as a
 * scroll — under about 100 ms the outer `FlatList` starts losing swipes to the
 * drag. **One constant, two screens**: the queue panel and the playlist edit
 * mode both move when this does.
 */
const LONG_PRESS_MS = 120

/**
 * How far the drag handle sits from the screen edge.
 *
 * **12 was not enough, and the arithmetic says so.** #379 moved the handle to
 * the right edge because Android's back gesture claims an inset from *both*
 * sides, and gave it a 12 dp margin to clear that inset — but the system
 * exclusion zone is **24 dp by default** and widens to around 40 dp at the
 * highest "back sensitivity" setting. A 12 dp margin therefore leaves half the
 * handle inside the zone at default sensitivity and all of it inside at high,
 * which is exactly what I reported on 2026-08-09: press-and-hold works
 * anywhere on the row **except** the three-bar icon.
 *
 * 40 clears it at any sensitivity. The handle is still where the eye expects
 * it; it just stops sharing a strip with the operating system.
 */
const HANDLE_INSET = 40

interface Props<T> {
  items: readonly T[]
  keyOf: (item: T, index: number) => string
  /** Every row is the same height, which is what makes the maths a division. */
  rowHeight: number
  renderItem: (item: T, index: number) => ReactNode
  onReorder: (from: number, to: number) => void
}

/**
 * Rows kept mounted beyond each edge of the viewport (#503).
 *
 * Enough that a fast fling does not reach an unmounted row before the next
 * window is computed, and small enough that the saving is real: at 56 dp a
 * phone shows roughly a dozen rows, so this roughly doubles what is mounted
 * rather than multiplying it.
 */
const OVERSCAN_ROWS = 6

/**
 * Which rows to mount, tracking the enclosing scroll container (#503).
 *
 * `null` means "all of them" — there is no scroll container publishing a
 * viewport, so windowing is not available and the list behaves as it always
 * did. That is the case for the playlist screen and for every existing test.
 *
 * ## It stops updating during a drag
 *
 * A row being dragged must not be unmounted underneath the finger, and the
 * still rows that slide out of its way are addressed by absolute index. The
 * subscription is simply not renewed while `frozen`, so the window in force
 * when the drag began stays in force until it ends. A drag always starts from a
 * visible row, so that window necessarily contains it.
 *
 * Exported for the same reason `shiftFor` and `liftedRowStyle` are: the freeze
 * cannot be driven through a rendered list, because `fireGestureHandler`
 * completes a gesture as it dispatches it and the drag is over before anything
 * can be asserted. The hook is the part that can be wrong, so the hook is what
 * a test drives.
 */
export function useRowWindow(count: number, rowHeight: number, frozen: boolean) {
  const source = useScrollWindow()
  const [range, setRange] = useState<{ start: number; end: number } | null>(null)
  /** This list's offset within the scrolled content, from its own layout. */
  const listY = useRef(0)

  const update = useCallback(
    (scrollY: number, viewportHeight: number) => {
      const next = windowFor(
        scrollY,
        viewportHeight,
        listY.current,
        rowHeight,
        count,
        OVERSCAN_ROWS,
      )
      // Re-render only when the window really moved: a scroll event arrives
      // every frame and almost none of them change which rows are mounted.
      setRange((prev) => (prev && prev.start === next.start && prev.end === next.end ? prev : next))
    },
    [count, rowHeight],
  )

  useEffect(() => {
    if (!source || frozen) return
    return source.subscribe((viewport) => update(viewport.scrollY, viewport.height))
  }, [source, frozen, update])

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      listY.current = event.nativeEvent.layout.y
      // The list has just learnt where it is, and the next scroll event may be
      // a long way off — a screen that opens without being touched would keep
      // its pre-layout window forever.
      if (source && !frozen) {
        const viewport = source.read()
        update(viewport.scrollY, viewport.height)
      }
    },
    [source, frozen, update],
  )

  return { range: source ? range : null, onLayout }
}

/**
 * A vertical drag-to-reorder list (#233).
 *
 * ## Written here rather than installed
 *
 * `react-native-draggable-flatlist` is the obvious package and is not compatible
 * with this stack — it predates Reanimated 4 and the worklets split. Writing the
 * one gesture we need is smaller than pinning an incompatible dependency, and it
 * is about sixty lines because the list is short, uniform and vertical.
 *
 * `docs/history/test-preparation.md` note 5 asked for gesture-handler and Reanimated to
 * be **proved** before anything was built on them. They were, before this file
 * existed: transforming a `useSharedValue`/`useAnimatedStyle` component through
 * the project's real babel pipeline emits `__workletHash`, `__closure` and
 * `__pluginVersion: 0.10.3`, so `babel-preset-expo` is applying the worklets
 * plugin and no `babel.config.js` is needed. All three packages are pinned in
 * `package.json` now, at the versions the lockfile already resolved — the same
 * native code, so no rebuild.
 *
 * ## Uniform rows are load-bearing
 *
 * The drop index is `round(translationY / rowHeight)`. Measuring each row would
 * mean a layout pass per row and a shared value per measurement; a queue row is
 * a fixed-height thumbnail and two lines of text, so the division is exact and
 * costs nothing.
 *
 * ## Why the reorder is reported on release
 *
 * The list reflows once, at the end. Reordering continuously would rewrite the
 * store — which is persisted — on every frame of a drag.
 */
export function DraggableList<T>({ items, keyOf, rowHeight, renderItem, onReorder }: Props<T>) {
  const [dragging, setDragging] = useState<number | null>(null)
  const offset = useSharedValue(0)
  /** How many rows the finger has travelled, so still rows can slide out of the
   *  way while the dragged one follows the finger. */
  const shift = useSharedValue(0)
  /** Whether the current gesture ended in a drop rather than a cancellation.
   *  Read by `onFinalize`, which would otherwise spring the row back before the
   *  reorder it just reported has reached the screen (#401). */
  const dropped = useSharedValue(false)

  const finish = useCallback(
    (from: number, to: number) => {
      setDragging(null)
      if (from !== to) onReorder(from, to)
    },
    [onReorder],
  )

  const { range, onLayout } = useRowWindow(items.length, rowHeight, dragging !== null)
  const start = range ? range.start : 0
  const end = range ? range.end : items.length

  /*
   * The rows that are not mounted still take up their space (#503).
   *
   * Two plain `View`s of the exact missing height, which is only possible
   * because every row is `rowHeight` tall — the same uniformity the drag maths
   * depends on. Without them the content would collapse, the scroll bar would
   * be wrong, and scrolling down would run out of list.
   *
   * They are the cheap half of the trade: one `View` stands in for a hundred
   * rows that each carry a shared value, an animated style and two gesture
   * detectors.
   */
  return (
    <View onLayout={onLayout}>
      {start > 0 ? <View testID="window-spacer-top" style={{ height: start * rowHeight }} /> : null}
      {items.slice(start, end).map((item, offsetIndex) => {
        // The absolute index, always. Every index that leaves this component —
        // into `shiftFor`, into `onReorder`, into the caller's `renderItem` —
        // addresses the whole list, so windowing cannot move a reorder by the
        // width of the window.
        const index = start + offsetIndex
        return (
          <DraggableRow
            key={keyOf(item, index)}
            index={index}
            count={items.length}
            rowHeight={rowHeight}
            dragging={dragging}
            offset={offset}
            shift={shift}
            dropped={dropped}
            onStart={setDragging}
            onFinish={finish}
          >
            {renderItem(item, index)}
          </DraggableRow>
        )
      })}
      {end < items.length ? (
        <View testID="window-spacer-bottom" style={{ height: (items.length - end) * rowHeight }} />
      ) : null}
    </View>
  )
}

/**
 * Write a shared value.
 *
 * A module-level function for the same reason `PlayerHost.applyLoudnessGain`
 * is one: `react-hooks/immutability` — rightly — refuses to let a component body
 * mutate a value a hook returned. A Reanimated shared value genuinely *is* a
 * mutable handle whose whole purpose is assignment, so the mutation has to
 * happen somewhere; doing it behind a named function keeps the component
 * declarative and gives the operation a place to be explained.
 */
function write<T>(value: { value: T }, next: T): void {
  'worklet'
  value.value = next
}

/**
 * How many rows a drag of `translationY` moves row `index`.
 *
 * Clamped to the list: a row cannot be dropped above the first position or below
 * the last, and letting it run past either would slide the untouched rows out of
 * the list and hand the store an index that does not exist.
 *
 * A `worklet`, because the gesture callbacks run on the UI thread and calling a
 * plain function from one is what produces "tried to synchronously call a
 * non-worklet function on the UI thread".
 */
export function shiftFor(
  translationY: number,
  rowHeight: number,
  index: number,
  count: number,
): number {
  'worklet'
  const raw = Math.round(translationY / rowHeight)
  return Math.min(Math.max(raw, -index), count - 1 - index)
}

/**
 * Where a dropped row comes to rest, in pixels (#401).
 *
 * Not zero, and not where the finger was. **Zero** is what the row used to do:
 * `onFinalize` cleared the offset on the UI thread the instant the finger
 * lifted, while the reorder reached JavaScript through `runOnJS` and the list
 * re-rendered a frame or more later. I saw exactly that — *"the queue back
 * to where it was, waited about 0.5 second then update"* — a drag that appears
 * to fail and then undo itself, on a reorder that was correct all along.
 *
 * **Where the finger was** is no better: the row would sit a few pixels off its
 * slot and then jump when the list reflowed.
 *
 * So it rests on the **slot it was dropped into**, which is the position the
 * re-rendered list will put it at anyway. The handover then changes no pixels,
 * and the gap stops being visible however long it is.
 */
export function dropOffset(
  translationY: number,
  rowHeight: number,
  index: number,
  count: number,
): number {
  'worklet'
  return shiftFor(translationY, rowHeight, index, count) * rowHeight
}

function DraggableRow({
  index,
  count,
  rowHeight,
  dragging,
  offset,
  shift,
  dropped,
  onStart,
  onFinish,
  children,
}: {
  index: number
  count: number
  rowHeight: number
  dragging: number | null
  offset: ReturnType<typeof useSharedValue<number>>
  shift: ReturnType<typeof useSharedValue<number>>
  dropped: ReturnType<typeof useSharedValue<boolean>>
  onStart: (index: number) => void
  onFinish: (from: number, to: number) => void
  children: ReactNode
}) {
  const isDragging = dragging === index
  const theme = useTheme()
  /** When the finger landed, so the hold before activation can be measured. */
  const beganAt = useSharedValue(0)

  /**
   * A long press starts the drag, not a touch.
   *
   * Rows are tappable — a context row skips to that track — so a pan that
   * activated immediately would make every tap a one-pixel reorder. The long
   * press is also the affordance: nothing else on the row moves under a finger.
   */
  const gesture = Gesture.Pan()
    // Findable by gesture-handler's `fireGestureHandler`, which is the only way
    // to drive this from a test — there is no touch to dispatch, the native side
    // normally supplies the event sequence.
    .withTestId(`drag-${index}`)
    .activateAfterLongPress(LONG_PRESS_MS)
    .onBegin(() => {
      /*
       * `react-hooks/purity` reads this closure as render code. It is not: a
       * gesture callback runs on the UI thread when a finger lands, which is
       * exactly when a clock is the right thing to read — and measuring the
       * hold is the whole point of #448's instrument.
       */
      // eslint-disable-next-line react-hooks/purity
      beganAt.value = Date.now()
    })
    .onStart(() => {
      // eslint-disable-next-line react-hooks/purity -- see `onBegin` above
      runOnJS(noteDragStart)('row', Date.now() - beganAt.value)
      write(offset, 0)
      write(shift, 0)
      write(dropped, false)
      runOnJS(onStart)(index)
    })
    .onUpdate((event) => {
      write(offset, event.translationY)
      write(shift, shiftFor(event.translationY, rowHeight, index, count))
    })
    .onEnd((event) => {
      // Recomputed from the event rather than read back out of `shift`.
      // Both are correct on a device, but the end handler owning its own answer
      // means the drop does not depend on an update having been delivered
      // first — and it is the difference between this being testable and not.
      write(offset, dropOffset(event.translationY, rowHeight, index, count))
      // The row now sits on its destination and stays there until the list has
      // re-rendered in the new order (#401). `onFinalize` runs immediately after
      // this, on the UI thread, while `onFinish` is still on its way to
      // JavaScript — so it must not undo it.
      write(dropped, true)
      runOnJS(onFinish)(index, index + shiftFor(event.translationY, rowHeight, index, count))
    })
    // Fires when the gesture is cancelled rather than finished; without it a
    // drag interrupted by the OS would leave the row stuck under the finger.
    // A drop is not a cancellation: `onEnd` has already parked the row where it
    // landed and reported it, and this would put it back.
    .onFinalize(() => {
      if (dropped.value) return
      write(offset, 0)
      write(shift, 0)
    })

  /**
   * The handle drags **immediately**, with no hold (#379, second attempt).
   *
   * The 120 ms wait exists to tell a drag apart from a tap or a scroll on the
   * *row*, where the gesture is ambiguous. On the handle it is not: a handle is
   * an explicit affordance, and nothing else there responds to a finger. Making
   * it wait bought nothing and left a window in which the outer `ScrollView`
   * could claim the touch.
   *
   * `blocksExternalGesture(rowGesture)` is what keeps this from being two drags
   * at once: the row's pan must wait for this one to fail, so grabbing the
   * handle runs exactly one gesture and reports exactly one reorder. Touching
   * anywhere else never begins this one, and the row behaves as it always did.
   *
   * Two candidate causes, two fixes: this one, and `HANDLE_INSET` above. If the
   * handle still refuses on the next build, the exclusion zone was not it.
   */
  const handleGesture = Gesture.Pan()
    .withTestId(`drag-handle-${index}`)
    // The gesture object, not a ref to it: `convertToHandlerTag` reads
    // `handlerTag` straight off a `BaseGesture`, and a tag exists from
    // construction. A ref would be one indirection, one render-time read that
    // `react-hooks/refs` rightly objects to, and one more thing to be null.
    .blocksExternalGesture(gesture)
    .onBegin(() => {
      /*
       * `react-hooks/purity` reads this closure as render code. It is not: a
       * gesture callback runs on the UI thread when a finger lands, which is
       * exactly when a clock is the right thing to read — and measuring the
       * hold is the whole point of #448's instrument.
       */
      // eslint-disable-next-line react-hooks/purity
      beganAt.value = Date.now()
    })
    .onStart(() => {
      // eslint-disable-next-line react-hooks/purity -- see `onBegin` above
      runOnJS(noteDragStart)('handle', Date.now() - beganAt.value)
      write(offset, 0)
      write(shift, 0)
      write(dropped, false)
      runOnJS(onStart)(index)
    })
    .onUpdate((event) => {
      write(offset, event.translationY)
      write(shift, shiftFor(event.translationY, rowHeight, index, count))
    })
    .onEnd((event) => {
      write(offset, dropOffset(event.translationY, rowHeight, index, count))
      write(dropped, true)
      runOnJS(onFinish)(index, index + shiftFor(event.translationY, rowHeight, index, count))
    })
    .onFinalize(() => {
      if (dropped.value) return
      write(offset, 0)
      write(shift, 0)
    })

  const style = useAnimatedStyle(() => {
    if (dragging === null) return { transform: [{ translateY: 0 }], zIndex: 0 }
    if (isDragging) {
      // The dragged row follows the finger exactly, and sits above the rest.
      return { transform: [{ translateY: offset.value }], zIndex: 2 }
    }
    /*
     * A still row moves by exactly one row-height, and only if the dragged row
     * has crossed it. `from`/`to` describe the span the drag covers; a row
     * inside that span slides one place in the opposite direction.
     */
    const from = dragging
    const to = dragging + shift.value
    const inSpan = index > Math.min(from, to) - 1 && index < Math.max(from, to) + 1
    if (!inSpan) return { transform: [{ translateY: 0 }], zIndex: 0 }
    return { transform: [{ translateY: to > from ? -rowHeight : rowHeight }], zIndex: 0 }
  })

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        // So a test can assert the row *looks* picked up, not merely that the
        // gesture fired. #448's feedback survived a mutation without one.
        testID={`drag-row-${index}`}
        style={[
          styles.row,
          style,
          /*
           * **Visibly** picked up (#448).
           *
           * This was `opacity: 0.9` and nothing else, with a comment explaining
           * that a background colour was impossible because the row is drawn by
           * the caller against whatever the screen uses. That was true when this
           * component knew nothing about the theme; it does now, and
           * `surfacePressed` is the app's one token for "a finger is on this"
           * (#378). *"make its background darker or greyed out, so user
           * know this track is selected"*.
           */
          liftedRowStyle(isDragging, theme),
        ]}
      >
        {/*
         * The affordance the long press never was (#315).
         *
         * This file used to argue that "the long press *is* the affordance:
         * nothing else on the row moves under a finger". That is true and it is
         * not an affordance — it is a thing you find out **after** deciding to
         * try. In practice the only hints were a line of help text and a 120 ms
         * activation, and I asked for the handle every list like this has.
         *
         * Drawn rather than imported: three bars is three views, and an icon
         * font for it would be a dependency for six lines of layout. It is
         * `accessibilityElementsHidden` because it is not a control — the whole
         * row is the drag target, and a screen reader announcing "image" here
         * would be noise.
         *
         * ## On the right, and off the edge (#379)
         *
         * It sat on the left, within a few pixels of the screen edge, and I
         * could not reliably grab it: Android's back gesture owns an inset from
         * both edges and wins the touch before any handler sees it. The whole
         * row has always been the drag target, so this never stopped a drag
         * that started elsewhere — but the handle is where people *aim*, which
         * made the feature look broken.
         *
         * Right is also where every other music app puts it. `HANDLE_INSET`
         * keeps it clear of the opposite edge's inset rather than swapping one
         * problem for its mirror image.
         */}
        <View style={styles.rowBody}>{children}</View>
        <GestureDetector gesture={handleGesture}>
          <View
            testID="drag-handle"
            style={styles.handle}
            accessibilityElementsHidden
            importantForAccessibility="no"
          >
            <View style={styles.handleBar} />
            <View style={styles.handleBar} />
            <View style={styles.handleBar} />
          </View>
        </GestureDetector>
      </Animated.View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  row: { width: '100%', flexDirection: 'row', alignItems: 'center' },
  // The row's own content keeps all the space the handle does not take.
  rowBody: { flex: 1, minWidth: 0 },
  handle: {
    width: 28,
    paddingVertical: 12,
    // Clear of the edge Android's back gesture claims (#379).
    marginRight: HANDLE_INSET,
    gap: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleBar: { width: 14, height: 2, borderRadius: 1, backgroundColor: '#9ca3af' },
})
