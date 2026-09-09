package dev.dylanyu.mio.mediasession

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * What the lock screen is showing, and who to tell when it is pressed (#397).
 *
 * Static because a `Service` is constructed by Android and an Expo `Module` is
 * constructed by React Native, and neither can hand the other a reference. The
 * state is small, written only from the main thread, and read by both.
 */
/**
 * One snapshot of what the lock screen should show (#435).
 *
 * A value rather than seven parameters because it has to be *stored* now: the
 * module can be handed state before the service exists, and dropping it left
 * the session idle and the lock screen blank until the next track.
 */
data class SessionState(
  val title: String,
  val artist: String,
  val artwork: Uri?,
  val durationMs: Long,
  val positionMs: Long,
  val playing: Boolean,
  val newTrack: Boolean,
)

object MioMediaSessionHub {
  /** Where a lock-screen press goes. Set by the module while JavaScript is
   *  listening, and null once it stops — a press then does nothing, which is
   *  the honest behaviour for an app that is no longer playing. */
  @Volatile var onCommand: ((String, Long) -> Unit)? = null

  /** The one player the one session fronts. Held here so the module can update
   *  the metadata without knowing whether the service is up yet. */
  @Volatile var player: JsBackedPlayer? = null

  /** True between the service reaching `onCreate` and its `onDestroy`. The
   *  honest answer to "is there a session right now", as opposed to "did we
   *  ask for one" — the distinction `mio-foreground-task` had to learn. */
  @Volatile var running: Boolean = false

  /**
   * The last state JavaScript sent, whether or not there was a player to take
   * it (#435).
   *
   * `start()` is asynchronous, so the first track's metadata can beat the
   * service's `onCreate`. Held here and applied there, so the session is born
   * showing the right thing instead of idle — which matters twice over, because
   * media3 posts no notification at all for an idle player
   * (`MediaNotificationManager.shouldShowNotification`, line 323).
   */
  @Volatile var pending: SessionState? = null

  private val main = Handler(Looper.getMainLooper())

  /** Run on the main thread, which is where every media3 player method must be
   *  called from. `expo-audio`'s own module wraps every synchronous player call
   *  the same way, and #303 cost five builds by not doing it. */
  fun onMain(work: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) work() else main.post(work)
  }
}

/**
 * A `Player` whose state comes from JavaScript and whose commands go back to it.
 *
 * ## Why this shape
 *
 * `expo-audio` owns the ExoPlayer instances, and there are **two** of them
 * because crossfade needs two decks (#201). Neither is the thing the user is
 * listening to — the *queue* is, and the queue lives in a Zustand store. So the
 * session cannot front an ExoPlayer; it has to front the store.
 *
 * `SimpleBasePlayer` exists for exactly this case: it is media3's base class for
 * apps whose playback is not an ExoPlayer. State is supplied by `getState()`
 * and commands arrive as `handle*` methods, which here are forwarded to
 * JavaScript rather than acted on.
 *
 * ## Why not a ForwardingPlayer over expo-audio's
 *
 * Because it does not work, and this was asserted twice in this project before
 * anybody read it. A controller sees the **intersection** of the player's
 * available commands and the session's, so wrapping a player whose session has
 * removed `next`/`previous` cannot add them back. Only replacing the whole
 * `MediaSession` does — which is what this module is.
 */
