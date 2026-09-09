import { act, render, screen } from '@testing-library/react-native'
import { GestureHandlerRootView, State } from 'react-native-gesture-handler'
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils'
import { StyleSheet, Text } from 'react-native'

import { DraggableList, dropOffset } from '../src/components/DraggableList'
import { useDiagnostics } from '../src/diagnostics/log'

/**
 * Drag to reorder (#233).
 *
 * `docs/history/test-preparation.md` note 5 asked for gesture-handler and Reanimated to
 * be proved before anything was built on them. They were — transforming a
 * `useSharedValue`/`useAnimatedStyle` component through the project's real babel
 * pipeline emits `__workletHash` and `__pluginVersion: 0.10.3`, so the worklets
 * plugin is applied and no `babel.config.js` is needed. This file is the second
 * half of that: proving the gesture actually reports what the list should do.
 *
 * Gestures are driven with gesture-handler's own `fireGestureHandler`, which
 * feeds the handler the event sequence the native side would. The pan needs a
 * `withTestId` to be findable, which is why the component tags it.
 *
 * **`runOnJS` is asynchronous**, even under jest: the handler runs, and the
 * JS-thread callback it schedules lands a tick later. Asserting straight after
 * `fireGestureHandler` sees nothing and reads as "the gesture did not fire",
 * which is why every drag here is followed by a flush.
 */
async function drag(testId: string, translationY: number) {
  fireGestureHandler(getByGestureTestId(testId), [
    { state: State.BEGAN, translationY: 0 },
    { state: State.ACTIVE, translationY },
    { state: State.END, translationY },
  ])
  await act(async () => {})
}

const ITEMS = ['A', 'B', 'C', 'D']

function renderList(onReorder: jest.Mock, rowHeight = 50) {
  return render(
    <GestureHandlerRootView>
      <DraggableList
        items={ITEMS}
        keyOf={(item) => item}
        rowHeight={rowHeight}
        onReorder={onReorder}
        renderItem={(item) => <Text>{item}</Text>}
      />
    </GestureHandlerRootView>,
  )
}

describe('DraggableList', () => {
  it('renders every row', async () => {
    await renderList(jest.fn())

    for (const item of ITEMS) expect(screen.getByText(item)).toBeTruthy()
  })

  it('reports a drop one row down', async () => {
    const onReorder = jest.fn()
    await renderList(onReorder)

    // Row 0, dragged down by exactly one row height.
    await drag('drag-0', 50)

    expect(onReorder).toHaveBeenCalledWith(0, 1)
  })

  it('rounds to the nearest row, so a half-drag still lands somewhere', async () => {
    const onReorder = jest.fn()
    await renderList(onReorder)

    await drag('drag-0', 130)

    // 130 / 50 = 2.6 → three rows down.
    expect(onReorder).toHaveBeenCalledWith(0, 3)
  })

  it('cannot drop a row past the end of the list', async () => {
    const onReorder = jest.fn()
    await renderList(onReorder)

    await drag('drag-2', 1000)

    // Clamped to the last index. Unclamped, the still rows would slide out of
    // the list and the store would be handed an index that does not exist.
    expect(onReorder).toHaveBeenCalledWith(2, 3)
  })

  it('cannot drop a row above the first', async () => {
    const onReorder = jest.fn()
    await renderList(onReorder)

    await drag('drag-1', -1000)

    expect(onReorder).toHaveBeenCalledWith(1, 0)
  })

  it('says nothing when a row is put back where it started', async () => {
    const onReorder = jest.fn()
    await renderList(onReorder)

    await drag('drag-1', 12)

    // A twelve-pixel wobble is not a reorder. Reporting it would rewrite a
    // persisted store for nothing.
    expect(onReorder).not.toHaveBeenCalled()
  })
})

/**
 * The drag handle (#315).
 *
 * This file's component used to argue that "the long press *is* the affordance:
 * nothing else on the row moves under a finger". True, and not an affordance —
 * it is something you learn **after** deciding to try. The only hints were a
 * line of help text and a 120 ms activation.
 */
