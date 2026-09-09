import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'

import { Button } from '../src/components/ui/Button'
import { Chip } from '../src/components/ui/Chip'
import { DEFAULT_ACCENT, buildTheme } from '../src/theme'

/**
 * Affordance and feedback (#378).
 *
 * Two different jobs, tested separately: a control has to *look* pressable
 * before it is touched, and has to visibly react while it is held.
 *
 * ## Holding a finger down, in jest
 *
 * `Pressable` tracks pressed state through React Native's **responder system**,
 * so none of the obvious approaches work and two were tried first:
 *
 * - `fireEvent(el, 'pressIn')` does nothing — the host view has no `onPressIn`
 *   prop for it to find, only responder handlers.
 * - Calling the `style` function directly needs the `Pressable` element, and
 *   RNTL 14 removed `UNSAFE_getByType`. Reading `getByRole('button')` instead
 *   gets the host view React Native has **already resolved**, whose `style` is a
 *   plain object — so the function branch never ran and every assertion here
 *   passed against a Button with no pressed styles at all. The test was
 *   measuring its own argument.
 *
 * `responderGrant` is what actually reaches `Pressability`, which is why the
 * helper below fires that. The resolved style then genuinely changes, and every
 * assertion is mutation-checked against a component with its pressed styles
 * deleted — because this file has already produced one false green.
 */

/** A responder event carrying the fields `Pressability` reads. */
const grant = {
  nativeEvent: {
    touches: [],
    changedTouches: [],
    identifier: 1,
    locationX: 0,
    locationY: 0,
    pageX: 0,
    pageY: 0,
    target: 1,
    timestamp: 0,
  },
  currentTarget: 1,
  dispatchConfig: {},
  persist: () => {},
}

function resolved() {
  return StyleSheet.flatten(screen.getByRole('button').props.style) as Record<string, unknown>
}

/** The background colour at rest, then with a finger held on it. */
async function fillAtRestAndHeld() {
  const resting = resolved().backgroundColor
  await act(async () => {
    fireEvent(screen.getByRole('button'), 'responderGrant', grant)
  })
  return { resting, held: resolved().backgroundColor }
}

// The palette the components themselves resolve to under jest: the store's
// default accent, and light mode because `useColorScheme` answers null here.
const theme = buildTheme(false, DEFAULT_ACCENT)

/** Android's documented minimum touch target, and the number every
 *  assertion below is written against rather than repeating a literal. */
const ANDROID_MIN_TARGET_DP = 48

describe('Button', () => {
  it('calls back when pressed', async () => {
    const onPress = jest.fn()
    await render(<Button label="Save" onPress={onPress} />)

    fireEvent.press(screen.getByText('Save'))

    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it.each(['filled', 'outlined', 'plain'] as const)(
    'changes colour under a finger in the %s variant',
    async (variant) => {
      await render(<Button label="Go" onPress={jest.fn()} variant={variant} />)

      // `plain` is the one that matters most: it replaces 30 uses of a
      // per-screen `styles.link` that was accent-coloured text and nothing else
      // — no fill, no box, and no reaction to being touched.
      const { resting, held } = await fillAtRestAndHeld()

      expect(held).toBeDefined()
      expect(held).not.toBe(resting)
    },
  )

  it('is big enough to hit', async () => {
    // Several of the text links this replaces were a 13px line of text and
    // nothing else — about half Android's minimum target.
    //
    // ⚠️ **This asserted 44 and passed for months against a button that was
    // under the minimum.** 44 is Apple's figure; Android and Material 3 both
    // say 48 dp, and a device pass measured the Settings buttons at 43.8 dp
    // (#519). The test was evidence about what somebody believed, not about
    // what is correct — #575's lesson, a second time.
    await render(<Button label="Change server" onPress={jest.fn()} variant="plain" />)

    expect(resolved().minHeight).toBeGreaterThanOrEqual(ANDROID_MIN_TARGET_DP)
  })

  it('does not react, or fire, while disabled', async () => {
    const onPress = jest.fn()
    await render(<Button label="Save" onPress={onPress} disabled />)

    fireEvent.press(screen.getByRole('button'))
    const { resting, held } = await fillAtRestAndHeld()

    expect(onPress).not.toHaveBeenCalled()
    // A disabled button that lit up under a finger would be claiming it had
    // heard something it is going to ignore.
    expect(held).toBe(resting)
  })

  it('says it is busy rather than merely unavailable', async () => {
    const onPress = jest.fn()
    await render(<Button label="Save" onPress={onPress} busy />)

    fireEvent.press(screen.getByRole('button'))

    expect(onPress).not.toHaveBeenCalled()
    // Two different sentences for a screen reader, which is why `busy` is not
    // folded into `disabled`.
    expect(screen.getByRole('button').props.accessibilityState).toMatchObject({
      busy: true,
      disabled: true,
    })
    // The label goes with it: a spinner beside the word "Save" reads as a button
    // you could press again.
    expect(screen.queryByText('Save')).toBeNull()
  })

  it('keeps the label as its accessible name unless told otherwise', async () => {
    await render(<Button label="Save" onPress={jest.fn()} />)

    expect(screen.getByLabelText('Save')).toBeTruthy()
  })
})

describe('Chip', () => {
  it('reports selection to a screen reader, not just to the eye', async () => {
    await render(<Chip label="Dark" onPress={jest.fn()} selected />)

    expect(screen.getByRole('button').props.accessibilityState).toMatchObject({ selected: true })
  })

  it.each([
    [false, theme.surfacePressed],
    [true, theme.accentSolidPressed],
  ])('uses the right pressed token when selected=%s', async (selected, expected) => {
    /*
     * Named tokens rather than "the colour changed".
     *
     * "Changed" was the first version of this assertion and a chip that applied
     * the *unselected* pressed fill to a selected chip passed it — the accent
     * fill and the grey fill differ, so something did change; it was just the
     * wrong thing, and would read as the chip losing its selection mid-press.
     * Pressing an already-selected chip is ordinary, so it has to be right.
     */
    await render(<Chip label="Dark" onPress={jest.fn()} selected={selected} />)

    const { resting, held } = await fillAtRestAndHeld()

    expect(held).not.toBe(resting)
    expect(held).toBe(expected)
  })
})
