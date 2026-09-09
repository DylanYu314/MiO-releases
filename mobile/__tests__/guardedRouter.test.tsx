import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { useState } from 'react'
import { Pressable, Text } from 'react-native'

import { useGuardedRouter } from '../src/navigation/useGuardedRouter'

/**
 * One navigation per press (#375).
 *
 * The bug is in `expo-router`'s own queue, not in a slow phone: `router.push`
 * appends to `routingQueue` and a `useEffect` later dispatches **everything**
 * the queue holds. Two presses before that flush are two screens.
 *
 * These drive the hook through a real press rather than calling the returned
 * function, and control `usePathname` directly — because what is being asserted
 * is the lock's release condition, and a real screen would supply that by
 * accident.
 */

const mockPush = jest.fn()
const mockBack = jest.fn()

/** What `usePathname()` answers — "the navigation landed" in one variable. */
let mockPath = '/library'

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: mockBack }),
  usePathname: () => mockPath,
}))

function Screen() {
  const router = useGuardedRouter()
  // Bumped by the test to re-render, the way the router store re-renders a real
  // screen when the path changes.
  const [, bump] = useState(0)
  return (
    <>
      <Pressable accessibilityLabel="go" onPress={() => router.push('/queue')}>
        <Text>go</Text>
      </Pressable>
      <Pressable accessibilityLabel="back" onPress={() => router.back()}>
        <Text>back</Text>
      </Pressable>
      <Pressable accessibilityLabel="rerender" onPress={() => bump((n) => n + 1)}>
        <Text>rerender</Text>
      </Pressable>
    </>
  )
}

async function press(label: string) {
  await act(async () => {
    fireEvent.press(screen.getByLabelText(label))
  })
}

/** Land on a new route: the path moves, and the screen re-renders. */
async function arriveAt(path: string) {
  mockPath = path
  await press('rerender')
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  mockPath = '/library'
})

afterEach(() => {
  jest.useRealTimers()
})

describe('useGuardedRouter', () => {
  it('navigates once however many presses arrive before it lands', async () => {
    await render(<Screen />)

    // Both in the same frame, which is the whole bug: expo-router would queue
    // two actions and dispatch both.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('go'))
      fireEvent.press(screen.getByLabelText('go'))
    })

    expect(mockPush).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledWith('/queue')
  })

  it('stays locked while the screen it navigated from is still behind the new one', async () => {
    /*
     * The test that was missing, and the whole of #375 reopening.
     *
     * The first version released the lock on *any* path change, which sounded
     * like "the navigation landed" and is too early by the length of the push
     * animation: the source screen is still mounted and still taking touches
     * underneath. I tapped two playlists in a row on a production build and
     * got both.
     */
    await render(<Screen />)
    await press('go')
    expect(mockPush).toHaveBeenCalledTimes(1)

    await arriveAt('/queue')
    await press('go')

    expect(mockPush).toHaveBeenCalledTimes(1)
  })

  it('re-arms when the screen is returned to', async () => {
    // The other half: a lock that never came back would be a button that works
    // once per app launch, which is worse than the bug.
    await render(<Screen />)
    await press('go')
    await arriveAt('/queue')

    await arriveAt('/library')
    await press('go')

    expect(mockPush).toHaveBeenCalledTimes(2)
  })

  it('guards going back as well, which pops two screens otherwise', async () => {
    await render(<Screen />)

    await act(async () => {
      fireEvent.press(screen.getByLabelText('back'))
      fireEvent.press(screen.getByLabelText('back'))
    })

    expect(mockBack).toHaveBeenCalledTimes(1)
  })

  it('frees a lock whose navigation never landed, rather than killing the button', async () => {
    await render(<Screen />)
    await press('go')

    // The path never moves — a route pushed onto itself, or an action dropped
    // because the navigator was not mounted. Without the backstop this button is
    // dead for as long as the screen stays mounted.
    await press('go')
    expect(mockPush).toHaveBeenCalledTimes(1)

    await act(async () => {
      jest.advanceTimersByTime(2000)
    })
    await press('go')

    expect(mockPush).toHaveBeenCalledTimes(2)
  })

  it('does not free the lock early, or the guard would be a debounce', async () => {
    await render(<Screen />)
    await press('go')

    // Just under the backstop, path unmoved: still locked. A guard that let go
    // sooner would start swallowing real second presses.
    await act(async () => {
      jest.advanceTimersByTime(1999)
    })
    await press('go')

    expect(mockPush).toHaveBeenCalledTimes(1)
  })
})