describe('the drag affordance', () => {
  it('draws a handle on every row', async () => {
    await renderList(jest.fn())

    // Three bars, drawn rather than imported: an icon font for six lines of
    // layout would be a dependency for nothing.
    expect(screen.getAllByTestId('drag-handle', { includeHiddenElements: true })).toHaveLength(
      ITEMS.length,
    )
  })

  it('puts the handle on the right, clear of the back-gesture edge (#379)', async () => {
    /*
     * I could not reliably grab it. It sat on the left within a few pixels
     * of the screen edge, and Android's back gesture owns an inset from both
     * edges — it wins the touch before any handler sees it. The whole row has
     * always been the drag target, so this never blocked a drag that began
     * elsewhere; the handle is just where people aim.
     *
     * Asserted as *order within the row* rather than as a coordinate, because
     * jest performs no layout — a pixel position here would be one the test
     * made up.
     */
    await renderList(jest.fn())

    const row = screen.getAllByTestId('drag-handle', { includeHiddenElements: true })[0].parent!
    const children = row.children as { props?: { testID?: string } }[]
    const handleAt = children.findIndex((child) => child.props?.testID === 'drag-handle')

    expect(handleAt).toBe(children.length - 1)
  })

  it('keeps the handle off the edge it moved to', async () => {
    // Right is where every other music app puts it — but the back gesture
    // claims an inset from *both* sides, so moving it without an inset would
    // swap one problem for its mirror image.
    await renderList(jest.fn())

    const handle = screen.getAllByTestId('drag-handle', { includeHiddenElements: true })[0]
    const style = StyleSheet.flatten(handle.props.style) as { marginRight?: number }

    expect(style.marginRight).toBeGreaterThan(0)
  })

  it('leaves the handle out of the accessibility tree', async () => {
    await renderList(jest.fn())

    // The whole row is the drag target, so a screen reader announcing a
    // decorative image beside every row would be noise.
    expect(screen.queryAllByTestId('drag-handle')).toHaveLength(0)
  })

  it('still reports a drop, with the handle in the row', async () => {
    const onReorder = jest.fn()
    await renderList(onReorder)

    await drag('drag-0', 50)

    // The handle changed the row's layout — it is a flex row now — so the drag
    // itself is re-checked rather than assumed unaffected.
    expect(onReorder).toHaveBeenCalledWith(0, 1)
  })
})

/**
 * Where a dropped row rests (#401), from the 2026-08-08 device pass.
 *
 * *"when i quickly drag the top song on queue to somewhere else, release
 * it, the queue back to where it was, waited about 0.5 second then update the
 * queue."* The reorder was right the whole time; what I saw was the row
 * springing home on the UI thread the instant the finger lifted, because
 * `onFinalize` cleared the offset while `onFinish` was still crossing to
 * JavaScript through `runOnJS`.
 *
 * The rest position is the testable half. Whether the handover is *visible* is a
 * question about frames, and jest has none — so this pins the arithmetic that
 * makes the handover change no pixels, the way `swipeTravel` and `gainAt` are
 * pinned for the gestures around them.
 */
describe('where a dropped row rests', () => {
  it('rests on the slot it was dropped into, not back where it started', () => {
    // The old behaviour is exactly `0` here, which is why that is the assertion
    // worth writing down.
    expect(dropOffset(50, 50, 0, 4)).toBe(50)
  })

  it('rests on the slot, not under the finger', () => {
    // 130 px is two and a half rows and lands three rows down; resting at 130
    // would leave the row 20 px above its slot and jump when the list reflowed.
    expect(dropOffset(130, 50, 0, 4)).toBe(150)
  })

  it('rests where the clamp actually put it', () => {
    // Dragged far past the end: the row lands on the last slot, so it must rest
    // there rather than a thousand pixels down the screen.
    expect(dropOffset(1000, 50, 2, 4)).toBe(50)
  })

  it('rests at zero when the row goes back where it came from', () => {
    // A twelve-pixel wobble reorders nothing, and the row is already home.
    expect(dropOffset(12, 50, 1, 4)).toBe(0)
  })
})

/**
 * The handle drags, and drags without waiting (#379, second attempt).
 *
 * 2026-08-09: *"we drag a track by press and hold the 3 bar line icon at
 * the right end of the track, but it dont work now. now we just press and hold
 * anywhere on the track but the 3 bar icon"* — the one place people aim was the
 * one place that did nothing.
 *
 * Two candidates, and they need different fixes. The margin was **12 dp**
 * against a system back-gesture zone that is 24 dp by default and wider at high
 * sensitivity, so the handle shared a strip with the operating system; and the
 * handle inherited the row's 120 ms hold, which leaves a window for the
 * `ScrollView` above to claim the touch. Both are addressed. Only the second is
 * testable here — jest performs no layout and knows nothing of Android's
 * exclusion zones — so the margin is asserted as a number, the way #379's own
 * test does it.
 */
