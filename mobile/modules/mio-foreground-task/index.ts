import { requireOptionalNativeModule } from 'expo'

/**
 * The foreground service that keeps a device import running (#371, ADR-019).
 *
 * **`requireOptionalNativeModule`, not `requireNativeModule`.** Kotlin only
 * exists in a binary built after it was added, and the app must still run in one
 * that was not — the same reasoning as `mio-equalizer`, and the same failure the
 * `playbackRate` crash taught this project to avoid. Every path below has a null
 * branch, and an absent module means imports behave exactly as they did before
 * this landed: interruptible, and resumable since #369.
 */
interface MioForegroundTaskNative {
  /** False below Android 9, and in any build that predates this module. */
  readonly isSupported: boolean
  start(title: string, body: string): ForegroundTaskReason
  isRunning(): boolean
  stop(): boolean
}

/**
 * Why the service did or did not start.
 *
 * A name rather than a boolean, for the reason `docs/lessons.md` records at
 * length: one `false` standing for five unrelated failures is what let #303 be
 * diagnosed carefully and fixed wrongly twice. `not_allowed_from_background` and
 * `start_failed` want completely different responses, and only a device can tell
 * us which one happens.
 */
export type ForegroundTaskReason =
  'ok' | 'os_too_old' | 'no_context' | 'not_allowed_from_background' | 'start_failed'

const native = requireOptionalNativeModule<MioForegroundTaskNative>('MioForegroundTask')

/** True when this build can protect a background import at all. */
export const isForegroundTaskSupported = native?.isSupported ?? false

/**
 * Hold a foreground service until `stopForegroundTask()`.
 *
 * Never throws. The caller is an import, and an import that fails because a
 * notification was refused would be a worse app than one that merely pauses when
 * minimised — which is where it already was.
 */
export function startForegroundTask(title: string, body: string): ForegroundTaskReason {
  if (!native) return 'os_too_old'
  try {
    return native.start(title, body)
  } catch {
    return 'start_failed'
  }
}

/**
 * Whether a service is holding the foreground **right now**.
 *
 * Different from what `startForegroundTask` returned, and the difference is the
 * whole reason this exists: `start` reports that the system accepted the
 * request, and the 2026-08-09 device pass had it answering `ok` while the import
 * paused anyway. That left two possibilities needing opposite fixes — the
 * service never ran, or it ran and the process was frozen regardless — and no
 * way to tell them apart. Logged rather than acted on, exactly as `start`'s
 * reason is.
 *
 * `false` in a build without the module, which is also the honest answer.
 */
export function isForegroundTaskRunning(): boolean {
  try {
    return native?.isRunning() ?? false
  } catch {
    return false
  }
}

/** Release it. Safe when nothing is running, which is the usual case. */
export function stopForegroundTask(): void {
  try {
    native?.stop()
  } catch {
    // Stopping a service that is not running, or a module that is not there.
    // Neither is worth surfacing: the run is over either way.
  }
}