@OptIn(UnstableApi::class)
class JsBackedPlayer(private val send: (String, Long) -> Unit) :
  SimpleBasePlayer(Looper.getMainLooper()) {

  private var title: String = ""
  private var artist: String = ""
  private var artwork: Uri? = null
  private var durationMs: Long = 0
  private var positionMs: Long = 0
  private var playing: Boolean = false

  /**
   * Bumped on every track change, and it is load-bearing.
   *
   * `SimpleBasePlayer` diffs playlists by item uid. Keeping one uid across a
   * track change means media3 sees the *same* item with different metadata,
   * which is a metadata update rather than a transition — and the notification
   * can legitimately keep showing the old artwork. A new uid per track is what
   * makes the lock screen actually change.
   */
  private var uid: Int = 0

  override fun getState(): State {
    val item =
      MediaItemData.Builder(uid)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle(title)
            .setArtist(artist)
            .setArtworkUri(artwork)
            .setIsBrowsable(false)
            .setIsPlayable(true)
            .build()
        )
        .setDurationUs(if (durationMs > 0) durationMs * 1000 else C.TIME_UNSET)
        .setIsSeekable(true)
        .setIsDynamic(false)
        .build()

    return State.Builder()
      .setAvailableCommands(COMMANDS)
      // READY rather than IDLE the moment there is a track: IDLE tells the
      // system there is nothing to show, and a notification is not posted for
      // it — which is a lock screen with no controls on it.
      .setPlaybackState(if (title.isEmpty()) Player.STATE_IDLE else Player.STATE_READY)
      .setPlayWhenReady(playing, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
      .setPlaylist(listOf(item))
      .setCurrentMediaItemIndex(0)
      .setContentPositionMs(positionMs)
      .build()
  }

  /** Replace what the lock screen shows. Main thread only. */
  fun show(state: SessionState) {
    if (state.newTrack) uid += 1
    title = state.title
    artist = state.artist
    artwork = state.artwork
    durationMs = state.durationMs
    positionMs = state.positionMs
    playing = state.playing
    invalidateState()
  }

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
    send(if (playWhenReady) ACTION_PLAY else ACTION_PAUSE, 0)
    return Futures.immediateVoidFuture()
  }

  /**
   * Every seek-shaped command, including the two this module exists for.
   *
   * `expo-audio`'s session offers seek-forward and seek-backward and *removes*
   * next and previous (#395), so the lock screen jumped ±15 seconds where the
   * user asked for the next song. Here they are separate commands with separate
   * meanings, and both reach the queue.
   */
  override fun handleSeek(
    mediaItemIndex: Int,
    positionMs: Long,
    seekCommand: Int,
  ): ListenableFuture<*> {
    when (seekCommand) {
      Player.COMMAND_SEEK_TO_NEXT,
      Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> send(ACTION_NEXT, 0)
      Player.COMMAND_SEEK_TO_PREVIOUS,
      Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> send(ACTION_PREVIOUS, 0)
      else -> send(ACTION_SEEK, positionMs)
    }
    return Futures.immediateVoidFuture()
  }

  override fun handlePrepare(): ListenableFuture<*> = Futures.immediateVoidFuture()

  override fun handleStop(): ListenableFuture<*> {
    send(ACTION_PAUSE, 0)
    return Futures.immediateVoidFuture()
  }

  override fun handleRelease(): ListenableFuture<*> = Futures.immediateVoidFuture()

  companion object {
    const val ACTION_PLAY = "play"
    const val ACTION_PAUSE = "pause"
    const val ACTION_NEXT = "next"
    const val ACTION_PREVIOUS = "previous"
    const val ACTION_SEEK = "seek"

    /**
     * What a controller is allowed to ask for.
     *
     * This list *is* the lock screen: media3 builds the notification's buttons
     * from the intersection of these and what the session allows, so a command
     * missing here is a button that does not exist. Next and previous are the
     * two that were missing (#395).
     */
    private val COMMANDS =
      Player.Commands.Builder()
        .addAll(
          Player.COMMAND_PLAY_PAUSE,
          Player.COMMAND_PREPARE,
          Player.COMMAND_STOP,
          Player.COMMAND_SEEK_TO_NEXT,
          Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
          Player.COMMAND_SEEK_TO_PREVIOUS,
          Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
          Player.COMMAND_SEEK_BACK,
          Player.COMMAND_SEEK_FORWARD,
          Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
          Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
          Player.COMMAND_GET_TIMELINE,
          Player.COMMAND_GET_METADATA,
        )
        .build()
  }
}

/**
 * The app's one media session, for as long as there is something to play (#397).
 *
 * ## What was wrong with the old arrangement
 *
 * `setActiveForLockScreen(true)` is **per player**, and this app has two decks.
 * `PlayerHost`'s own comment said the session "has to be handed over", but the
 * code only ever did the acquire half: the incoming deck activated its session
 * and the outgoing deck's was never released. So a track change left two
 * sessions, each with its own service and its own notification, and
 * `setActiveForLockScreen` calls `hideNotification()` synchronously while
 * re-posting `startForeground` asynchronously.
 *
 * 2026-08-09: the banner lost its artwork, title, artist and buttons **at
 * a track change**, while the audio kept playing for another half hour, and
 * reopening the app did not bring it back.
 *
 * ## One session, owned here, never handed over
 *
 * There is exactly one of these and it outlives every track. A track change is a
 * metadata update on a session that was never torn down, which is the whole
 * repair. It also gives the app somewhere to put next and previous (#395), and
 * a foreground service of type `mediaPlayback` that is not tied to whichever
 * deck happens to be live — which is the leading candidate for #396, where a
 * track started in the background advanced its clock but made no sound.
 */
