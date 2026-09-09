import { act, renderHook } from '@testing-library/react-native'
import { AppState } from 'react-native'

import { useRefetchOnForeground } from '../src/api/useRefetchOnForeground'

/**
 * Noticing that the app came back (#312).
 *
 * *"After connecting Spotify the app does not notice until the page is
 * re-entered."* The Spotify section already refetched on navigation focus, and
 * that is the wrong event: handing off to the system browser backgrounds the
 * app without changing which screen the navigator considers focused.
 *
 * These drive `AppState` directly, because the distinction being tested is
 * *which transitions count* — and jest has no app to background.
 */

type Listener = (state: string) => void

let listeners: Listener[] = []
let removed = 0

beforeEach(() => {
  listeners = []
  removed = 0
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
    listeners.push(handler as Listener)
    return { remove: () => void (removed += 1) } as ReturnType<typeof AppState.addEventListener>
  })
  // The state the app is in when the hook subscribes. Overridden per test.
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true })
})

afterEach(() => {
  jest.restoreAllMocks()
})

function emit(state: string) {
  for (const listener of listeners) listener(state)
}

describe('coming back to the foreground', () => {
  it('runs on background → active', async () => {
    const onForeground = jest.fn()
    await renderHook(() => useRefetchOnForeground(onForeground))

    await act(async () => {
      emit('background')
      emit('active')
    })

    expect(onForeground).toHaveBeenCalledTimes(1)
  })

  it('does not run on the way out', async () => {
    const onForeground = jest.fn()
    await renderHook(() => useRefetchOnForeground(onForeground))

    await act(async () => {
      emit('background')
    })

    expect(onForeground).not.toHaveBeenCalled()
  })

  it('does not run when active is reported twice', async () => {
    /*
     * The transition is the event, not the state. `AppState` emits `inactive`
     * for an incoming call, the app switcher and the notification shade, and
     * treating every `active` as a return would refetch several times for one
     * trip to the browser.
     */
    const onForeground = jest.fn()
    await renderHook(() => useRefetchOnForeground(onForeground))

    await act(async () => {
      emit('active')
      emit('active')
    })

    expect(onForeground).not.toHaveBeenCalled()
  })

  it('runs once for an inactive → active round trip', async () => {
    const onForeground = jest.fn()
    await renderHook(() => useRefetchOnForeground(onForeground))

    await act(async () => {
      emit('inactive')
      emit('active')
      emit('inactive')
      emit('active')
    })

    expect(onForeground).toHaveBeenCalledTimes(2)
  })

  it('calls the newest callback without resubscribing', async () => {
    // A caller passing an inline arrow must not tear down and rebuild the
    // listener on every render — but it must also not call a stale closure.
    const first = jest.fn()
    const second = jest.fn()
    const { rerender } = await renderHook(
      ({ callback }: { callback: () => void }) => useRefetchOnForeground(callback),
      { initialProps: { callback: first } },
    )

    await act(async () => {
      rerender({ callback: second })
    })
    await act(async () => {
      emit('background')
      emit('active')
    })

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(listeners).toHaveLength(1)
  })

  it('unsubscribes when the screen goes away', async () => {
    const { unmount } = await renderHook(() => useRefetchOnForeground(jest.fn()))

    // Inside `act`, because unmounting runs the effect cleanup and React only
    // flushes that when it is told the work is done.
    await act(async () => {
      unmount()
    })

    expect(removed).toBe(1)
  })
})
