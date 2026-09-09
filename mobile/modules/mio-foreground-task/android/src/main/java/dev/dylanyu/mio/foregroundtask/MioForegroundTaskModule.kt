package dev.dylanyu.mio.foregroundtask

import android.content.Intent
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Keeping a device import alive while the app is minimised (#371, ADR-019).
 *
 * ## What this is for
 *
 * Android freezes a backgrounded app's process, so the JavaScript playlist
 * import stops mid-run. It was reported as three separate bugs: the import
 * pausing when minimised, an import that seemed to restart, and an automatic
 * retry that never existed — all of them one run being stopped and resumed.
 *
 * A foreground service exempts the process from the freezer. That is the entire
 * mechanism: **the work stays in JavaScript**, unchanged. This module does not
 * download anything, know what a track is, or talk to the import at all.
 *
 * ## Why not the one expo-audio already runs
 *
 * `expo-audio` binds a `MediaSessionService` when `setActiveForLockScreen(true)`
 * is called, which is why background *playback* survives. Since Android 14 a
 * `mediaPlayback` service may only be held while media is actually playing, and
 * an import plays nothing — so borrowing it would be both a lie to the OS and
 * dead the moment the user pauses their music.
 *
 * ## Failure is not fatal, ever
 *
 * `start` answers a **named reason** rather than throwing or a bare boolean —
 * the lesson #303 cost this project twice. An import must run whether or not the
 * service could be started: without it the run is merely interruptible, which is
 * where it already was, and #369 made that resumable. Turning "the notification
 * was refused" into "the import failed" would be a worse app.
 */
class MioForegroundTaskModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MioForegroundTask")

    Constants(
      // A foreground service of a declared type needs Android 9. Below that the
      // app keeps working and imports keep pausing, which is today's behaviour.
      "isSupported" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
    )

    /**
     * Hold a `dataSync` foreground service until `stop()`.
     *
     * Idempotent: starting an already-running service re-delivers the intent and
     * updates the notification's text, which is what a second import beginning
     * while the first is going should look like.
     */
    Function("start") { title: String, body: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return@Function OS_TOO_OLD

      val context = appContext.reactContext ?: return@Function NO_CONTEXT
      val intent =
        Intent(context, MioForegroundTaskService::class.java).apply {
          putExtra(MioForegroundTaskService.EXTRA_TITLE, title)
          putExtra(MioForegroundTaskService.EXTRA_BODY, body)
        }

      /*
       * Caught rather than thrown, and the two named cases are the ones that
       * actually happen on a phone:
       *
       * - `ForegroundServiceStartNotAllowedException` (Android 12+) — the app is
       *   already in the background when the import starts, which is legal to
       *   attempt and illegal to succeed at. The import runs without protection.
       * - Anything else — a missing permission, a manifest the merger did not
       *   pick up. Named separately so a device report can tell them apart.
       */
      runCatching {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
          } else {
            context.startService(intent)
          }
        }
        .fold(
          onSuccess = { OK },
          onFailure = { error ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
              error is android.app.ForegroundServiceStartNotAllowedException
            ) {
              NOT_ALLOWED_FROM_BACKGROUND
            } else {
              START_FAILED
            }
          },
        )
    }

    /**
     * Whether a service is **actually** holding the foreground right now.
     *
     * `start` can only report that the system accepted the request; this reports
     * that the service reached `startForeground`. The device pass needed exactly
     * this distinction and did not have it: the log said `ok` and the import
     * paused anyway.
     */
    Function("isRunning") { MioForegroundTaskService.isRunning }

    /** Release it. Safe to call when nothing is running — which is the common
     *  case, because the import's `finally` calls it however the run ended. */
    Function("stop") {
      val context = appContext.reactContext ?: return@Function false
      runCatching { context.stopService(Intent(context, MioForegroundTaskService::class.java)) }
        .getOrDefault(false)
    }
  }

  companion object {
    /** The only value that means the process is protected. */
    private const val OK = "ok"
    private const val OS_TOO_OLD = "os_too_old"
    private const val NO_CONTEXT = "no_context"
    private const val NOT_ALLOWED_FROM_BACKGROUND = "not_allowed_from_background"
    private const val START_FAILED = "start_failed"
  }
}