class MioMediaSessionService : MediaSessionService() {
  private var session: MediaSession? = null

  override fun onCreate() {
    super.onCreate()
    val player = JsBackedPlayer { action, value -> MioMediaSessionHub.onCommand?.invoke(action, value) }
    /*
     * Whatever arrived while there was nobody to take it (#435), applied
     * **before** the session is built so it is born showing the right track
     * rather than idle. An idle player is one media3 posts no notification for,
     * so a dropped first update was a blank lock screen until the next track.
     */
    MioMediaSessionHub.pending?.let { player.show(it) }
    MioMediaSessionHub.player = player

    // So tapping the notification opens MiO rather than nothing. Null-guarded
    // because `getLaunchIntentForPackage` can legitimately answer null, and a
    // session without one is still a working session.
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val builder = MediaSession.Builder(this, player).setCallback(PermissiveCallback())
    if (launch != null) {
      builder.setSessionActivity(
        PendingIntent.getActivity(
          this,
          0,
          launch,
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
      )
    }
    val built = builder.build()
    session = built

    /*
     * **Register it, or nothing ever sees it** (#469).
     *
     * The line whose absence made #397 look impossible. Building a
     * `MediaSession` inside a `MediaSessionService` does *not* connect it to the
     * service's notification machinery — `addSession` does, and it is the only
     * thing that does:
     *
     *     MediaSessionService.addSession       (line 300)
     *       → getMediaNotificationManager().addSession(session)   (line 315)
     *         → builds a MediaController with
     *           KEY_MEDIA_NOTIFICATION_CONTROLLER_FLAG            (line 108)
     *         → listener.onConnected(shouldShowNotification(…))   (line 120)
     *         → the notification is posted
     *
     * Nothing else reached it in our flow. `onStartCommand` returns early for an
     * intent it does not recognise (line 450), and nothing binds this service.
     * So the session existed, was `active=true` in `dumpsys media_session`, and
     * had **no notification** — invisible to the shade and to the lock screen.
     *
     * That is the whole of "the media player shows nothing". Our session never
     * lost to expo-audio's; it was never in the running, and the earlier
     * conclusion that this needed a fork of expo-audio was wrong.
     *
     * The notification is also what makes media3 promote this to a foreground
     * service, which is what keeps playback alive with the screen off.
     */
    addSession(built)
    MioMediaSessionHub.running = true
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  /**
   * Swiping the app away stops the music.
   *
   * Without this the service survives the task being removed and leaves a
   * notification for a player nobody can reach — the "ghost" lock-screen banner
   * that several Android music apps are complained about for.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    MioMediaSessionHub.onCommand?.invoke(JsBackedPlayer.ACTION_PAUSE, 0)
    stopSelf()
  }

  override fun onDestroy() {
    MioMediaSessionHub.running = false
    MioMediaSessionHub.player = null
    // Paired with `addSession` in `onCreate` (#469): the notification manager
    // holds a `MediaController` on this session, and releasing the session
    // without withdrawing it leaves that controller pointed at nothing.
    session?.let { removeSession(it) }
    session?.release()
    session = null
    super.onDestroy()
  }

  /**
   * Accept every controller, with every command the player offers.
   *
   * Permissive on purpose: the controllers are the system's own — the lock
   * screen, the shade, a watch, a car. The default callback already accepts,
   * but it is spelled out here because "which commands does a controller see"
   * is the exact question #395 turned on, and a silent default is a bad place
   * for the answer to live.
   */
  private class PermissiveCallback : MediaSession.Callback {
    override fun onConnect(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): MediaSession.ConnectionResult =
      MediaSession.ConnectionResult.AcceptedResultBuilder(session).build()
  }
}
