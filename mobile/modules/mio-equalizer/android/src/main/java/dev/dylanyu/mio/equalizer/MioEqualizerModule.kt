package dev.dylanyu.mio.equalizer

import android.media.audiofx.DynamicsProcessing
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.sharedobjects.SharedRef
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.runBlocking

/**
 * A ten-band equaliser for the app's audio (#202).
 *
 * ## Why this is native at all
 *
 * The web client builds its EQ from ten `BiquadFilterNode`s in a Web Audio
 * graph (ADR-012). There is no equivalent in `expo-audio`: its types carry no
 * effects API, and the only `android.media.audiofx` class in its source is
 * `Visualizer`, which reads the spectrum for drawing and cannot alter it.
 *
 * ## Why `DynamicsProcessing` and not `Equalizer`
 *
 * `android.media.audiofx.Equalizer` works everywhere, but its band count is
 * whatever the device reports — commonly five. Ten-band parity with the web is
 * therefore not something it can promise. `DynamicsProcessing` takes the band
 * count as configuration, so ten bands are ten bands on every device that has
 * it. The cost is **API 28**: on Android 7 and 8 this module loads and reports
 * `isSupported = false`, and the app hides the feature rather than pretending.
 *
 * ## How it reaches the audio at all
 *
 * An `AudioEffect` attaches to an audio *session id*, and nothing in
 * `expo-audio` exposes one to JavaScript. It does not have to: `AudioPlayer`
 * extends `SharedRef<ExoPlayer>`, and `SharedRef` exists — in its own words —
 * to "allow passing references to native instances among different independent
 * libraries". So this takes a plain `SharedRef<*>` and reads the session id off
 * whatever it is holding.
 *
 * ## Why this is reflection, having argued against it
 *
 * The first version typed the argument as `expo.modules.audio.AudioPlayer` and
 * declared `implementation project(':expo-audio')`, on the reasoning that a
 * compile-time dependency fails the build rather than failing on a phone. That
 * reasoning was fine and the build disagreed: Gradle could not resolve
 * `:expo-audio` from a local module, and the cost of being wrong here is
 * twenty minutes of somebody's cloud build per attempt.
 *
 * So the coupling is gone. `SharedRef<*>` needs only expo-modules-core, which
 * is already a dependency of every Expo module, and `getAudioSessionId()` is
 * reached reflectively — which also means no dependency on a specific media3
 * version and no `@UnstableApi` opt-in.
 *
 * The lost safety is bought back where it matters: a session that cannot be
 * read returns **a named reason** to JavaScript rather than throwing or silently
 * doing nothing, and the panel shows that reason.
 *
 * ## Every refusal has a name (#303, third attempt)
 *
 * `setGains` used to answer `Boolean`. Five distinct failures shared that one
 * `false`, so a device saying "not reaching the audio" gave no way to tell a
 * reflection problem from a renderer that simply had not started yet — and the
 * issue was twice diagnosed by reading, twice wrongly. It answers one of the
 * codes in the companion object now, and only `"ok"` means the curve landed.
 *
 * ## One processor per session, not per player
 *
 * Crossfade (#201) means two decks and therefore two sessions, both audible at
 * once during a transition. Keying the cache on the session id rather than the
 * player means each deck gets its own processor and a fade is equalised on both
 * sides — and it means re-applying gains mid-fade updates both without either
 * being torn down.
 *
 * `AudioEffect` instances are a scarce global resource on Android, so releasing
 * them matters; `release` exists for that and the app calls it when the EQ is
 * switched off.
 */
class MioEqualizerModule : Module() {
  /** Session id → its processor. See the note above on why the key is the
   *  session rather than the player. */
  private val processors = mutableMapOf<Int, DynamicsProcessing>()

  /**
   * Player class → its `getAudioSessionId`, or null if it has none (#372).
   *
   * `sessionMethod` walks the whole type hierarchy — supertypes and interfaces,
   * breadth-first — and `setGains` is called on every frame of an equaliser
   * drag, for both decks. The 2026-08-08 device pass proved that path is live
   * rather than theoretical (`session_blocked … attempt=10`), so the walk was
   * running while the finger was moving, which is exactly when nothing else
   * should be.
   *
   * The answer cannot change for a given class, so it is asked once. **A miss is
   * cached too**, which is why the value is nullable and the lookup tests
   * `containsKey` rather than nullity: a type with no such method is the case
   * where the walk is most expensive, since it cannot stop early.
   */
  private val sessionMethods = mutableMapOf<Class<*>, Method?>()

