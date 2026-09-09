import { act, render, screen } from '@testing-library/react-native'
import { GestureHandlerRootView, State } from 'react-native-gesture-handler'
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils'
import { ScrollView, Text } from 'react-native'

import { DraggableList, useRowWindow } from '../src/components/DraggableList'
import {
  ScrollWindowProvider,
  useScrollWindowSource,
  windowFor,
} from '../src/components/ScrollWindow'

/**
 * Only the rows near the viewport are mounted (#503).
 *
 * The queue screen opened in `toCommit=475ms toFrame=775ms` with a 133-row
 * context queue, because `DraggableList` mounted every row — each with a
 * reanimated shared value, an animated style and two gesture detectors. This
 * covers the fix and, more importantly, the thing the fix could break.
 *
 * ⚠️ **The hazard is the drag maths.** `shiftFor` turns a gesture into an index
 * by dividing by `rowHeight`, and both it and `onReorder` address the *whole*
 * list. If windowing ever passed the offset within the window instead of the
 * absolute index, a reorder would land in the wrong place by however far the
 * list is scrolled — and a test that renders a short list would never see it,
 * because with a short list the two are equal. So the reorder assertions here
 * are deliberately made against a **scrolled** window, where they differ.
 *
 * ⚠️ **jest performs no layout**, so nothing here measures itself: the viewport
 * and each list's position are supplied by firing `onLayout`/`onScroll` by
 * hand. That is the same limitation that shipped a marquee which never moved
 * (#306) — it makes this a test of the arithmetic and the wiring, not of the
 * geometry on a device.
 */

const ROW_HEIGHT = 50
const VIEWPORT_HEIGHT = 200

/** Long enough that a window is a small fraction of it. */
const ITEMS = Array.from({ length: 60 }, (_, i) => `row-${i}`)

async function drag(testId: string, translationY: number) {
  fireGestureHandler(getByGestureTestId(testId), [
    { state: State.BEGAN, translationY: 0 },
    { state: State.ACTIVE, translationY },
    { state: State.END, translationY },
  ])
  await act(async () => {})
}

/**
 * A scroll container that publishes its viewport, driven from the test.
 *
 * The source is captured so the test can push a scroll offset without a real
 * scroll: `onScroll` is the same handler the `ScrollView` would call.
 */
function Harness({
  onReorder,
  windowed = true,
  captureSource,
}: {
  onReorder: (from: number, to: number) => void
  windowed?: boolean
  captureSource?: (source: ReturnType<typeof useScrollWindowSource>) => void
}) {
  const source = useScrollWindowSource()
  captureSource?.(source)

  const list = (
    <DraggableList
      items={ITEMS}
      keyOf={(item) => item}
      rowHeight={ROW_HEIGHT}
      onReorder={onReorder}
      renderItem={(item) => <Text>{item}</Text>}
    />
  )

  return (
    <GestureHandlerRootView>
      {windowed ? (
        <ScrollWindowProvider source={source}>
          <ScrollView onScroll={source.onScroll} onLayout={source.onLayout}>
            {list}
          </ScrollView>
        </ScrollWindowProvider>
      ) : (
        <ScrollView>{list}</ScrollView>
      )}
    </GestureHandlerRootView>
  )
}

type Source = ReturnType<typeof useScrollWindowSource>

/**
 * Renders the harness and reports the viewport, as the container would.
 *
 * ⚠️ **`render` has to be awaited.** It renders concurrently and wraps itself in
 * an `act` that is still open when it returns, so the component body has not run
 * yet: `captureSource` is unset and reading it gives `null`, while a *separate*
 * `act` on top produces "overlapping act() calls" rather than a flush. This is
 * why `draggableList.test.tsx` awaits its own `renderList`, which reads like a
 * formality and is not one.
 */
async function renderWindowed(onReorder = jest.fn(), windowed = true) {
  let source: Source | null = null
  await render(
    <Harness onReorder={onReorder} windowed={windowed} captureSource={(s) => (source = s)} />,
  )

  await act(async () => {
    source!.onLayout({ nativeEvent: { layout: { height: VIEWPORT_HEIGHT, y: 0 } } } as never)
  })

  return {
    onReorder,
    scrollTo: async (y: number) => {
      await act(async () => {
        source!.onScroll({ nativeEvent: { contentOffset: { y } } } as never)
      })
    },
  }
}

/** How many rows are actually mounted right now. */
function mountedRows(): number {
  return ITEMS.filter((item) => screen.queryByText(item) !== null).length
}

describe('windowFor', () => {
  it('covers the viewport plus the overscan on each side', () => {
    // Scrolled 500px into a list starting at 0: rows 10..13 are visible.
    expect(windowFor(500, 200, 0, 50, 60, 6)).toEqual({ start: 4, end: 20 })
  })

  it('does not run off either end of the list', () => {
    expect(windowFor(0, 200, 0, 50, 60, 6)).toEqual({ start: 0, end: 10 })
    expect(windowFor(10_000, 200, 0, 50, 60, 6)).toEqual({ start: 60, end: 60 })
  })

  it('subtracts the list position, so a list further down the page is not skipped', () => {
    // The same scroll, but the list itself starts 500px down: the viewport is
    // at the very top of it.
    expect(windowFor(500, 200, 500, 50, 60, 6)).toEqual({ start: 0, end: 10 })
  })

  it('renders everything when the viewport has not been measured', () => {
    // Height 0 is what a container reports before layout. Windowing on it would
    // paint an empty list on the first frame.
    expect(windowFor(0, 0, 0, 50, 60, 6)).toEqual({ start: 0, end: 60 })
  })
})

