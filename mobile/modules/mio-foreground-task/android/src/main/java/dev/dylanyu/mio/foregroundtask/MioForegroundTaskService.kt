package dev.dylanyu.mio.foregroundtask

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * The service that keeps the process out of Android's cached-app freezer.
 *
 * It runs no work of its own, and that is the whole design. The import loop
 * stays in JavaScript (`mobile/src/library/playlistImport.ts`); what it lacked
 * was not a place to run but *permission to keep running*, because a minimised
 * app with no foreground service is frozen. Holding one for the duration of the
 * run buys exactly that, and nothing in the downloader moves to Kotlin.
 *
 * See ADR-019 for why this is `dataSync` and not `mediaPlayback`: expo-audio
 * already runs a `mediaPlayback` service (`AudioControlsService`), but since
 * Android 14 that type may only be held while media is actually playing, and an
 * import is not playing anything.
 */
class MioForegroundTaskService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    isRunning = false
    super.onDestroy()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: DEFAULT_TITLE
    val body = intent?.getStringExtra(EXTRA_BODY) ?: ""

    createChannelIfNeeded()
    val notification = buildNotification(title, body)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      // The type is required from Android 14 and must match a permission the
      // manifest holds, or this throws and takes the import down with it.
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    /*
     * Set **after** `startForeground` returns, which is the whole point of it
     * existing.
     *
     * `start()` answered "ok" for having *called* `startForegroundService`, and
     * that is a different claim: the system may refuse, the service may throw on
     * the type check, the process may never get here. The 2026-08-09 device pass
     * logged `ok` and the import paused anyway, so the log could not distinguish
     * "the service never ran" from "the service ran and the process was frozen
     * regardless" — the two possibilities that need completely different fixes.
     */
    isRunning = true

    /*
     * START_NOT_STICKY, deliberately.
     *
     * Restarting the service after the process dies would put a notification on
     * screen with nothing behind it: the JavaScript run it existed to protect
     * is gone, and only the app reopening can resume it (which #369 made cheap —
     * every track already on disk is skipped). A service that outlives its
     * reason is a lie of exactly the kind the last two iterations removed.
     */
    return START_NOT_STICKY
  }

  private fun buildNotification(title: String, body: String): Notification {
    // Tapping it reopens the app rather than doing nothing — the import screen
    // is where the progress is, and a notification that is not a way back is
    // just clutter in the shade.
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val pending =
      launch?.let {
        PendingIntent.getActivity(
          this,
          0,
          it,
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
      }

    return Notification.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      // The app's own launcher icon, resolved at runtime: this module has no
      // drawable of its own, and a missing icon makes the notification fail to
      // post rather than look wrong.
      .setSmallIcon(applicationInfo.icon)
      .setContentIntent(pending)
      .setOngoing(true)
      // Nothing here is news. The user started the import; this only says it is
      // still going, so it must not buzz or make a sound.
      .setOnlyAlertOnce(true)
      .build()
  }

  private fun createChannelIfNeeded() {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
        description = CHANNEL_DESCRIPTION
        setShowBadge(false)
      }
    )
  }

  companion object {
    /** Whether a service instance is holding the foreground. Read by the module
     *  so JavaScript can log what is true rather than what was requested. */
    @Volatile var isRunning: Boolean = false

    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"

    private const val CHANNEL_ID = "mio-import"
    private const val CHANNEL_NAME = "Imports"
    private const val CHANNEL_DESCRIPTION = "Shown while MiO is downloading a playlist"
    private const val DEFAULT_TITLE = "MiO"
    private const val NOTIFICATION_ID = 4711
  }
}