  /**
   * Player instance → its audio session id (#303, fifth attempt).
   *
   * Reading the session now costs a blocking hop to the main thread — see
   * `runOnMain` — and `setGains` runs on every frame of a drag, for both decks.
   * A session is fixed for the life of a player, so this is asked once per
   * player and never again.
   *
   * **An `IdentityHashMap`, deliberately.** The key is "this exact player", and
   * `ExoPlayerImpl` is free to define `equals` however it likes; two distinct
   * decks comparing equal would silently share one session and equalise the
   * wrong audio during a crossfade. Identity is the question being asked.
   *
   * Entries are dropped in `release` and `OnDestroy`, which is also what stops
   * this holding a player alive after expo-audio has released it.
   */
  private val sessionIds = java.util.IdentityHashMap<Any, Int>()

  override fun definition() = ModuleDefinition {
    Name("MioEqualizer")

    Constants(
      "isSupported" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P),
      "bandCount" to BAND_FREQUENCIES.size,
      "bandFrequencies" to BAND_FREQUENCIES.toList(),
      "maxGainDb" to MAX_GAIN_DB,
      /*
       * Whether **this binary** can do mono (#482).
       *
       * It asks the only question that matters — is the flag reachable — by
       * looking it up. The processor is injected into `expo-audio` at prebuild
       * by a config plugin, so a build from before that plugin has the module
       * and not the processor, and `isSupported` would say yes to a switch that
       * could do nothing. That is the class of lie v0.5.0 was named after.
       */
      "hasMono" to (monoFlag() != null),
    )

    /**
     * Apply per-band gains, in dB, to whatever this player is feeding.
     *
     * Idempotent and cheap to call often: the processor is created once per
     * session and reused, because rebuilding it on every change would drop
     * audio at the moment the user is dragging a control.
     */
    Function("setGains") { player: SharedRef<*>, gains: List<Double> ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return@Function OS_TOO_OLD

      when (val session = audioSessionIdOf(player)) {
        is SessionLookup.Failed -> return@Function session.reason
        is SessionLookup.Found -> {
          // `AUDIO_SESSION_ID_GENERATE` (0) means the player has not been given
          // a session yet — it has loaded nothing. Attaching to 0 would attach
          // to the global output mix, which is a different feature and not this
          // one. Unlike every other reason here this one is **transient**: the
          // same call moments later, once the renderer is up, succeeds.
          if (session.id == 0) return@Function NO_SESSION_YET

          // `DynamicsProcessing` is API 28 by the docs, but the effect still has
          // to exist in the device's audio HAL, and its constructor throws when
          // it does not. Throwing here would surface in JS as an unhandled error
          // inside a status tick; naming it keeps the panel's promise that a
          // refusal is reported rather than crashed on.
          val processor =
            processors[session.id]
              ?: runCatching { createProcessor(session.id) }
                .onSuccess { processors[session.id] = it }
                .getOrElse {
                  return@Function EFFECT_UNAVAILABLE
                }

          val eq = processor.getChannelByChannelIndex(0).postEq
          for (index in BAND_FREQUENCIES.indices) {
            val band = eq.getBand(index)
            band.cutoffFrequency = BAND_FREQUENCIES[index]
            band.gain = gains.getOrElse(index) { 0.0 }.toFloat().coerceIn(-MAX_GAIN_DB, MAX_GAIN_DB)
            band.isEnabled = true
            eq.setBand(index, band)
          }
          processor.setPostEqAllChannelsTo(eq)
          processor.enabled = true
          OK
        }
      }
    }

