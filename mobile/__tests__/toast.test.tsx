import { act, render, screen } from '@testing-library/react-native'

import { Toast, showToast, useToast } from '../src/components/Toast'
import '../src/i18n'

/**
 * A confirmation that appears and goes (#379).
 *
 * Swiping a row to queue it did the thing and said nothing, which on a gesture
 * with no visible result is indistinguishable from a gesture that missed.
 */

beforeEach(() => {
  jest.useFakeTimers()
  // Module-level, so one test's message outlives it into the next.
  useToast.setState({ message: null })
})

afterEach(() => {
  jest.useRealTimers()
})

describe('Toast', () => {
  it('shows nothing until there is something to say', async () => {
    await render(<Toast />)

    expect(screen.toJSON()).toBeNull()
  })

  it('says what it was given, from anywhere', async () => {
    await render(<Toast />)

    await act(async () => {
      showToast('Queued “Blue”')
    })

    expect(screen.getByText('Queued “Blue”')).toBeTruthy()
  })

  it('goes away on its own', async () => {
    await render(<Toast />)
    await act(async () => {
      showToast('Queued “Blue”')
    })

    await act(async () => {
      jest.advanceTimersByTime(2200)
    })

    // A confirmation that stays is no longer a confirmation, it is furniture.
    expect(screen.queryByText('Queued “Blue”')).toBeNull()
  })

  it('is still up just before its time', async () => {
    // Without this, a Toast that hid itself immediately would satisfy the test
    // above forever.
    await render(<Toast />)
    await act(async () => {
      showToast('Queued “Blue”')
    })

    await act(async () => {
      jest.advanceTimersByTime(2199)
    })

    expect(screen.getByText('Queued “Blue”')).toBeTruthy()
  })

  it('gives a replacement message its full time rather than the remainder', async () => {
    await render(<Toast />)
    await act(async () => {
      showToast('First')
    })
    await act(async () => {
      jest.advanceTimersByTime(2000)
    })

    await act(async () => {
      showToast('Second')
    })
    await act(async () => {
      jest.advanceTimersByTime(1000)
    })

    // The first message's timer would otherwise fire 200ms into the second's
    // life and take it down with it.
    expect(screen.getByText('Second')).toBeTruthy()
    expect(screen.queryByText('First')).toBeNull()
  })

  it('does not interrupt a screen reader mid-sentence', async () => {
    await render(<Toast />)
    await act(async () => {
      showToast('Queued “Blue”')
    })

    expect(screen.getByText('Queued “Blue”').props.accessibilityLiveRegion).toBe('polite')
  })
})
