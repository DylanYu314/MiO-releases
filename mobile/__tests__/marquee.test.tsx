import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { MarqueeText, marqueeRun } from '../src/components/MarqueeText'

/**
 * The scrolling title for the playing track (#306).
 *
 * I asked for it on the playing track **only** — "not every track" — so the
 * component is opt-in and the rows in a list keep their ellipsis.
 *
 * The decision (does this move, and how far) is a pure function and is tested
 * exactly, for the same reason `crossfade.ts` splits its curve out: the other
 * half is a Reanimated shared value on the UI thread, which a test can only see
 * through several layers of mock. Everything worth getting wrong is in the
 * function.
 */

/**
 * Report the two widths, through the two events the real thing uses.
 *
 * The content width arrives on the **ScrollView's `onContentSizeChange`**, not
 * from an `onLayout` on the text. That distinction is the whole of the bug this
 * component shipped with: a `<Text numberOfLines={1}>` measured inside a
 * constrained parent reports the width it was *given*, truncated, so the
 * overflow was always zero and the marquee never ran. A horizontal ScrollView
 * measures its content with no width constraint, which is the only way to learn
 * how wide the string actually is.
 *
 * **jest performs no layout**, so both numbers here are invented by the test.
 * These render cases are smoke tests; `marqueeRun` above is where the behaviour
 * is actually pinned, and only a device could have caught the measurement.
 */
async function measure(viewport: number, content: number) {
  await act(async () => {
    fireEvent(screen.getByTestId('marquee-viewport'), 'layout', {
      nativeEvent: { layout: { width: viewport, height: 20, x: 0, y: 0 } },
    })
    fireEvent(screen.getByTestId('marquee-viewport'), 'contentSizeChange', content, 20)
  })
}

describe('deciding whether a title has to move', () => {
  it('stays still when the text fits', () => {
    expect(marqueeRun(180, 300, false)).toBeNull()
  })

  it('moves by exactly the part that does not fit', () => {
    const run = marqueeRun(500, 300, false)

    expect(run?.distance).toBe(200)
  })

  it('takes longer for a longer title, so the speed is the same either way', () => {
    const short = marqueeRun(400, 300, false)
    const long = marqueeRun(500, 300, false)

    // 32 points a second: 100pt takes 3.125s, 200pt takes twice that. A fixed
    // duration would make a very long title unreadably fast.
    expect(short?.durationMs).toBeCloseTo(3125, 0)
    expect(long?.durationMs).toBeCloseTo(short!.durationMs * 2, 0)
  })

  it('ignores a single point of overflow', () => {
    // Measured widths are floats, and text that fits exactly lands a fraction
    // over. Animating that is a title that twitches forever.
    expect(marqueeRun(300.6, 300, false)).toBeNull()
  })

  it('does nothing until both boxes have been measured', () => {
    // The two `onLayout`s arrive a frame apart, and a content width against a
    // viewport of zero looks like enormous overflow.
    expect(marqueeRun(500, 0, false)).toBeNull()
    expect(marqueeRun(0, 300, false)).toBeNull()
  })

  it('stays still for someone who has asked their phone to stop animating', () => {
    // A title that scrolls with no way to stop it is the exact complaint
    // reduce-motion exists to answer.
    expect(marqueeRun(500, 300, true)).toBeNull()
  })
})

describe('MarqueeText', () => {
  it('shows the title', async () => {
    await render(<MarqueeText>A Very Long Song Title Indeed</MarqueeText>)

    expect(screen.getByText('A Very Long Song Title Indeed')).toBeTruthy()
  })

  it('still shows a title that has to scroll, rather than clipping it away', async () => {
    await render(<MarqueeText>周杰倫 稻香 Rice Field (Official Music Video)</MarqueeText>)
    await measure(300, 900)

    expect(screen.getByText('周杰倫 稻香 Rice Field (Official Music Video)')).toBeTruthy()
  })

  it('cannot be scrolled by hand, and swallows no touches', async () => {
    await render(<MarqueeText>A Very Long Song Title Indeed</MarqueeText>)

    // The ScrollView is here to *measure*; it is not a control. Both matter on
    // the now-playing bar, which is one big `Pressable` — a live scroll view in
    // the middle of it would eat the tap that opens the playing panel, and
    // dragging the title sideways would look like a broken gesture.
    const viewport = screen.getByTestId('marquee-viewport')
    expect(viewport.props.scrollEnabled).toBe(false)
    expect(viewport.props.pointerEvents).toBe('none')
  })
})
