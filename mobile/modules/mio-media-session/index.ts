import { requireOptionalNativeModule } from 'expo'

/**
 * The app's own media session (#395, #396, #397).
 *
 * **`requireOptionalNativeModule`, not `requireNativeModule`.** The Kotlin only
 * exists in a binary built after it was added, and the app must still run in one
 * that was not — the same reasoning as `mio-equalizer` and
 * `mio-foreground-task`. Every path below has a null branch, and an absent
 * module means `PlayerHost` keeps using `expo-audio`'s per-deck session, which
 * is exactly where it was before this landed.
 */
interface MioMediaSessionNative {
  /** False below Android 9, and in any build that predates this module. */
  readonly isSupported: boolean
  start(): MediaSessionReason
  update(info: MediaSessionInfo): boolean
  isRunning(): boolean
  stop(): boolean
  addListener(event: 'onCommand', handler: (payload: MediaSessionEvent) => void): { remove(): void }
}

/**
 * Why the session did or did not start.
 *
 * A name rather than a boolean, for the reason `docs/lessons.md` records at
 * length: one `false` standing for five unrelated failures is what let #303 be
 * diagnosed carefully and fixed wrongly twice.
 */
export type MediaSessionReason =
  | 'ok'
  | 'os_too_old'
  | 'no_context'
  | 'not_allowed_from_background'
  | 'start_failed'
  | 'unavailable'

/** What a lock-screen press means. `positionMs` matters only for `seek`. */
export interface MediaSessionEvent {
  action: 'play' | 'pause' | 'next' | 'previous' | 'seek'
  positionMs: number
}

export interface MediaSessionInfo {
  title: string
  artist: string
  /** A `file://` or `https://` URI, or null for no artwork. */
  artworkUri: string | null
  durationMs: number
  positionMs: number
  playing: boolean
  /**
   * Whether this is a **different track** from the last update.
   *
   * Not a convenience: `SimpleBasePlayer` diffs its playlist by item uid, so
   * without this a track change reads as a metadata edit on the same item and
   * the notification can legitimately keep the previous artwork.
   */
  newTrack: boolean
}

const native = requireOptionalNativeModule<MioMediaSessionNative>('MioMediaSession')

/** True when this build can own a media session at all. */
export const isMediaSessionSupported = native?.isSupported ?? false

/**
 * Bring up the app's session. Never throws.
 *
 * `'unavailable'` means the module is not in this binary — which is a build
 * away, not a bug, and is why the caller keeps the old path behind it.
 */
export function startMediaSession(): MediaSessionReason {
  if (!native) return 'unavailable'
  try {
    return native.start()
  } catch {
    return 'start_failed'
  }
}

/**
 * Tell the lock screen what is playing.
 *
 * Answers false when the service is not up yet, which is a real state rather
 * than an error: the first update can beat the service's `onCreate`, and the
 * caller simply sends the next one.
 */
export function updateMediaSession(info: MediaSessionInfo): boolean {
  try {
    return native?.update(info) ?? false
  } catch {
    return false
  }
}

/**
 * Whether a session is up **right now**, as opposed to having been asked for.
 *
 * Reading this on the line after {@link startMediaSession} will answer `false`
 * on a perfectly healthy phone, because starting a foreground service is
 * asynchronous. #371 shipped exactly that mistake and it was read as a finding
 * for a day — sample it later, or it has measured nothing.
 */
export function isMediaSessionRunning(): boolean {
  try {
    return native?.isRunning() ?? false
  } catch {
    return false
  }
}

/** Take it down. Safe when nothing is running. */
export function stopMediaSession(): void {
  try {
    native?.stop()
  } catch {
    // Stopping a service that is not running, or a module that is not there.
  }
}

/**
 * Listen for lock-screen presses. Returns an unsubscribe function.
 *
 * A no-op unsubscribe when the module is absent, so the caller's cleanup does
 * not need to know whether the binary has it.
 */
export function onMediaSessionCommand(handler: (event: MediaSessionEvent) => void): () => void {
  if (!native) return () => undefined
  try {
    const subscription = native.addListener('onCommand', handler)
    return () => {
      try {
        subscription.remove()
      } catch {
        // Already gone with the module or the service.
      }
    }
  } catch {
    return () => undefined
  }
}
