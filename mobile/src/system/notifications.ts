import { useEffect, useState } from 'react'
import { AppState, PermissionsAndroid, Platform } from 'react-native'

/**
 * Whether Android will let this app post a notification at all (#472).
 *
 * ## Why this exists
 *
 * `POST_NOTIFICATIONS` is a **runtime** permission since Android 13. Declaring
 * it in `app.json` puts it in the manifest and grants nothing; an app that never
 * calls `request` sits at `granted=false` forever, and every `notify()` it makes
 * is dropped in silence.
 *
 * Measured on my phone, 2026-08-12, on a fresh install of the #469 build:
 *
 *     android.permission.POST_NOTIFICATIONS: granted=false
 *     AppSettings: dev.dylanyu.mio importance=NONE userSet=false
 *
 * `userSet=false` is the tell — nobody had denied it, the app had never asked.
 * Granting it over `adb` and changing nothing else made the media card appear
 * with artwork, title, artist and working next/previous. So #469 was correct all
 * along and this was the layer above it, which is worth stating plainly: the
 * session, the service and the notification were all healthy, and the
 * notification was being thrown away after they had done their work.
 *
 * A fresh install resets runtime grants, which is why a feature that had been
 * seen working came back broken with no code to blame.
 *
 * ## What depends on it
 *
 * The lock screen and shade card (`mio-media-session`), and the import's
 * foreground-service notification (`mio-foreground-task`). Neither is *fatal* —
 * music plays and imports run either way — which is exactly why the failure was
 * invisible for so long.
 */
export type NotificationPermission =
  /** Android will post what we ask it to. */
  | 'granted'
  /** The user said no, or has not been asked and the ask was refused. */
  | 'denied'
  /** Below Android 13, or not Android: the permission does not exist. */
  | 'not_required'
  /** The platform call threw. Named rather than folded into `denied`, because
   *  "the user declined" and "we could not ask" need different responses. */
  | 'unavailable'

/** Android 13. Below it `POST_NOTIFICATIONS` is not a permission the platform
 *  knows, and asking answers `denied` on a phone where notifications work. */
const ANDROID_TIRAMISU = 33

function applies(): boolean {
  return Platform.OS === 'android' && Number(Platform.Version) >= ANDROID_TIRAMISU
}

/** What the state is now, asking the user nothing. */
export async function notificationPermission(): Promise<NotificationPermission> {
  if (!applies()) return 'not_required'
  try {
    const granted = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    )
    return granted ? 'granted' : 'denied'
  } catch {
    return 'unavailable'
  }
}

/**
 * Ask, once, if we do not already have it.
 *
 * `check` first on purpose: `request` returns immediately when the permission is
 * held, but Android only ever shows the dialog **twice** in the life of an
 * install, and spending one of those on a question already answered is careless
 * with something that cannot be undone from inside the app.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  const current = await notificationPermission()
  if (current !== 'denied') return current
  try {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    )
    return result === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied'
  } catch {
    return 'unavailable'
  }
}

/**
 * The current state, kept fresh across a trip to the system settings.
 *
 * Re-read on every return to the foreground rather than once on mount: the only
 * way back from a denial is Android's own settings screen, so the answer
 * changing while the app is away is the *expected* path, not an edge case.
 *
 * `null` until the first read resolves, so a caller can tell "not known yet"
 * from "denied" and not flash a warning at someone who is fine.
 */
export function useNotificationPermission(): NotificationPermission | null {
  const [status, setStatus] = useState<NotificationPermission | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = () => {
      void notificationPermission().then((next) => {
        if (!cancelled) setStatus(next)
      })
    }
    read()
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') read()
    })
    return () => {
      cancelled = true
      subscription.remove()
    }
  }, [])

  return status
}