    /**
     * Pan between the channels, −1 hard left to 1 hard right (#380).
     *
     * ## Why this belongs here rather than in a module of its own
     *
     * It rides the processor the equaliser has already attached to this
     * player's audio session. Per-channel **input gain** is a first-class
     * property of `DynamicsProcessing` — read from `android.jar` rather than
     * recalled, because the SDK's own casing is inconsistent and a wrong name
     * costs a twenty-minute build:
     *
     *     public void  setInputGainbyChannel(int, float)     ← lowercase "by"
     *     public float getInputGainByChannelIndex(int)       ← capital "By"
     *
     * ADR-012's P8 update judged balance to need a native module. It needs
     * native *code*, which is not the same thing — and this repo records that
     * "needs a native module" has now been wrong three times.
     *
     * ## What it deliberately does not do
     *
     * **Mono is not here** (#482). Every `DynamicsProcessing` stage is per
     * channel; nothing sums them, and mono is a sum. That needs an ExoPlayer
     * `AudioProcessor` in the audio sink, which is a different job entirely.
     *
     * `setInputGainbyChannel` rather than `setChannelTo`, which would replace
     * the whole `Channel` — including the post-EQ the ten bands live in, wiping
     * the equaliser every time the balance moved.
     */
    Function("setBalance") { player: SharedRef<*>, balance: Double ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return@Function OS_TOO_OLD

      when (val session = audioSessionIdOf(player)) {
        is SessionLookup.Failed -> return@Function session.reason
        is SessionLookup.Found -> {
          if (session.id == 0) return@Function NO_SESSION_YET

          val processor =
            processors[session.id]
              ?: runCatching { createProcessor(session.id) }
                .onSuccess { processors[session.id] = it }
                .getOrElse {
                  return@Function EFFECT_UNAVAILABLE
                }

          val gains = channelGainsDb(balance)
          for (channel in gains.indices) processor.setInputGainbyChannel(channel, gains[channel])
          processor.enabled = true
          OK
        }
      }
    }

    /**
     * Sum the channels into both, or stop (#482).
     *
     * **No player argument, and that is not an oversight.** Mono happens in the
     * audio *sink* rather than in an effect bound to a session: the processor
     * is built into every player `expo-audio` constructs, and what this sets is
     * the one process-wide flag it reads per buffer. Crossfade means two decks
     * (#201) and both must be mixed identically, or a transition would pan.
     *
     * It therefore also survives a player being rebuilt, so nothing has to
     * re-apply it per track — unlike the EQ and balance, which attach to a
     * session that a new deck does not have.
     */
    Function("setMono") { enabled: Boolean ->
      val flag = monoFlag() ?: return@Function NO_PROCESSOR
      flag.set(enabled)
      OK
    }

    /** Let go of this player's processor. `AudioEffect`s are a limited global
     *  resource, so an EQ switched off should not keep one. */
    Function("release") { player: SharedRef<*> ->
      (audioSessionIdOf(player) as? SessionLookup.Found)?.let {
        processors.remove(it.id)?.release()
      }
      // The cached session goes with it, and the reference to the player with
      // that — otherwise this map keeps every deck the app has ever built alive
      // for the life of the process.
      player.ref?.let { sessionIds.remove(it) }
      Unit
    }