describe('dragging by the handle', () => {
  it('reorders from the handle, with no hold at all', async () => {
    const onReorder = jest.fn()
    await renderList(onReorder)

    // No `activateAfterLongPress`: the sequence is the same one `drag()` uses,
    // and a handle that needed the hold would still report this. What it proves
    // is that the handle has a gesture of its own at all — before this, the only
    // handler on the row was the row's.
    await drag('drag-handle-0', 50)

    expect(onReorder).toHaveBeenCalledWith(0, 1)
  })

  it('blocks the row gesture, so one drag is not two reorders', async () => {
    /*
     * The handle's detector is nested inside the row's, so without
     * `blocksExternalGesture` a drag on the handle would activate both and
     * reorder twice — on a persisted queue that is corruption, not a cosmetic
     * bug.
     *
     * Asserted on the **configuration** rather than by driving a drag, and the
     * distinction is the point: `fireGestureHandler` dispatches to one handler
     * by id and never arbitrates between two, so a drag test here passes
     * whether the dependency is declared or not. It did — removing the line
     * killed nothing, which is the "the test's scenario is wrong" case in
     * `docs/lessons.md`. Real arbitration is native and needs a device.
     */
    await renderList(jest.fn())

    const handle = getByGestureTestId('drag-handle-0') as unknown as {
      config: { blocksHandlers?: unknown[] }
    }

    expect(handle.config.blocksHandlers).toHaveLength(1)
  })

  it('keeps the handle clear of the system gesture strip', async () => {
    // 24 dp is Android's default back-gesture exclusion; high sensitivity is
    // wider still. The old 12 left half the handle inside it.
    await renderList(jest.fn())

    const handle = screen.getAllByTestId('drag-handle', { includeHiddenElements: true })[0]
    const style = StyleSheet.flatten(handle.props.style) as { marginRight?: number }

    expect(style.marginRight).toBeGreaterThanOrEqual(24)
  })

  it('still reorders from the row itself', async () => {
    // The handle is a shortcut, never the only way — the same rule #377's UI 9
    // states for every gesture in this app.
    const onReorder = jest.fn()
    await renderList(onReorder)

    await drag('drag-0', 50)

    expect(onReorder).toHaveBeenCalledWith(0, 1)
  })
})

/**
 * Saying which gesture started a drag, and how long it took (#448).
 *
 * The handle has been fixed twice — #315 added it, #379 moved it off the edge
 * Android's back gesture claims *and* made it activate with no hold — and I
 * reports it still needs a long press. Two failed attempts, so this measures
 * instead of guessing a third time.
 *
 * The two answers need opposite fixes: `handle` means the handle's own gesture
 * ran and something else is slow; `row` means the handle never got the touch and
 * the 120 ms long press is what is actually being felt.
 */
describe('which gesture started the drag', () => {
  beforeEach(() => {
    useDiagnostics.setState({ entries: [] })
  })

  it('says when the handle started it', async () => {
    const onReorder = jest.fn()
    // Awaited, like every other render here: gesture handlers register on the
    // flush, and `getByGestureTestId` finds nothing without it.
    await renderList(onReorder)

    await drag('drag-handle-0', 50)

    const entry = useDiagnostics.getState().entries.find((e) => e.event === 'queue.dragStarted')
    expect(entry?.detail).toContain('via=handle')
  })

  it('says when the row started it instead', async () => {
    const onReorder = jest.fn()
    // Awaited, like every other render here: gesture handlers register on the
    // flush, and `getByGestureTestId` finds nothing without it.
    await renderList(onReorder)

    await drag('drag-0', 50)

    // The instrument has to be able to print the other answer, or it has
    // measured nothing — the lesson #371's `running=false` cost a day.
    const entry = useDiagnostics.getState().entries.find((e) => e.event === 'queue.dragStarted')
    expect(entry?.detail).toContain('via=row')
  })

  it('reports how long the finger was held before it took over', async () => {
    const onReorder = jest.fn()
    // Awaited, like every other render here: gesture handlers register on the
    // flush, and `getByGestureTestId` finds nothing without it.
    await renderList(onReorder)

    await drag('drag-handle-0', 50)

    // The number is the complaint — "still have to long press it for some
    // time" — measured rather than described.
    const entry = useDiagnostics.getState().entries.find((e) => e.event === 'queue.dragStarted')
    expect(entry?.detail).toMatch(/held=\d+ms/)
  })
})
