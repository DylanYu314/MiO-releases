package dev.dylanyu.mio.mediasession

import android.content.Intent
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The JavaScript face of the app's own media session (#395, #396, #397).
 *
 * Four calls and one event, and deliberately no more. This module holds no
 * opinion about queues, crossfade or which deck is live — `PlayerHost` owns all
 * of that, and the whole point of #397 is that the session stops being a
 * property of whichever `AudioPlayer` happens to be playing.
 *
 * ## Failure is never fatal
 *
 * Every function is guarded and answers a value rather than throwing. Losing the
 * lock screen is bad; losing *playback* because the lock screen could not be set
 * up would be worse, and that trade has already been made once in this project
 * — `mio-foreground-task`'s docblock records why an import must survive a
 * refused notification.
 */
class MioMediaSessionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MioMediaSession")

    // The one event JavaScript subscribes to. `action` is one of play, pause,
    // next, previous, seek; `positionMs` is meaningful only for seek.
    Events("onCommand")

    Constants(
      // `MediaSessionService` needs a foreground service, and a typed one needs
      // Android 9. Below that the app keeps working with expo-audio's session,
      // which is where it already was.
      "isSupported" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
    )

    /**
     * Start the session service and begin forwarding presses to JavaScript.
     *
     * Idempotent: starting a running service re-delivers the intent, which is
     * what a second call from a remounting `PlayerHost` should look like.
     *
     * ## `startService`, and never `startForegroundService` (#435)
     *
     * This is the line that crashed the 2026-08-09 build, and the fix is to do
     * **less**. Since Android 12 a process that calls `startForegroundService`
     * and does not reach `startForeground` within five seconds is killed with
     * `ForegroundServiceDidNotStartInTimeException`. Nothing is playing when the
     * app opens, so `JsBackedPlayer` is born with no title and therefore
     * `STATE_IDLE`, so media3 posts no notification, so nothing ever called
     * `startForeground`. Every launch and every remount lit a five-second fuse.
     *
     * media3 does not need us to light it. Read in the 1.9.0 sources rather
     * than assumed, which is exactly what the last attempt at this did not do:
     *
     * - `MediaSessionService.onStartCommand` returns `START_STICKY` for an
     *   intent it does not recognise (line 450). It does not require the
     *   service to have been started in the foreground.
     * - `MediaNotificationManager.startForeground` calls
     *   `ContextCompat.startForegroundService(mediaSessionService, …)` **itself**
     *   (line 459) and then `Util.setForegroundServiceNotification(…)` on the
     *   next line — so media3 promotes its own service, and only at the moment
     *   it already has a notification in hand.
     * - It does that when `shouldShowNotification` is true (line 323), which
     *   needs a non-empty timeline and a state other than `STATE_IDLE` — both
     *   of which hold as soon as a track's metadata arrives.
     *
     * So the promotion happens with the notification ready, which is the
     * deadline satisfied by construction rather than by racing it.
     */
    Function("start") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return@Function OS_TOO_OLD
      val context = appContext.reactContext ?: return@Function NO_CONTEXT

      MioMediaSessionHub.onCommand = { action, positionMs ->
        // The event has to leave the main thread's stack before JavaScript runs
        // on it; `sendEvent` is already asynchronous, so this is only about not
        // throwing back into media3's callback.
        runCatching { sendEvent("onCommand", mapOf("action" to action, "positionMs" to positionMs)) }
      }

      runCatching { context.startService(Intent(context, MioMediaSessionService::class.java)) }
        .fold(
          onSuccess = { OK },
          onFailure = { error ->
            /*
             * A plain `startService` from a backgrounded app is refused with
             * `IllegalStateException`, which is a real state rather than a
             * fault: `PlayerHost` can remount while the app is away. Named so a
             * device report can tell it from a genuine failure.
             */
            if (error is IllegalStateException) NOT_ALLOWED_FROM_BACKGROUND else START_FAILED
          },
        )
    }

    /**
     * What the lock screen should show, and whether it is playing.
     *
     * `newTrack` is not a convenience — `SimpleBasePlayer` diffs its playlist by
     * item uid, so without it a track change reads as a metadata edit on the
     * same item and the artwork can legitimately stay put.
     *
     * Returns false when there is no service yet, which is a real state: the
     * first `update` can beat the service's `onCreate`, and the caller simply
     * tries again on the next status tick.
     */
    Function("update") { info: Map<String, Any?> ->
      val artwork = (info["artworkUri"] as? String)?.takeIf { it.isNotBlank() }
      val state =
        SessionState(
          title = info["title"] as? String ?: "",
          artist = info["artist"] as? String ?: "",
          artwork = artwork?.let { Uri.parse(it) },
          durationMs = (info["durationMs"] as? Number)?.toLong() ?: 0L,
          positionMs = (info["positionMs"] as? Number)?.toLong() ?: 0L,
          playing = info["playing"] as? Boolean ?: false,
          newTrack = info["newTrack"] as? Boolean ?: false,
        )

      /*
       * **Kept before it is applied** — the second defect behind #435.
       *
       * This used to `return false` the moment the player was null and throw the
       * state away with it. The player is null until the service reaches
       * `onCreate`, and `start()` is asynchronous, so the first real track's
       * metadata could land in that window and simply vanish: the session then
       * came up idle, with no title, which is also the state media3 declines to
       * post a notification for. The lock screen would stay empty until the
       * *next* track.
       *
       * The service applies this in `onCreate`, so nothing is lost whichever
       * order the two arrive in.
       */
      MioMediaSessionHub.pending = state

      val player = MioMediaSessionHub.player ?: return@Function false
      MioMediaSessionHub.onMain { runCatching { player.show(state) } }
      true
    }

    /**
     * Whether a session is **actually** up right now.
     *
     * The distinction `mio-foreground-task` had to learn the hard way: `start`
     * reports that the system accepted the request, and this reports that the
     * service reached `onCreate`. Reading it on the line after `start` will say
     * `false` on a healthy phone, because `startForegroundService` is
     * asynchronous — sample it later, or it has measured nothing.
     */
    Function("isRunning") { MioMediaSessionHub.running }

    /** Take the session down. Safe when nothing is running. */
    Function("stop") {
      MioMediaSessionHub.onCommand = null
      val context = appContext.reactContext ?: return@Function false
      runCatching { context.stopService(Intent(context, MioMediaSessionService::class.java)) }
        .getOrDefault(false)
    }
  }

  companion object {
    private const val OK = "ok"
    private const val OS_TOO_OLD = "os_too_old"
    private const val NO_CONTEXT = "no_context"
    private const val NOT_ALLOWED_FROM_BACKGROUND = "not_allowed_from_background"
    private const val START_FAILED = "start_failed"
  }
}