    OnDestroy {
      processors.values.forEach { it.release() }
      processors.clear()
      sessionMethods.clear()
      sessionIds.clear()
    }
  }

  /**
   * The ExoPlayer's audio session, or null.
   *
   * `getAudioSessionId()` rather than a typed call: see the note above on why
   * this module does not depend on media3 or on expo-audio. Every failure mode
   * — a reference that is not a player, a media3 version without the method —
   * lands in the same place and is reported as "no equaliser".
   *
   * ## `isAccessible` is not belt and braces; without it this never worked
   *
   * `ExoPlayer.Builder(context).build()` returns **`ExoPlayerImpl`**, which is
   * package-private in `androidx.media3.exoplayer`. `getMethod` finds
   * `getAudioSessionId` on it happily — the *method* is public — but `invoke`
   * then throws `IllegalAccessException`, because the class declaring it is not
   * visible from this package. `runCatching` swallowed that, this returned
   * null, `setGains` answered false, and the equaliser silently did nothing on
   * every device it has ever run on. It is the standard reflection trap: a
   * public method on a non-public class is not callable without this line.
   *
   * The failure is now *reported* as well as fixed — `useEqualizerReach`
   * carries "the curve did not take" to the panel, so the next time this is
   * wrong it says so instead of looking healthy.
   */
  private fun audioSessionIdOf(player: SharedRef<*>): SessionLookup {
    val ref = player.ref ?: return SessionLookup.Failed(NO_PLAYER)
    val type = ref.javaClass

    // `containsKey` rather than `getOrPut`, which re-computes whenever the
    // stored value is null — and null here is a real, cacheable answer.
    // `isAccessible` is set with it: it is a property of the method, not of the
    // moment, and it is kept even though the lookup now prefers a public
    // declaring type, because a device whose only match is the package-private
    // implementation still needs it.
    if (!sessionMethods.containsKey(type)) {
      sessionMethods[type] = sessionMethod(type)?.also { runCatching { it.isAccessible = true } }
    }
    val method = sessionMethods[type] ?: return SessionLookup.Failed(NO_SESSION_METHOD)

    /*
     * Already known? Then no player is touched at all (#303, fifth attempt).
     *
     * The hop below is a **blocking** hand-off to the main thread, and
     * `setGains` is called on every frame of an equaliser drag, for both decks.
     * Paying that per frame would trade one bug for #372's. An ExoPlayer's audio
     * session is fixed for the life of the player, so this is asked once and
     * kept — keyed on the instance, because two decks are two sessions.
     *
     * `AUDIO_SESSION_ID_GENERATE` (0) is deliberately **not** cached: it means
     * the renderer has not been given a session yet, which is the one answer
     * here that changes on its own.
     */
    sessionIds[ref]?.let { return SessionLookup.Found(it) }

    return runCatching { runOnMain { method.invoke(ref) as? Int } }
      .fold(
        onSuccess = { id ->
          when {
            id == null -> SessionLookup.Failed(NO_SESSION_METHOD)
            // Not cached: see the note above. The renderer will have one later.
            id == 0 -> SessionLookup.Found(0)
            else -> {
              sessionIds[ref] = id
              SessionLookup.Found(id)
            }
          }
        },
        /*
         * **The exception's class goes into the reason** (#303, fourth attempt),
         * and it is what finally solved this on the fifth.
         *
         * The bare word `session_blocked` came back from three device passes and
         * was assumed, twice, to mean the reflection could not *reach* the
         * method. The qualified form said `IllegalStateException`, which is
         * neither of the candidates anyone had been working on: it is
         * `ExoPlayerImpl.verifyApplicationThread()` refusing a call from the
         * wrong thread. The method was always reachable. The call was always on
         * the wrong thread. See `runOnMain`.
         *
         * The distinctions still matter, because the next failure will be a
         * different one: `IllegalAccessException` means the public-interface
         * lookup above did not find a public declaring type and the access trap
         * is back; `InvocationTargetException`'s **cause** is what ExoPlayer
         * itself threw; a `NullPointerException` means `ref` went away mid-call.
         *
         * `InvocationTargetException` wraps the real error, so its cause is
         * unwrapped — otherwise every genuine player failure reads as the same
         * wrapper and the extra detail buys nothing. That unwrapping is why this
         * said `IllegalStateException` rather than `InvocationTargetException`,
         * and therefore why it was answerable at all.
         *
         * A class name is safe to log: it is a fact about our own code, not
         * about what the user is listening to (#354).
         */
        onFailure = { error ->
          val actual = (error as? java.lang.reflect.InvocationTargetException)?.cause ?: error
          SessionLookup.Failed("$SESSION_BLOCKED:${actual.javaClass.simpleName}")
        },
      )
  }

  /**
   * Run something on the main thread and wait for its answer.
   *
   * ## This is the whole of #303
   *
   * `expo-audio` builds its player with `ExoPlayer.Builder(context)
   * .setLooper(context.mainLooper)` (`AudioPlayer.kt`), and every ExoPlayer
   * method begins with `verifyApplicationThread()`, which throws
   * `IllegalStateException` when called from any other thread. An Expo
   * `Function` runs on the **JS thread**. So `getAudioSessionId()` was refused
   * on every call, on every device, since #202 — and the four fixes before this
   * one were all about whether the method could be *reached*, which it always
   * could.
   *
   * `expo-audio`'s own module does exactly this for its synchronous functions
   * (`AudioModule.kt`'s `runOnMain`), which is the strongest argument for the
   * shape: the library that owns the player already treats the main thread as a
   * requirement rather than a precaution.
   *
   * ## Blocking, and why that is acceptable here
   *
   * `runBlocking` on the JS thread is a real cost and a real deadlock risk if
   * the main thread ever waits on JS. It is bounded here by only ever running on
   * a **cache miss** — once per player, not once per drag frame — and by doing
   * nothing but reading an integer field. Everything else in `setGains`, the
   * `DynamicsProcessing` build and the band writes, stays off the main thread
   * where it cannot make the UI wait.
   */
  private fun <T> runOnMain(block: () -> T): T =
    runBlocking(appContext.mainQueue.coroutineContext) { block() }

  /**
   * `getAudioSessionId`, preferring a declaration that is actually callable.
   *
   * ## Why `getMethod` alone was not enough
   *
   * `ExoPlayer.Builder(context).build()` returns **`ExoPlayerImpl`**, which is
   * package-private in `androidx.media3.exoplayer`. `getMethod` finds
   * `getAudioSessionId` on it happily — the *method* is public — but `invoke`
   * then throws `IllegalAccessException`, because the class declaring it is not
   * visible from this package. That is the classic reflection trap, and #303's
   * first fix answered it with `isAccessible = true`.
   *
   * **That fix shipped and the equaliser still refused the curve** (device pass,
   * 2026-08-07), so `setAccessible` is not reliably sufficient here. The durable
   * answer is not to need it: `getAudioSessionId()` is also declared on the
   * **`ExoPlayer` interface**, and interfaces are public. A method looked up on
   * a public declaring type invokes on the implementation without any access
   * check at all.
   *
   * So this walks the type's supertypes and interfaces and returns the first
   * declaration on a **public** type, falling back to a non-public one only when
   * nothing better exists — which is strictly better than what it replaced.
   *
   * Breadth-first rather than depth-first because the interface a public API is
   * declared on sits near the top, and `seen` guards the diamond that interface
   * hierarchies always contain.
   *
   * **Called once per player class**, not once per `setGains` — see
   * `sessionMethods`. The walk it does is the kind of thing that is free until
   * it is on the path of a gesture, and this one was (#372).
   */
  /**
   * The injected mono flag, or null in a binary that has no processor (#482).
   *
   * Reflection for the same reason `audioSessionIdOf` uses it: Gradle cannot
   * resolve `:expo-audio` from a local module — that was tried and failed, and
   * each attempt costs twenty minutes of cloud build. `MioMono` is a Kotlin
   * `object` with an `@JvmField`, so the flag is a **static** field on the
   * class and there is no instance to obtain.
   *
   * Cached after the first success. Not cached on failure, deliberately: a
   * `null` here is a permanent fact about the binary, so re-asking is harmless,
   * and caching the failure would mean one unlucky early call disabled the
   * feature for the life of the process.
   */
  private var monoFlagCache: AtomicBoolean? = null

  private fun monoFlag(): AtomicBoolean? {
    monoFlagCache?.let { return it }
    val flag =
      runCatching {
        Class.forName(MONO_CLASS).getDeclaredField(MONO_FIELD).also { it.isAccessible = true }.get(
          null
        ) as? AtomicBoolean
      }
        .getOrNull()
    monoFlagCache = flag
    return flag
  }

  private fun sessionMethod(type: Class<*>): Method? {
    val seen = mutableSetOf<Class<*>>()
    val queue = ArrayDeque<Class<*>>().apply { add(type) }
    var fallback: Method? = null

    while (queue.isNotEmpty()) {
      val current = queue.removeFirst()
      if (!seen.add(current)) continue

      runCatching { current.getDeclaredMethod(SESSION_METHOD) }
        .getOrNull()
        ?.let { method ->
          if (Modifier.isPublic(current.modifiers)) return method
          if (fallback == null) fallback = method
        }

      current.superclass?.let { queue.add(it) }
      queue.addAll(current.interfaces)
    }
    return fallback
  }

  private fun createProcessor(sessionId: Int): DynamicsProcessing {
    val config =
      DynamicsProcessing.Config.Builder(
          DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION,
          CHANNEL_COUNT,
          // No pre-EQ and no multiband compressor: this is an equaliser, and
          // every stage left enabled is one more thing altering audio that the
          // user did not ask to have altered.
          false,
          0,
          false,
          0,
          // The post-EQ is the one stage in use, with our ten bands.
          true,
          BAND_FREQUENCIES.size,
          false,
        )
        .build()

    return DynamicsProcessing(PRIORITY, sessionId, config)
  }

  /** The outcome of finding a player's audio session: an id, or why not. */
  private sealed interface SessionLookup {
    data class Found(val id: Int) : SessionLookup

    data class Failed(val reason: String) : SessionLookup
  }

  private companion object {
    /** The method every lookup here is after. */
    const val SESSION_METHOD = "getAudioSessionId"

    /*
     * Why `setGains` answers a string and not a boolean.
     *
     * It used to answer `false` for five unrelated failures at once, and #303
     * was then diagnosed twice by reading the code — wrongly both times, at
     * twenty minutes of cloud build per guess. A boolean cannot say *which*
     * thing went wrong, so the panel could report that the curve had been
     * refused without anyone being able to act on it.
     *
     * These codes are not shown raw to a user as prose; `equalizerReach` keeps
     * the last one, `PlayerHost` logs it through the diagnostics log, and the
     * panel prints it as a detail line under the warning. That is the whole
     * point: the next time this is wrong, it says so by name.
     */
    const val OK = "ok"
    const val OS_TOO_OLD = "os_too_old"

    /** Where the injected mono flag lives — `plugins/kotlin/MioMonoAudioProcessor.kt`,
     *  copied into `expo-audio`'s package at prebuild (#482). */
    const val MONO_CLASS = "expo.modules.audio.MioMono"
    const val MONO_FIELD = "enabled"

    /** No processor in this binary: it was built before the config plugin, or
     *  the plugin did not run. Distinct from "mono is off". */
    const val NO_PROCESSOR = "no_processor"

    /** `SharedRef.ref` was null — the player was released before this ran. */
    const val NO_PLAYER = "no_player"

    /** Nothing in the type's hierarchy declares `getAudioSessionId`, so this is
     *  not an ExoPlayer at all — a wrong object passed from JS. */
    const val NO_SESSION_METHOD = "no_session_method"

    /**
     * The method exists and `invoke` threw.
     *
     * **A prefix, not the whole reason**: what is actually reported is
     * `session_blocked:IllegalAccessException` or
     * `session_blocked:InvocationTargetException`'s unwrapped cause. Three
     * device passes answered this word and it was three different questions —
     * see `audioSessionIdOf`. Anything matching on it must match the prefix.
     */
    const val SESSION_BLOCKED = "session_blocked"

    /** The renderer has no session yet. **The one transient reason**: worth
     *  retrying, unlike every other code here. */
    const val NO_SESSION_YET = "no_session_yet"

    /** API 28+ but the device's audio HAL has no `DynamicsProcessing`. */
    const val EFFECT_UNAVAILABLE = "effect_unavailable"

    /**
     * The web client's bands, to the hertz (`frontend/src/player/audioGraph.ts`).
     *
     * Copied rather than derived: "ten bands an octave apart" would drift from
     * the web's list the first time either side rounded differently, and a
     * preset shared between the two would then mean different things on each.
     */
    val BAND_FREQUENCIES =
      floatArrayOf(31f, 62f, 125f, 250f, 500f, 1000f, 2000f, 4000f, 8000f, 16000f)

    /** Matches the web's slider range, so a preset means the same on both. */
    const val MAX_GAIN_DB = 12f

    /**
     * How many channels the processor is built for.
     *
     * This was 1, on the reasoning that `setPostEqAllChannelsTo` copies the
     * channel-0 settings everywhere so one is enough to describe. That confuses
     * two things: the method copies across the channels the **config declares**,
     * and the config has to describe the stream. The library is stereo Opus, so
     * a one-channel processor is at best equalising the left of two.
     */
    const val CHANNEL_COUNT = 2

    /** Effect priority. 0 is the normal value for an app equalising its own
     *  output; higher numbers are for effects that should win against others. */
    const val PRIORITY = 0

    /**
     * The gain a fully panned-away channel is given, in dB (#380).
     *
     * Not negative infinity, which `20·log10(0)` is and which the platform would
     * have to special-case. −60 dB is a thousandth of the amplitude — inaudible
     * against any music, and a real number the effect can interpolate towards.
     */
    const val SILENT_DB = -60f

    /**
     * Turn a balance in −1..1 into per-channel gains in dB.
     *
     * **Attenuate-only**, deliberately: the quieter side is turned down rather
     * than the louder side turned up. Boosting would clip material already
     * mastered near full scale, and it is the same choice `ATTENUATE_ONLY`
     * makes for loudness normalisation — `expo-audio` clamps volume to 0..1 in
     * `Playable.kt` and discards a boost silently anyway.
     *
     * A linear taper rather than equal-power: this is a balance control, where
     * the user expects centre to be untouched and the ends to be one side only.
     * Equal-power is for *crossfading* between two sources, which is a different
     * question and is answered in `crossfade.ts`.
     */
    fun channelGainsDb(balance: Double): FloatArray {
      val clamped = balance.coerceIn(-1.0, 1.0)
      // ⚠️ Negative is LEFT, so a negative balance must attenuate the RIGHT
      // channel. These two expressions were swapped until 2026-08-13, which
      // panned the audio the wrong way on a device — dragging left moved the
      // sound right. Nothing caught it: the store, the slider and the label all
      // agreed that negative meant left, and the only test of this function
      // asserted that it existed.
      val left = (1.0 - maxOf(clamped, 0.0)).toFloat()
      val right = (1.0 + minOf(clamped, 0.0)).toFloat()
      return floatArrayOf(toDb(left), toDb(right))
    }

    private fun toDb(linear: Float): Float =
      if (linear <= 0f) SILENT_DB else maxOf(SILENT_DB, (20.0 * kotlin.math.log10(linear.toDouble())).toFloat())
  }
}