describe('DraggableList windowing', () => {
  it('mounts only the rows near the viewport', async () => {
    await renderWindowed()

    expect(mountedRows()).toBeLessThan(ITEMS.length)
    expect(screen.getByText('row-0')).toBeTruthy()
    expect(screen.queryByText('row-59')).toBeNull()
  })

  it('mounts every row when no scroll container publishes a viewport', async () => {
    // The playlist screen, and every test written before #503.
    await renderWindowed(jest.fn(), false)

    expect(mountedRows()).toBe(ITEMS.length)
  })

  it('follows the viewport as it scrolls', async () => {
    const { scrollTo } = await renderWindowed()

    await scrollTo(1500) // rows 30..33 visible

    expect(screen.getByText('row-30')).toBeTruthy()
    expect(screen.queryByText('row-0')).toBeNull()
  })

  /*
   * The property windowing could silently break. Row 30 is only mounted because
   * the list is scrolled to it; dragging it one row down must report (30, 31)
   * and not (0, 1) — which is what an offset-within-the-window would report,
   * since row 30 is the first row of this window.
   */
  it('reports absolute indices from a scrolled window', async () => {
    const onReorder = jest.fn()
    const { scrollTo } = await renderWindowed(onReorder)

    await scrollTo(1500)
    await drag('drag-30', ROW_HEIGHT)

    expect(onReorder).toHaveBeenCalledWith(30, 31)
  })

  /*
   * The unmounted rows still have to occupy their space, or the content shrinks
   * to the size of the window: the scroll bar would be wrong and scrolling down
   * would run out of list before the list did. Only checkable because every row
   * is exactly `rowHeight` tall — the same uniformity the drag maths needs.
   */
  it('reserves the exact height of the rows it did not mount', async () => {
    const { scrollTo } = await renderWindowed()
    await scrollTo(1500)

    // The window here is rows 24..40, from `windowFor` above.
    expect(screen.getByTestId('window-spacer-top').props.style.height).toBe(24 * ROW_HEIGHT)
    expect(screen.getByTestId('window-spacer-bottom').props.style.height).toBe(
      (ITEMS.length - 40) * ROW_HEIGHT,
    )
  })

  it('clamps against the whole list, not against the window', async () => {
    const onReorder = jest.fn()
    const { scrollTo } = await renderWindowed(onReorder)

    await scrollTo(1500)
    // Far enough to leave the window entirely. The clamp in `shiftFor` is
    // `count - 1 - index`, so this must stop at the last row of the *list*.
    await drag('drag-30', ROW_HEIGHT * 100)

    expect(onReorder).toHaveBeenCalledWith(30, ITEMS.length - 1)
  })
})

/*
 * The freeze is tested through the hook, not through a rendered list.
 *
 * `fireGestureHandler` completes a gesture as it dispatches it, so a drag is
 * already over by the time anything can be asserted — the same reason
 * `liftedRowStyle` exists as a function rather than as an assertion about a
 * transient style. `frozen` is the input that decides, so `frozen` is what this
 * drives.
 */
describe('useRowWindow while a drag is in progress', () => {
  function Probe({ frozen }: { frozen: boolean }) {
    const { range, onLayout } = useRowWindow(ITEMS.length, ROW_HEIGHT, frozen)
    // The layout is reported once, as a real list's would be.
    return <Text onLayout={onLayout}>{range ? `${range.start}-${range.end}` : 'all'}</Text>
  }

  // Handed out through a prop, like `Harness` does. `react-hooks` refuses a
  // component body that writes to anything outside itself — correctly, since
  // that is a render side effect — and calling a callback prop is the way past
  // it that does not pretend the rule is wrong.
  function Host({ frozen, capture }: { frozen: boolean; capture: (source: Source) => void }) {
    const source = useScrollWindowSource()
    capture(source)
    return (
      <ScrollWindowProvider source={source}>
        <Probe frozen={frozen} />
      </ScrollWindowProvider>
    )
  }

  async function renderProbe() {
    let captured: Source | null = null
    const capture = (source: Source) => {
      captured = source
    }
    const view = await render(<Host frozen={false} capture={capture} />)
    await act(async () => {
      captured!.onLayout({
        nativeEvent: { layout: { height: VIEWPORT_HEIGHT, y: 0 } },
      } as never)
    })

    return {
      scrollTo: async (y: number) => {
        await act(async () => {
          captured!.onScroll({ nativeEvent: { contentOffset: { y } } } as never)
        })
      },
      setFrozen: async (frozen: boolean) => {
        await view.rerender(<Host frozen={frozen} capture={capture} />)
      },
    }
  }

  it('follows the viewport while nothing is being dragged', async () => {
    const { scrollTo } = await renderProbe()

    await scrollTo(1500)

    expect(screen.getByText('24-40')).toBeTruthy()
  })

  it('holds the window it had when the drag began', async () => {
    const { scrollTo, setFrozen } = await renderProbe()
    await scrollTo(1500)

    await setFrozen(true)
    await scrollTo(0)

    // Unchanged: the dragged row is still mounted, under the finger.
    expect(screen.getByText('24-40')).toBeTruthy()
  })

  it('catches up once the drag ends', async () => {
    const { scrollTo, setFrozen } = await renderProbe()
    await scrollTo(1500)
    await setFrozen(true)
    await scrollTo(0)

    await setFrozen(false)

    // Re-subscribing delivers the current viewport immediately, so the list
    // does not stay stranded at the old window until the next scroll.
    expect(screen.getByText('0-10')).toBeTruthy()
  })
})
