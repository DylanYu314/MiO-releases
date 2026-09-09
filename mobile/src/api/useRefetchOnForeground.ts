import { useEffect, useRef } from 'react'
import { AppState, type AppStateStatus } from 'react-native'

/**
 * Run something when the app comes back to the foreground (#312).
 *
 * ## The gap this fills
 *
 * *"After connecting Spotify the app does not notice until the page is
 * re-entered."*
 *
 * The Spotify section already refetches in a `useFocusEffect`, and that is the
 * right instrument for the wrong event. **`useFocusEffect` fires on
 * *navigation* focus** — a screen being pushed, popped or tabbed to. Connecting
 * an account hands off to the **system browser** (`Linking.openURL`, and
 * deliberately so: an in-app web view asking for a Spotify password has the
 * shape of a phishing page). That backgrounds the whole app without changing
 * which screen the navigator considers focused, so on return nothing re-fires
 * and the screen keeps showing the answer it had before the login.
 *
 * `AppState` is the event that actually happened. It is a different axis from
 * navigation focus and neither substitutes for the other, which is why this
 * sits alongside the focus effect rather than replacing it.
 *
 * The issue says to verify this on a device, and that stands — the reasoning
 * above is from the navigation model, not from a measurement. The fix is safe
 * either way: refetching once on foreground is correct whether or not focus
 * also fired.
 *
 * ## Only on the transition
 *
 * `AppState` emits for `inactive` too — an incoming call, the app switcher,
 * a notification shade — and running on every one of those would refetch
 * several times for a single return. The previous state is kept so this fires
 * exactly on *something else → active*.
 */
export function useRefetchOnForeground(onForeground: () => void): void {
  // A ref, so a caller passing an inline arrow does not resubscribe on every
  // render — and the listener always calls the newest one.
  const callback = useRef(onForeground)
  useEffect(() => {
    callback.current = onForeground
  }, [onForeground])

  useEffect(() => {
    let previous: AppStateStatus = AppState.currentState

    const subscription = AppState.addEventListener('change', (next) => {
      if (previous !== 'active' && next === 'active') callback.current()
      previous = next
    })

    return () => subscription.remove()
  }, [])
}
