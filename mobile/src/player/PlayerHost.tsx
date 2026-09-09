import { ATTENUATE_ONLY, normalizationGain } from '@mio/shared/loudness'
import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  type AudioLockScreenOptions,
  type AudioPlayer,
} from 'expo-audio'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'

import { useConnection } from '../api/connection'
import { showToast } from '../components/Toast'
import i18n from '../i18n'
import type { PlayableSong } from '../api/types'
import { logError, logInfo, logWarn } from '../diagnostics/log'
import { getLocalSong, getLocalSongByServerId } from '../library/songs'
import { useAudioSettings } from './audioSettings'
import {
  applyBalance,
  applyMono,
  applyEqualizer,
  isTransientEqualizerReason,
} from '../../modules/mio-equalizer'
import {
  isMediaSessionRunning,
  isMediaSessionSupported,
  onMediaSessionCommand,
  startMediaSession,
  stopMediaSession,
  updateMediaSession,
  type MediaSessionInfo,
} from '../../modules/mio-media-session'
import { requestNotificationPermission } from '../system/notifications'
import { useEqualizerReach } from './equalizerReach'
import { describeBackgroundStart, worthMeasuring } from './backgroundStart'
import { resetPlaybackStatus, usePlaybackStatus } from './playbackStatus'
import { useResume } from './resume'
import { artworkUrlFor, audioSourceFor, lockScreenMetadata } from './source'
import {
  CROSSFADE_STEP_MS,
  equalPowerGains,
  appIsActive,
  effectiveCrossfadeSeconds,
  heartbeatReport,
  shouldStartCrossfade,
} from './crossfade'
import { peekNextSong, usePlayer } from './store'

/**
 * Seek is all the lock screen can offer, and P6 does not change that.
 *
 * P5 assumed a queue would bring next/previous with it. It cannot:
 * `AudioLockScreenOptions` is only `{ showSeekForward, showSeekBackward,
 * isLiveStream }`, there is no remote-command event on `AudioEvents`, and
 * expo-audio's own web implementation binds the platform `nexttrack` button to
 * *seek forward* rather than a track change.
 *
 * The `AudioPlaylist` class does have `next()`/`previous()`, but
 * `setActiveForLockScreen` exists only on `AudioPlayer` — and without it
 * Android kills background audio after ~3 minutes. Choosing native track
 * skipping would mean giving up the thing P5 exists to provide.
 *
 * So the queue is an in-app control; the lock screen keeps play/pause and seek.
 *
 * **Re-checked against expo-audio 57.0.3 on 2026-08-07** rather than inherited,
 * because ADR-019 turns on it: `AudioPlaylist.kt` still contains no
 * `MediaSession`, no service connection and no `setActiveForLockScreen`. It is a
 * second `ExoPlayer` with `addMediaItem`/`seekToNextMediaItem` and nothing that
 * keeps it alive in the background. Handing it the queue would also cost
 * crossfade (#201 needs two decks) and the per-deck equaliser and loudness.
 */
/** How often the resume position is written, in seconds of playback. */
const RESUME_WRITE_SECONDS = 5

/**
 * How close together two endings may be before the second is an echo (#444).
 *
 * A real track takes minutes. Two seconds is far below anything a queue plays
 * and far above the gap between a `didJustFinish` and the trailing event from
 * the source it replaced.
 */
const MIN_MS_BETWEEN_ENDINGS = 2000

/**
 * How many undownloaded tracks to skip past before giving up (#446).
 *
 * Generous, because skipping is instant and a playlist can legitimately hold a
 * run of tracks whose audio never arrived. Bounded, because `next()` at the end
 * of a list can hand back the song it was already on, and a queue of nothing
 * but empty rows would otherwise spin.
 */
const MAX_UNPLAYABLE_IN_A_ROW = 25

const LOCK_SCREEN_OPTIONS: AudioLockScreenOptions = {
  showSeekForward: true,
  showSeekBackward: true,
}

/**
 * On again — and this time the session is actually registered (#469).
 *
 * ## Why it was off, and why that reasoning was wrong
 *
 * #466 turned it off after the device showed our session `active=true` with no
 * notification, expo-audio's owning the media button, and nothing holding a
 * foreground service. The conclusion drawn was that expo-audio's per-player
 * sessions always win and that owning the session would need a fork.
 *
 * That was wrong. Our session never lost — it was **never registered**.
 * `MioMediaSessionService.onCreate` built a `MediaSession` and never called
 * `addSession`, which is the only thing that connects a session to the
 * service's notification manager. No notification means nothing in the
 * notification shade and nothing on the lock screen, whatever else is true.
 *
 * The module's docblock carries the media3 line numbers. The one-line fix is
 * there; this flag is the other half.
 *
 * ## What this buys
 *
 * `JsBackedPlayer` already declares `COMMAND_SEEK_TO_NEXT` and
 * `COMMAND_SEEK_TO_PREVIOUS` and already routes them to the queue — #397 wrote
 * and tested all of it. expo-audio cannot offer those at all, because
 * `resolveSessionPlayer` hands the raw ExoPlayer to its session and a one-item
 * timeline has no next or previous. That is #395, and this is the only way to
 * fix it.
 *
 * ## The escape hatch is still one line
 *
 * If the device disagrees, `false` here ships over the air in about a minute
 * and the app is back on expo-audio's session. A bad build costs a restart
 * rather than another twenty minutes.
 *
 * `session.running` (#433) reports that the service reached `onCreate`;
 * `dumpsys media_session` on a connected phone is what confirms the rest.
 *
 * ## What it was originally turned off for (#435), still true
 *
 * `MioMediaSessionModule.start()` used to call `startForegroundService`, and
 * since Android 12 a process that does not reach `startForeground` within five
 * seconds is killed. It uses plain `startService` now and lets media3 promote
 * itself once it holds a notification — which `addSession` is what produces.
 *
 * A `boolean` annotation and not an inferred literal, so both branches below
 * stay live code rather than becoming unreachable to the compiler.
 */
const SESSION_ENABLED: boolean = true

/**
 * Whether this binary owns its media session (#397).
 *
 * Read once, at module load, because it cannot change while the app is running:
 * either the Kotlin is in the APK or it is not. When it is not — an older
 * binary, or a dev client built before #397 — every path below falls back to
 * `expo-audio`'s per-deck session, which is exactly where the app was.
 */
const OWNS_SESSION = SESSION_ENABLED && isMediaSessionSupported

/**
 * Say what is playing, to whichever session this build has.
 *
 * ## Why the old way was broken
 *
 * `setActiveForLockScreen` is **per player** and this app has two decks. The
 * comment above `deckA` said the session "has to be handed over"; the code only
 * ever did the acquire half. The incoming deck activated its own session and
 * the outgoing deck's was never released, so every track change left an extra
 * session and an extra service behind, and `setActiveForLockScreen` tears its
 * notification down synchronously while re-posting it asynchronously.
 *
 * 2026-08-09: the banner lost artwork, title, artist and buttons **at a
 * track change**, audio carried on for another half hour, and reopening the app
 * did not bring it back.
 *
 * With `OWNS_SESSION` there is one session for the life of the app and a track
 * change is a metadata update on something that was never torn down.
 */
function announceLockScreen(
  deck: AudioPlayer,
  song: PlayableSong,
  coverUri: string | null,
  isNewTrack: boolean,
  remember: { current: MediaSessionInfo | null },
): void {
  const info: MediaSessionInfo = {
    title: song.title,
    artist: song.artist ?? '',
    artworkUri: coverUri ?? null,
    durationMs: Math.max(0, Math.round((song.duration ?? 0) * 1000)),
    positionMs: 0,
    playing: usePlayer.getState().isPlaying,
    newTrack: isNewTrack,
  }
  // Kept so play/pause can re-send the same track without re-reading the
  // database for its cover — and so a `newTrack: false` update is possible at
  // all, which is what stops the artwork flickering on every pause.
  remember.current = info
  if (OWNS_SESSION) {
    updateMediaSession(info)
    return
  }
  deck.setActiveForLockScreen(
    true,
    lockScreenMetadata(song, artworkUrlFor(coverUri)),
    LOCK_SCREEN_OPTIONS,
  )
}

/**
 * Why there is **no** release half to the handover (#428, #466, #468).
 *
 * #466 added `releaseLockScreen(outgoing)` here on the reading that
 * `setActiveForLockScreen` is per player and the code "only ever did the
 * acquire half". That reading was wrong, and the device showed it: the media
 * player went blank at a track change *sometimes*, and had to be nudged from
 * inside the app to come back.
 *
 * `AudioControlsService` is **single-player**, and registering a deck already
 * performs the whole handover — `setActivePlayerInternal` (line 338) clears the
 * previous player's flag at line 349, hides the old notification, and builds
 * the new session. There was never a missing half.
 *
 * Releasing on top of that is not merely redundant, it is destructive:
 *
 *     unregisterPlayer() → clearSessionInternal()
 *         mediaSession?.release()
 *         stopForeground(STOP_FOREGROUND_REMOVE)
 *
 * `clearSessionInternal` (line 413) checks **nothing** about which player
 * asked. It tears down whatever session exists and removes the notification —
 * including the one the incoming deck has just put up.
 *
 * And whether it fires at all is a race: `setActiveForLockScreen(true)` applies
 * asynchronously while the service is binding — *"The settings will be applied
 * when the service connects"* — so the outgoing deck's `isActiveForLockScreen`
 * may or may not have been cleared by the time we ask. That is exactly the
 * *sometimes* in the report.
 *
 * So the acquire is the whole handover, and this file does nothing else.
 */

/**
 * How long the sleep timer takes to fade out (#241).
 *
 * Eight seconds, and the number is the feature: short enough that the timer
 * still means what it says, long enough that the ramp is not a fast fade — a
 * two-second one is heard as the music being switched off, which is the thing
 * being fixed.
 */
const FADE_MS = 8_000

/** How often the fade moves. 200 ms is 40 steps across the ramp — well under
 *  the threshold where a level change is heard as a step rather than a slide,
 *  and cheap enough to be running while a phone is trying to sleep. */
const FADE_STEP_MS = 200

/**
 * Set the player's volume to this track's loudness correction (P8).
 *
 * A module-level function rather than an inline assignment because
 * `react-hooks/immutability` — rightly — refuses to let a component body mutate
 * a value a hook returned. `expo-audio`'s player genuinely is a mutable native
 * handle, and `volume` is a property setter rather than a method, so the
 * mutation has to happen somewhere; doing it behind a named function keeps the
 * component declarative and gives the operation a place to be explained.
 */
function applyLoudnessGain(
  player: AudioPlayer,
  song: PlayableSong,
  enabled: boolean,
  userVolume: number,
  muted: boolean,
  sleepFade = 1,
): void {
  /**
   * The two gains **multiply**; the user's does not replace the correction.
   *
   * They answer different questions. Normalization is "how loud is this track
   * relative to the others" (P8, measured once at import); the user's volume is
   * "how loud do I want it". Letting either win outright would either undo the
   * evening-out or ignore the slider.
   *
   * `expo-audio` clamps to 0..1 in its Android source, so the product staying
   * inside that range matters — which it does, since `ATTENUATE_ONLY` keeps the
   * correction at or below 1 and the volume is clamped to 0..1 by the store.
   *
   * The sleep fade is a **third** multiplier for the same reason (#241): it
   * answers "how far through falling asleep are we", which is a different
   * question again. Multiplying means the loudness correction still applies to
   * the track underneath while it fades, which is what that issue asks for —
   * replacing the volume with a ramp would un-normalize the last few seconds.
   */
  const correction = normalizationGain(song.loudness_lufs, song.peak_dbfs, enabled, ATTENUATE_ONLY)
  player.volume = muted ? 0 : correction * userVolume * sleepFade
}

/**
 * Speed is a **method**, not a property — unlike `volume`.
 *
 * `player.playbackRate = rate` crashes at runtime with "Cannot assign to
 * property 'playbackRate' which has only a getter", and takes the whole app
 * down with it: this runs from an effect in the root layout, so there is no
 * screen left to show an error on.
 *
 * `expo-audio`'s own types say otherwise — `playbackRate: number` is declared
 * writable and the docblock beside it literally shows `player.playbackRate =
 * 1.0`. The Android source is the truth: `Property("playbackRate")` is declared
 * with a getter block and no setter, while `Function("setPlaybackRate")` is the
 * real entry point (`android/.../AudioModule.kt`).
 *
 * The lesson is one this project has already written down twice — check
 * third-party behaviour by running it, and distrust a test environment that
 * supplies an API the runtime lacks. Both applied here and neither was heeded.
 */
function applyPlaybackRate(player: AudioPlayer, rate: number): void {
  player.setPlaybackRate(rate)
}

/**
 * Whether an equaliser curve has already been applied.
 *
 * Compared element by element rather than by identity: the settings store hands
 * out a new array whenever any band moves, so identity would answer "different"
 * every render and re-attach the processor for nothing.
 */
/**
 * How many times a deck is asked to take a curve before we stop asking, for as
 * long as it holds the same track. See `eqAttempts`.
 */
const EQ_ATTEMPT_LIMIT = 10

function sameGains(applied: readonly number[] | null, wanted: readonly number[]): boolean {
  return (
    applied !== null &&
    applied.length === wanted.length &&
    applied.every((value, index) => value === wanted[index])
  )
}

/**
 * The one place `expo-audio` is touched.
 *
 * Mounted once in the root layout, so playback survives navigation between
 * screens — a player that unmounts with the screen is not a music app.
 *
 * ## Why it renders nothing (#226)
 *
 * It used to render the mini player as well, which worked while the app was a
 * single stack. A tab bar makes that impossible: the bar has to sit *above* the
 * tabs, which only the tab navigator can position, while the audio has to sit
 * *outside* the navigator or `router.replace('/setup')` would stop the music.
 * One component cannot be in both places.
 *
 * So this half kept the audio and gave up its output. What the bar needs to
 * draw — position, duration, buffering, error — is published to
 * `usePlaybackStatus` instead, and `MiniPlayer` reads it from there.
 *
 * ## Why the player is created empty and fed with `replace()`
 *
 * `useAudioPlayer(source)` keys the underlying native object on the source, so
 * passing a changing source **destroys and recreates the player on every
 * track**. That would tear down and re-register the lock-screen session each
 * time. Creating it once with `null` and calling `replace()` ourselves keeps a
 * single player, and therefore a single uninterrupted media session, for the
 * app's lifetime.
 *
 * (The web client learned the same lesson in Wave G: an `<audio>` element binds
 * to one `AudioContext` permanently, so the context has to be a singleton.)
 */
export function PlayerHost() {
  const { serverUrl, accessKey } = useConnection()
  const current = usePlayer((state) => state.current)
  const isPlaying = usePlayer((state) => state.isPlaying)
  const setPlaying = usePlayer((state) => state.setPlaying)
  const restartNonce = usePlayer((state) => state.restartNonce)
  const normalizeLoudness = useAudioSettings((state) => state.normalizeLoudness)
  const eqGains = useAudioSettings((state) => state.eqGains)
  const balance = useAudioSettings((state) => state.balance)
  const mono = useAudioSettings((state) => state.mono)
  // The settings the store records and this component applies (#234).
  const volume = usePlayer((state) => state.volume)
  const muted = usePlayer((state) => state.muted)
  const playbackRate = usePlayer((state) => state.playbackRate)
  const sleepAt = usePlayer((state) => state.sleepAt)
  const seekRequest = usePlayer((state) => state.seekRequest)
  const crossfadeSeconds = usePlayer((state) => state.crossfadeSeconds)

  const song = current?.song ?? null

  /**
   * Two decks, so one track can be fading out while the next fades in (#201).
   *
   * ## With crossfade off — the default — this is the old single-deck app
   *
   * `deckB` is created and never fed. Every effect below reads `player`, which
   * is whichever deck is active, and nothing flips it until a crossfade starts.
   * That is deliberate and it is the safety property of the whole feature:
   * background playback and the lock-screen session (ADR-015) are the app's
   * core promise, and at `crossfadeSeconds: 0` they run exactly the code they
   * ran before this existed.
   *
   * ## The lock screen belongs to one deck at a time
   *
   * `setActiveForLockScreen` is per-player, so it has to be handed over. It
   * moves at the **start** of the fade, together with the store's `current`:
   * the incoming track is what the user is now listening to, so it is what the
   * lock screen and the UI should name. The outgoing deck keeps playing without
   * a session, which is fine for the seconds it has left — the session it needs
   * to keep Android from stopping background audio is held by the deck that is
   * still going to be playing in a minute's time.
   *
   * This handoff is the part most likely to break background playback, and no
   * test here can see it. It needs a locked screen and five minutes
   * (`docs/mobile-testing.md`).
   */
  const deckA = useAudioPlayer(null)
  const deckB = useAudioPlayer(null)
  const [activeDeck, setActiveDeck] = useState<0 | 1>(0)
  const decks = useMemo(() => [deckA, deckB] as const, [deckA, deckB])
  const player = decks[activeDeck]
  const status = useAudioPlayerStatus(player)

  /** The track the native player currently holds. A refetch can hand us a new
   *  `Song` object with the same id; reloading on that would restart playback
   *  under the user. */
  const loadedId = useRef<string | number | null>(null)

  /** The last thing the lock screen was told, so play/pause can re-send it
   *  without a database read and without claiming the track changed. */
  const sessionInfo = useRef<MediaSessionInfo | null>(null)

  /**
   * Which run of playback we are on.
   *
   * Bumped by both loading a track and restarting one, and used to latch
   * `didJustFinish`. A song id alone is not enough: repeat-one plays the *same*
   * id twice in a row, and a latch keyed on the id would swallow the second
   * ending and stop the music.
   */
  const generation = useRef(0)
  const finishedGeneration = useRef(-1)
  /** Whether the last status tick already reported the track as finished, so an
   *  ending is acted on once per *transition* rather than once per generation. */
  const wasFinished = useRef(false)
  /** When the last ending was acted on, so a second one arriving immediately
   *  after is recognised as an echo rather than a track that played out. */
  const lastEndingAt = useRef(0)
  /** How many unplayable tracks have been skipped without one playing. */
  const unplayableRun = useRef(0)

  /** The sleep timer's fade multiplier, 1 normally and ramping to 0 over the
   *  last {@link FADE_MS} (#241). A ref rather than state: it moves five times
   *  a second and nothing renders from it. */
  const sleepFade = useRef(1)

  /** The crossfade multiplier **per deck** (#201): a fourth factor in the
   *  volume, alongside loudness correction, the user's volume and the sleep
   *  fade. Per deck because during a fade the two are at different points on
   *  the curve — that is what a crossfade is. */
  const crossFade = useRef<[number, number]>([1, 1])

  /** Which song each deck holds. The loudness correction is per *track*, so
   *  setting the outgoing deck's volume mid-fade needs to know what is on it —
   *  the store's `current` has already moved on by then. */
  const deckSongs = useRef<[PlayableSong | null, PlayableSong | null]>([null, null])

  /**
   * Measure a track start that happened while nobody was looking (#396).
   *
   * *"i can see the next track is started playing from lock screen, but
   * no audio. only when i open the app, audio regained"*. Reading the source
   * produced **three** candidates and could not separate them:
   *
   * 1. `setActiveForLockScreen` calls `hideNotification()` synchronously and
   *    re-posts `startForeground` inside a `mainQueue.launch` — so `play()`
   *    lands in a window with no posted foreground notification.
   * 2. Audio focus is not re-taken on a deck handover.
   * 3. The deck's gain is stuck near zero from a fade that did not finish, so it
   *    *is* playing, silently.
   *
   * These want completely different fixes, and #303 cost this project five
   * builds by choosing between candidates from reading. So this measures instead
   * — and it is JavaScript, so it costs an over-the-air update rather than a
   * build.
   *
   * **The second sample is the whole point.** One reading cannot distinguish
   * "the deck refused to start" from "the deck is playing and something is
   * silencing it", and those are the two halves of the answer:
   *
   * | `playing` | `advanced` | means |
   * |---|---|---|
   * | false | — | the start was refused — candidate 1 or 2 |
   * | true | no | it thinks it is playing and the clock is frozen |
   * | true | yes | it **is** playing; the gain is what to look at — candidate 3 |
   *
   * `gain` is logged with it, because candidate 3 is answered by that number
   * alone. No song title or URL — a diagnostic is not a reason to breach #354.
   */
  const reportBackgroundStart = useCallback(
    (deck: 0 | 1, index: 0 | 1) => {
      /*
       * Wrapped, and the wrapping is not defensive clutter.
       *
       * This runs **inside the play path**, two lines after `player.play()`. A
       * diagnostic that can throw there does not merely fail to measure — it
       * takes playback down with it, which is a far worse bug than the silent
       * track it was added to explain. The first version threw on a deck whose
       * `currentTime` was undefined and broke 56 tests; on a device that would
       * have been an app that stops between songs.
       *
       * An observer must not be able to break what it observes.
       */
      try {
        /*
         * Only a **known** background state, not "anything that is not active".
         *
         * `AppState.currentState` is `undefined` under jest — the runtime always
         * has a value, the test environment does not — so `!== 'active'` was
         * true in every test that played a track, and each one scheduled a
         * two-second timer. A laptop finished the run first; CI is 4–7x slower
         * and fired them inside later tests, failing a run in which all 1092
         * passed.
         *
         * Asking for the state we actually mean is both the fix and the honest
         * condition: this measures a start that happened while the app was away.
         */
        const state = AppState.currentState
        if (!worthMeasuring(state)) return
        const clock = () => {
          const value = decks[index].currentTime
          return typeof value === 'number' ? value : null
        }
        const startedAt = clock()
        // Long enough that a renderer coming up is not mistaken for a refusal,
        // and short enough to land before the user reaches for the phone.
        // Only one in flight: a second advance before the sample lands means the
        // first one's answer is about a track that is already over.
        if (startProbe.current !== null) clearTimeout(startProbe.current)
        startProbe.current = setTimeout(() => {
          startProbe.current = null
          try {
            logInfo(
              'queue.backgroundStart',
              describeBackgroundStart({
                deck,
                state,
                gain: crossFade.current[index],
                volume: typeof decks[index].volume === 'number' ? decks[index].volume : null,
                startedAt,
                now: clock(),
                playing: decks[index].playing === true,
              }),
            )
          } catch {
            // Same reasoning, and this one fires from a timer with nothing to
            // catch it — an unhandled throw here is a crash, not a log line.
          }
        }, 2000)
      } catch {
        // See above.
      }
    },
    [decks],
  )

  /**
   * True from the moment a fade starts until it finishes.
   *
   * A **ref** because the trigger has to read it in the same tick it was
   * written, before any render could deliver a state update — that is what
   * stops it firing again on the next status tick. And **also state**, because
   * one effect below has to *re-run* when a fade ends, which a ref cannot make
   * happen. Both are written by `setTransitioning` and nowhere else, so they
   * cannot drift apart.
   */
  const transitioning = useRef(false)
  const [fading, setFading] = useState(false)
  const setTransitioning = useCallback((value: boolean) => {
    transitioning.current = value
    setFading(value)
  }, [])

  /**
   * The curve each deck's equaliser is actually applying, or null (#303).
   *
   * Null means "not on this deck": either never applied, or applied to a
   * session that has since been replaced. It is what turns the equaliser from
   * fire-and-forget into something that retries — see the sync effect below for
   * why one attempt is never enough.
   */
  const appliedEq = useRef<[number[] | null, number[] | null]>([null, null])

  /** What balance each deck is actually carrying (#380). `null` means "not
   *  asked yet", which is distinct from 0 — a centred balance still has to be
   *  written once, or a deck keeps whatever the previous track left it at. */
  const appliedBalance = useRef<[number | null, number | null]>([null, null])

  /**
   * How many times each deck has been refused the equaliser for its current
   * track — capped, so a build that can never accept it stops being asked.
   *
   * #303 made the curve retry on every status tick until it took, which is
   * right for the case it was written for: a deck whose renderer has not come
   * up yet reports `audioSessionId == 0` for a tick or two. It is wrong for the
   * case where it can *never* take — a build predating the Kotlin session fix,
   * or an OS below API 28 — because then it is a `requireOptionalNativeModule`
   * lookup plus a JNI call **twice a second for as long as anything plays**,
   * with the answer thrown away. That is a lead in #342.
   *
   * Ten attempts is about five seconds of ticks: far longer than a renderer
   * takes to come up, and finite.
   */
  const eqAttempts = useRef<[number, number]>([0, 0])

  /**
   * Whether each deck's refusal was **permanent** for its current track (#372).
   *
   * The budget above is reset whenever the curve changes, on the reasoning that
   * a curve the user has just moved is a new question. That is right for a
   * renderer that had not started yet and wrong for everything else: during a
   * drag the curve changes many times a second, so a deck refusing for a reason
   * that can never improve — no session method, an OS below API 28, no effect in
   * the HAL — was being asked ten more times per change, each one a native call
   * whose answer is already known. That is the second half of what made the
   * equaliser drag lag on a device.
   *
   * Cleared with the attempts wherever a deck gets a new source, since a new
   * session is a genuinely new question.
   */
  const eqPermanent = useRef<[boolean, boolean]>([false, false])

  /** The running fade's timer. Held here rather than in the effect that starts
   *  it, because that effect flips `activeDeck` and so unmounts itself — see
   *  the cleanup note there. */
  const fadeTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  /**
   * How to end a fade that is in flight, or null when none is (#455).
   *
   * A ref because the fade's decks are closure variables of one run of the
   * crossfade effect, and the thing that needs to end it — the app being
   * minimised — arrives from a listener that knows nothing about that run.
   */
  const finishFadeNow = useRef<(() => void) | null>(null)

  /**
   * One step of the ramp, callable from outside the run that owns it (#470).
   *
   * The fade's driver used to be a `setInterval` and nothing else, and Android
   * stops firing JS timers when the activity pauses — so a backgrounded fade
   * left the incoming deck at gain 0 until the app came forward. #455 avoided
   * that by refusing to fade at all in the background.
   *
   * `expo-audio` emits `playbackStatusUpdate` from a Kotlin coroutine on
   * `Dispatchers.Main` driven by `delay()` (`BaseAudioPlayer.kt:52-68`), which
   * is a **native** timer that `JavaTimerManager` cannot reach. Measured on the
   * device 2026-08-12 over 135 s backgrounded with audio playing:
   *
   *     queue.heartbeat ticks=272 over=134582ms expected=269 playing=true
   *
   * So the ramp is driven from that as well, and it keeps running while the app
   * is away. A ref for the same reason as `finishFadeNow`: the decks are
   * closure variables of one run of the crossfade effect, and the status effect
   * knows nothing about that run.
   */
  const fadeStep = useRef<(() => void) | null>(null)

  /**
   * #396's delayed sample, so it can be cancelled.
   *
   * An uncancelled `setTimeout` here is not a test problem, it is a leak: this
   * fires two seconds later and touches the decks and the diagnostics log. In
   * the app `PlayerHost` never unmounts, so it looked harmless — and then CI,
   * which is 4–7x slower than a laptop, ran it inside a *later test's* `act()`
   * and failed a run where all 1092 tests passed. A timer nothing owns is a
   * timer that fires somewhere nobody expects.
   */
  const startProbe = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The one thing that really should stop a fade: going away.
  useEffect(
    () => () => {
      if (fadeTimer.current !== null) clearInterval(fadeTimer.current)
      if (startProbe.current !== null) clearTimeout(startProbe.current)
    },
    [],
  )

  /**
   * How many status updates arrived while the app was away (#470).
   *
   * `since` is 0 when the app is in the foreground, so a report can tell "we
   * were never backgrounded" from "we were backgrounded and heard nothing" —
   * the two answers a bare count of 0 would run together, and the difference is
   * the whole measurement.
   */
  const backgroundTicks = useRef({ since: 0, count: 0 })

  /**
   * Set one deck's volume from all four multipliers.
   *
   * Everything that changes a level goes through here rather than assigning
   * `volume` directly, because the four factors answer four different questions
   * and each has been added by a different issue. Anything that overwrites
   * instead of multiplying silently undoes one of them — which is exactly the
   * bug #241 called out for the sleep fade, one factor ago.
   */
  const applyGainFor = useCallback(
    (deck: 0 | 1) => {
      const song = deckSongs.current[deck]
      if (!song) return
      applyLoudnessGain(
        decks[deck],
        song,
        normalizeLoudness,
        volume,
        muted,
        sleepFade.current * crossFade.current[deck],
      )
    },
    [decks, normalizeLoudness, volume, muted],
  )

  /**
   * Configure the audio session, once, before anything plays.
   *
   * Both flags are load-bearing on Android:
   * - `shouldPlayInBackground` is what allows audio to continue at all once the
   *   app is no longer in front;
   * - `interruptionMode: 'doNotMix'` takes exclusive audio focus, which is both
   *   how the OS knows to pause us for a phone call and — per `expo-audio`'s
   *   own docs — a precondition for lock-screen controls binding to us.
   *
   * Held as a promise rather than a boolean so a track starting while the call
   * is still in flight waits for it instead of racing it. This effect is
   * declared first, so it has run before any track can load.
   */
  const audioModeReady = useRef<Promise<void> | null>(null)
  useEffect(() => {
    audioModeReady.current ??= setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    })
  }, [])

  // Load the current track, and hand it to the lock screen.
  useEffect(() => {
    if (!song) {
      loadedId.current = null
      player.pause()
      // Ours goes down with the queue; expo-audio's is per player, so it is the
      // player that has to be told. Only one of the two exists in any binary.
      if (OWNS_SESSION) stopMediaSession()
      else player.clearLockScreenControls()
      return
    }
    if (loadedId.current === song.id) return

    // Claimed before the await below, not after: the lookup is asynchronous and
    // without this a second render would start loading the same track again.
    loadedId.current = song.id
    generation.current += 1

    let cancelled = false
    void (async () => {
      // Is the audio on this device? (#159, #217)
      //
      // A device-fetched song carries its `file_uri` already — the library
      // read it straight out of SQLite (#216). Only a song that arrived from
      // the server needs looking up, and it is looked up by the server's id
      // because that is what such a row is keyed to.
      //
      // A failure here is not fatal: it falls back to streaming, which is what
      // happened before any of this existed.
      let fileUri: string | null = song.file_uri ?? null
      // The cover always needs looking up: unlike `file_uri` it is not on the
      // `PlayableSong` the queue carries, so the row is the only place it lives.
      let coverUri: string | null = null
      if (typeof song.id === 'number') {
        try {
          const local = await getLocalSongByServerId(song.id)
          fileUri ??= local?.file_uri ?? null
          coverUri = local?.cover_uri ?? null
        } catch {
          // A database that will not open must not stop playback.
        }
      } else {
        try {
          coverUri = (await getLocalSong(song.id))?.cover_uri ?? null
        } catch {
          // Likewise: no artwork is a blank tile, not a stopped track.
        }
      }
      if (cancelled) return

      /*
       * Is there anything to play at all?
       *
       * Not `audioSourceFor(...) === null`, which was the first attempt and is
       * wrong: with a server configured it happily builds
       * `/songs/<local-id>/audio` for a track the server has never heard of, so
       * the deck errors instead of the queue advancing. And not `isPlayable`,
       * which reads `server_song_id` — a song that came from the server carries
       * its id in `song.id` and would be called unplayable.
       *
       * The honest test is: a **device-minted id** (a string) with no file on
       * disk. That is a row a failed import left behind — known about, not here,
       * and nothing to stream it from.
       */
      const nothingToPlay =
        typeof song.id === 'string' && fileUri == null && song.server_song_id == null
      const source = nothingToPlay ? null : audioSourceFor(song, serverUrl, accessKey, fileUri)
      if (!source) {
        /*
         * Nothing to play — **so play something else** (#446).
         *
         * This used to `return`, which leaves the deck holding the previous
         * track and the queue sitting on a song that can never start. I:
         * *"the not downloaded track is added to the queue, and when queue
         * playing, that failed download track wont get skipped"*. Silence, with
         * the app insisting it is playing.
         *
         * A row with no audio is an ordinary state since #159 — a playlist
         * import records every accepted track and a failed one leaves a row
         * behind — so the queue has to cope with it rather than treat it as
         * impossible.
         *
         * `next()` and not `trackEnded()`, because `trackEnded()` honours
         * repeat-one and would replay the same unplayable track for ever.
         */
        logWarn('queue.unplayable', `skipping ${String(song.id)}`)
        /*
         * `next()` can be a **no-op** — at the end of a list with repeat off it
         * has nowhere to go — and then the current song does not change, this
         * effect does not re-run, and the counter below is never reached. That
         * is the same stall in a different place: the queue sits on a track it
         * can never play. So the move is checked rather than assumed.
         */
        const before = usePlayer.getState().current?.song.id
        if (unplayableRun.current >= MAX_UNPLAYABLE_IN_A_ROW) {
          /*
           * Somewhere to stop. A queue of nothing but undownloaded tracks would
           * otherwise walk itself in a tight loop, and `next()` at the end of a
           * list can hand back the same song — so the counter is what makes
           * this terminate rather than an assumption about the queue's shape.
           */
          logError('queue.allUnplayable', `${unplayableRun.current} in a row`)
          unplayableRun.current = 0
          usePlayer.getState().setPlaying(false)
          showToast(i18n.t('queue.nothingToPlay'))
          return
        }
        unplayableRun.current += 1
        usePlayer.getState().next()
        if (usePlayer.getState().current?.song.id === before) {
          // Nowhere left to go, and nothing here to play.
          logWarn('queue.allUnplayable', 'end of queue with nothing playable')
          unplayableRun.current = 0
          usePlayer.getState().setPlaying(false)
          showToast(i18n.t('queue.nothingToPlay'))
        }
        return
      }
      // Reset on anything that *can* play, so the budget is "in a row" rather
      // than "since launch".
      unplayableRun.current = 0

      await (audioModeReady.current ?? Promise.resolve())
      if (cancelled) return
      player.replace(source)
      // A new source is a new audio session, so whatever the equaliser was
      // attached to has gone with the last track (#303) — and it is worth
      // asking again, however many times the last track refused.
      appliedEq.current[activeDeck] = null
      eqAttempts.current[activeDeck] = 0
      eqPermanent.current[activeDeck] = false
      // Not optional on Android: without an active lock-screen session the OS
      // stops background audio after roughly three minutes (ADR-015). Which
      // session that is depends on the binary — see `announceLockScreen`.
      announceLockScreen(player, song, coverUri, true, sessionInfo)
      // Only if the store actually wants sound. Since #183 a launch can restore a
      // track with `isPlaying` false, and a music app that starts playing because
      // it was opened is exactly what I asked us not to build.
      if (usePlayer.getState().isPlaying) {
        player.play()
        // The ordinary advance path, and the one #396 was reported on.
        reportBackgroundStart(activeDeck, activeDeck)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [song, serverUrl, accessKey, player, activeDeck])

  /**
   * The lock screen's own buttons, and where they go (#395, #397).
   *
   * `expo-audio`'s session offers seek-forward and seek-backward and *removes*
   * next and previous — its callback does not merely fail to add them, it takes
   * them off the session — so the lock screen jumped 15 seconds where the user
   * had asked for the next song. A `ForwardingPlayer` cannot put them back
   * either: a controller sees the **intersection** of the player's commands and
   * the session's. Only owning the session works, which is what this is.
   *
   * Mounted once and never re-run: the session outlives every track, which is
   * the entire repair for the banner going blank at a handover.
   *
   * ## Why the permission comes first (#472)
   *
   * A session, a foreground service and a notification can all be perfectly
   * healthy and still show the user nothing, because `POST_NOTIFICATIONS` is a
   * runtime permission on Android 13+ and a fresh install starts without it.
   * That is what "the media player displays nothing" turned out to be on
   * 2026-08-12 — not #469, which was already right.
   *
   * Asked *before* `startMediaSession` rather than alongside it, so the answer
   * is settled before media3 has anything to post. A dropped `notify()` is
   * silent and is not retried on its own; only the next player event would
   * re-post one, and at launch there is no next event until the user acts.
   */
  useEffect(() => {
    if (!OWNS_SESSION) return
    let cancelled = false
    let probe: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined

    void (async () => {
      /*
       * The app plays without this, so it is logged and never acted on — the
       * same trade `mio-foreground-task` and `mio-media-session` already make.
       * Losing the lock screen is bad; losing playback to a refused permission
       * would be worse.
       */
      const permission = await requestNotificationPermission()
      if (permission !== 'granted' && permission !== 'not_required') {
        logWarn('session.notifications', permission)
      }
      if (cancelled) return

      const reason = startMediaSession()
      // Named rather than a boolean, and logged rather than acted on — the app
      // plays either way.
      if (reason !== 'ok') logWarn('session.start', reason)
      /*
       * **Whether the service actually came up**, sampled late (#432).
       *
       * `reason` reports only that the system accepted the request — the exact
       * distinction `mio-foreground-task` had to learn, where `ok` was logged
       * while the thing it asked for never happened. Starting a foreground
       * service is asynchronous, so reading `isMediaSessionRunning()` on the
       * next line answers `false` on a perfectly healthy phone.
       *
       * Confirmed healthy on the device 2026-08-12: `isForeground=true
       * types=mediaPlayback`, one notification, our session holding the
       * metadata. The question it was built to answer is answered.
       */
      probe = setTimeout(() => {
        logInfo('session.running', String(isMediaSessionRunning()))
      }, 2000)

      unsubscribe = onMediaSessionCommand(({ action, positionMs }) => {
        const store = usePlayer.getState()
        // The store, never the deck: what the user asked for is a change of
        // *track*, and the queue is the only thing that knows what that means.
        if (action === 'play') store.setPlaying(true)
        else if (action === 'pause') store.setPlaying(false)
        else if (action === 'next') store.next()
        else if (action === 'previous') store.previous()
        else if (action === 'seek') store.seekTo(positionMs / 1000)
        logInfo('session.command', action)
      })
    })()

    return () => {
      cancelled = true
      clearTimeout(probe)
      unsubscribe?.()
      stopMediaSession()
    }
  }, [])

  /**
   * Tell the session where the track actually is (#475).
   *
   * ## What was wrong
   *
   * `positionMs: 0` in `announceLockScreen` was the **only** position this
   * session was ever given, and the play/pause effect below re-sent the same
   * remembered object, so it stayed 0 for the life of the track.
   *
   * `JsBackedPlayer.getState()` publishes that stored field through
   * `setContentPositionMs`, and `SimpleBasePlayer` calls `invalidateState()`
   * once a seek's future resolves — so every seek was immediately answered with
   * "we are at the beginning", and the system extrapolated upward from zero.
   * The bar restarting is indistinguishable from the track restarting unless you
   * are listening rather than watching.
   *
   * It only ever looked right because a track does genuinely start at 0 and play
   * forward, so nothing contradicted the lie until something moved.
   *
   * ## Why publishing on events is enough
   *
   * The framework extrapolates from the last published position and its
   * timestamp while the state says PLAYING, which is why every media app
   * publishes on transitions rather than on a timer. Doing this per status tick
   * would call `invalidateState()` twice a second for a number Android can work
   * out for itself.
   *
   * `newTrack: false` throughout, and that is not cosmetic: `SimpleBasePlayer`
   * diffs its playlist by item uid, so claiming a new track here would make the
   * notification rebuild its artwork on every pause.
   */
  const publishSessionPosition = useCallback((positionSeconds: number, playing: boolean) => {
    if (!OWNS_SESSION) return
    const info = sessionInfo.current
    if (!info) return
    const next: MediaSessionInfo = {
      ...info,
      playing,
      // Negative is not reachable from the UI, but `seekRequest` only floors at
      // the store and a rounding error at zero would publish -1.
      positionMs: Math.max(0, Math.round(positionSeconds * 1000)),
      newTrack: false,
    }
    // Written back so the *next* publish starts from the truth rather than from
    // the position this track was born at.
    sessionInfo.current = next
    updateMediaSession(next)
  }, [])

  /** Keep the session's play/pause in step with the store, carrying the live
   *  position with it — a pause that republished 0 sent the bar to the start. */
  useEffect(() => {
    publishSessionPosition(usePlaybackStatus.getState().position, isPlaying)
  }, [isPlaying, publishSessionPosition])

  /**
   * Even out how loud each track plays (P8).
   *
   * The measurement is already done — `ebur128` runs once at import and the
   * result sits on the song row (G4) — so the whole client side is one
   * multiplier. No audio graph is involved, which is why this is the one part of
   * Wave G that came to Android at all.
   *
   * **`ATTENUATE_ONLY` is not a style choice.** `expo-audio` clamps volume to
   * 0..1 in its Android source (`Playable.kt`: `volume?.coerceIn(0f, 1f)`), so a
   * boost above unity is discarded silently. Passing the cap means a quiet track
   * is knowingly left quiet instead of being "corrected" by a value the platform
   * throws away. Most of the benefit survives regardless: it is the loud tracks
   * that jar, and those are attenuated exactly.
   *
   * Kept apart from the load effect for two reasons. That effect returns early
   * when the track has not changed, so a toggle would never reach it; and it
   * defers its work behind `audioModeReady`, while this can apply immediately.
   * Ordering is not a concern — `replace()` calls ExoPlayer's `setMediaSource`,
   * which leaves player-level volume untouched, so a gain set before a track
   * loads still applies to it.
   */
  useEffect(() => {
    if (!song) return
    deckSongs.current[activeDeck] = song
    applyGainFor(activeDeck)
  }, [song, activeDeck, applyGainFor])

  /** Playback speed (#234). Its own effect: it changes independently of the
   *  track and of loudness, and folding it in would re-apply gain on a rate
   *  change for no reason. */
  useEffect(() => {
    applyPlaybackRate(player, playbackRate)
  }, [playbackRate, player])

  /**
   * The sleep timer's wall-clock half (#234), and its fade (#241).
   *
   * `sleepAt` is an absolute time, so there is nothing to count down and nothing
   * to keep in sync — the wait is one timeout. The end-of-track half needs no
   * timer at all and lives in the store's `trackEnded`.
   *
   * It clears itself on firing, because a sleep timer is a one-shot instruction
   * — leaving it armed would stop the next thing the user played.
   *
   * ## The fade needs no native module
   *
   * This was written as "#241 needs the volume ramp a native module would
   * give", which was wrong and worth correcting: `player.volume` is a settable
   * property, so a ramp is a multiplier moved on an interval. That is not what
   * a native module would buy — a Web Audio `linearRampToValueAtTime` is
   * sample-accurate and this is a step every {@link FADE_STEP_MS} — but the
   * distinction is inaudible on a gentle ramp, and the alternative is cutting
   * the audio dead at the moment someone is falling asleep.
   *
   * Crossfade (#201) and the equaliser (#202) really do need one. They need to
   * hear *two* streams, or to reshape one. This only needs to scale it.
   *
   * ## The fade multiplies, and it always resets
   *
   * It is a third factor in `applyLoudnessGain`, so the loudness correction
   * still applies underneath — the thing #241 asks to keep.
   *
   * Resetting to 1 is the part that must not be forgotten: it happens when the
   * timer is armed, when it is cancelled, when the effect is torn down and when
   * it fires. A fade left at 0 is an app that plays nothing next time it is
   * opened, with a volume slider that says it is turned up.
   */
  useEffect(() => {
    const restore = () => {
      sleepFade.current = 1
      applyGainFor(activeDeck)
    }

    if (sleepAt === null) {
      restore()
      return
    }

    // No `restore()` here, deliberately: `setSleepTimer(null)` changes `sleepAt`,
    // which tears this effect down and runs it again, and both paths restore.
    // Calling it a third time looked like belt and braces and was dead code —
    // a mutation that deleted it killed no test, which is how it was found.
    const stop = () => {
      usePlayer.getState().setPlaying(false)
      usePlayer.getState().setSleepTimer(null)
    }

    const step = () => {
      const left = sleepAt - Date.now()
      if (left <= 0) {
        stop()
        return
      }
      sleepFade.current = Math.max(0, Math.min(1, left / FADE_MS))
      applyGainFor(activeDeck)
    }

    const remaining = sleepAt - Date.now()
    // Already past — a timer restored from a backgrounded app, or one set for a
    // moment that has been and gone. Nothing to fade; it is already over.
    if (remaining <= 0) {
      stop()
      return
    }

    sleepFade.current = 1
    let interval: ReturnType<typeof setInterval> | null = null
    const beginFade = () => {
      step()
      interval = setInterval(step, FADE_STEP_MS)
    }

    // Two timers rather than one interval for the whole wait: a sleep timer is
    // usually tens of minutes, and ticking five times a second through all of it
    // to do nothing would keep the JS thread awake for no reason.
    const handle = setTimeout(beginFade, Math.max(0, remaining - FADE_MS))

    return () => {
      clearTimeout(handle)
      if (interval !== null) clearInterval(interval)
      // Cancelling mid-fade must not leave the music quiet.
      restore()
    }
  }, [sleepAt, activeDeck, applyGainFor])

  /**
   * Remember where playback got to, and go back there next time (#183).
   *
   * The position lives on the native player rather than in the store, so it has
   * to be copied across as it changes. `status` ticks about twice a second, and
   * persisting each tick would write to AsyncStorage a few hundred times a song
   * for a value nothing reads until the next launch — so writes are throttled,
   * and pausing records the exact second because that is both cheap and the
   * moment someone is most likely to leave.
   */
  const lastResumeWrite = useRef(0)
  useEffect(() => {
    if (!song || !status.isLoaded) return
    const seconds = status.currentTime
    if (!Number.isFinite(seconds)) return

    /*
     * A position of zero is never worth writing, and writing it was a real bug:
     * on a restored, paused track this effect ran before the seek below had
     * taken effect, saw `currentTime === 0` and `isPlaying === false`, and
     * **overwrote the stored position with 0** — the feature destroying its own
     * data before anything could read it. Zero is also the fallback when nothing
     * is stored, so skipping it costs nothing.
     */
    if (seconds <= 0) return

    const far = Math.abs(seconds - lastResumeWrite.current) >= RESUME_WRITE_SECONDS
    if (far || !isPlaying) {
      lastResumeWrite.current = seconds
      useResume.getState().set(song.id, seconds)
    }
  }, [song, status.isLoaded, status.currentTime, isPlaying])

  /**
   * Whether the resume point has come back from storage yet.
   *
   * Needed only because `resume` is its own store now (E3): it rehydrates
   * independently of `usePlayer`, so at launch there is a window where the queue
   * is restored and the position is still `null`. The effect below spends its
   * one shot per track, so reading during that window would lose the position
   * silently — the feature appearing to work except when it did not.
   *
   * Initialised from `hasHydrated()` rather than `false`, because hydration is
   * usually finished before this mounts and waiting for a callback that has
   * already fired would hang the seek forever.
   */
  const [resumeReady, setResumeReady] = useState(() => useResume.persist.hasHydrated())
  useEffect(() => useResume.persist.onFinishHydration(() => setResumeReady(true)), [])

  /**
   * Seek a restored track back to where it stopped.
   *
   * Waits for `isLoaded`: seeking a source the native player has not finished
   * preparing is dropped silently, which would look like the feature simply not
   * working. Applied once per track — a later `isLoaded` must not drag playback
   * back to a position it has already passed.
   */
  const restoredFor = useRef<string | number | null>(null)
  useEffect(() => {
    if (!song || !status.isLoaded) return
    // **Before** the one-shot is spent: an unhydrated store answers `null`,
    // which is indistinguishable from "no position stored" and would burn this
    // track's only attempt.
    if (!resumeReady) return
    if (restoredFor.current === song.id) return
    restoredFor.current = song.id

    const resume = useResume.getState().point
    if (!resume || resume.songId !== song.id || resume.seconds <= 0) return
    lastResumeWrite.current = resume.seconds
    void player.seekTo(resume.seconds)
  }, [song, status.isLoaded, player, resumeReady])

  /**
   * Apply a scrub the panel asked for (#231).
   *
   * Cleared as soon as it is applied, so the request can never be re-run by an
   * unrelated render — which would yank the track back to wherever the user last
   * dragged, minutes later.
   *
   * `restoredFor` is updated too. Without that, the resume effect could still be
   * waiting for `isLoaded` on this track and would immediately drag playback
   * back to the stored position, undoing the scrub.
   */
  useEffect(() => {
    if (!seekRequest) return
    restoredFor.current = song?.id ?? null
    lastResumeWrite.current = seekRequest.seconds
    void player.seekTo(seekRequest.seconds)
    usePlayer.getState().clearSeekRequest()
    /*
     * Publish where we landed (#475), from the request rather than from the
     * status store: `seekTo` is asynchronous and the next status tick is up to
     * half a second away, so reading the position here would publish the one we
     * just left — and the lock screen would show the seek undoing itself.
     *
     * This covers a seek from *either* end. The lock screen's scrubber and the
     * in-app one are the same store action, which is the point of routing
     * lock-screen commands through `usePlayer` rather than at a deck.
     */
    publishSessionPosition(seekRequest.seconds, usePlayer.getState().isPlaying)
  }, [seekRequest, song, player, publishSessionPosition])

  /**
   * Replay the current track from the start, when the store asks.
   *
   * Driven by a counter rather than by comparing state, because repeat-one and
   * pressing previous both mean "play what is already current again" — which
   * changes no state a diff could detect.
   */
  const appliedNonce = useRef(restartNonce)
  useEffect(() => {
    if (appliedNonce.current === restartNonce) return
    appliedNonce.current = restartNonce
    if (!song) return
    generation.current += 1
    void player.seekTo(0)
    player.play()
  }, [restartNonce, song, player])

  /**
   * Keep the equaliser on both decks (#202), and get it onto the *first* track
   * (#303).
   *
   * An `AudioEffect` attaches to an audio *session*, and a deck has no session
   * until it has something to play. This used to re-apply when `song` changed,
   * which sounds like the same thing and is not: `song` changes in the **store**,
   * while `player.replace(source)` happens later, behind two awaits inside the
   * load effect. ExoPlayer reports `audioSessionId == 0` until its renderer is
   * initialised, and the Kotlin side rejects 0 — correctly, since session 0 is
   * the global output mix. So the first `setGains` after a track loaded always
   * answered false, and nothing ever ran it again: the equaliser started
   * working on the *second* track, or when a band was next moved. That is
   * exactly what "it doesn't apply to the track that's playing" was.
   *
   * So it is driven by **what the deck reports**, not by what the store
   * intends: every status tick is a chance to attach, and `appliedEq` records
   * what actually took so the retry stops the moment it does. `setGains` is
   * idempotent and reuses the session's processor, so a repeat is cheap — but a
   * repeat every 500 ms forever is not, which is why the answer is remembered.
   *
   * Both decks, every time. Crossfade (#201) means two sessions are audible at
   * once during a transition, and equalising only the active one would make
   * every fade audibly change tone half way through. A deck holding no song is
   * skipped rather than retried: with crossfade off `deckB` is never fed, and
   * asking it twice a second for the life of the app would be a native call
   * that cannot ever succeed.
   *
   * `applyEqualizer` answers false rather than throwing when there is no native
   * module, no session yet, or an OS below API 28 — so this is a no-op on a
   * build that predates the module rather than a crash on launch.
   */
  // A curve the user has just changed is a new question, and deserves asking
  // even if the last one was refused ten times — unless the refusal was one that
  // a different curve cannot change, which is what `eqPermanent` records.
  useEffect(() => {
    eqAttempts.current = [
      eqPermanent.current[0] ? EQ_ATTEMPT_LIMIT : 0,
      eqPermanent.current[1] ? EQ_ATTEMPT_LIMIT : 0,
    ]
  }, [eqGains])

  const syncEqualizer = useCallback(() => {
    decks.forEach((deck, index) => {
      if (!deckSongs.current[index]) return
      if (sameGains(appliedEq.current[index], eqGains)) return
      if (eqAttempts.current[index] >= EQ_ATTEMPT_LIMIT) return
      eqAttempts.current[index] += 1
      const reason = applyEqualizer(deck, eqGains)
      const took = reason === 'ok'
      appliedEq.current[index] = took ? [...eqGains] : null

      // A permanent refusal is not worth the remaining attempts. Only a
      // renderer without its session yet improves by being asked again, so
      // everything else burns the budget here rather than making a native call
      // on every status tick for the life of the track.
      if (!took && !isTransientEqualizerReason(reason)) {
        eqAttempts.current[index] = EQ_ATTEMPT_LIMIT
        eqPermanent.current[index] = true
      }

      // Published for the deck the user is listening to, so the panel can say
      // whether the curve is on the audio instead of implying it (#303).
      if (index === activeDeck) useEqualizerReach.getState().setReaching(reason)

      // Logged once per refusal, not per attempt: `sameGains` and the attempt
      // budget above both gate this, so a stuck deck cannot flood the bounded
      // diagnostics buffer and push out everything else in it.
      // A reason code, a deck index and a count — nothing that identifies a
      // track, so this satisfies `scrub()`'s invariant by construction rather
      // than by being filtered (#354).
      if (!took) {
        logWarn('equalizer.refused', `${reason} deck=${index} attempt=${eqAttempts.current[index]}`)
      }
    })
  }, [decks, eqGains, activeDeck])

  /**
   * Put the balance on both decks (#380).
   *
   * Separate from `syncEqualizer` rather than folded into it, because that
   * function returns early when the curve is unchanged — and balance moves on
   * its own schedule, so a user who never touches the bands would otherwise
   * never have a balance applied at all.
   *
   * It rides the *same* `DynamicsProcessing`, so it inherits the same
   * readiness problem: a renderer with no audio session yet refuses, and asking
   * again a moment later works. That is what `isTransientEqualizerReason`
   * already encodes, so this reuses it rather than inventing a second rule.
   *
   * Both decks, for the reason the equaliser does it: a crossfade would
   * otherwise pan half way through the transition.
   */
  const syncBalance = useCallback(() => {
    decks.forEach((deck, index) => {
      if (!deckSongs.current[index]) return
      if (appliedBalance.current[index] === balance) return
      const reason = applyBalance(deck, balance)
      if (reason === 'ok') {
        appliedBalance.current[index] = balance
        return
      }
      // A permanent refusal stops the retry, exactly as the bands do. Logged
      // once per deck per refusal for the same reason — a reason code and an
      // index name nothing about a track, so `scrub()`'s invariant holds by
      // construction (#354).
      if (!isTransientEqualizerReason(reason)) {
        appliedBalance.current[index] = balance
        logWarn('balance.refused', `${reason} deck=${index}`)
      }
    })
  }, [decks, balance])

  useEffect(() => {
    if (!song) {
      // Nothing playing is no session, which is not a refusal — saying "not
      // reaching the audio" for silence would be its own lie.
      useEqualizerReach.getState().setReaching(null)
      return
    }
    syncEqualizer()
    syncBalance()
  }, [syncEqualizer, syncBalance, song, activeDeck, status.isLoaded, status.currentTime])

  /*
   * Mono, which is **not** part of the sync above (#482).
   *
   * The effect above runs on every status tick because the EQ and balance
   * attach to a *session*, and a deck does not have one until its renderer
   * starts — so they have to be retried as tracks load. Mono is a flag inside
   * the audio sink that every player already carries, set once for the process:
   * there is nothing to retry, nothing to re-apply per deck, and nothing about
   * it that changes when a song does.
   *
   * So it hangs off the setting alone, and a refusal is logged once rather than
   * on a loop. `no_processor` means a binary built before the config plugin,
   * which is a fact about the build and not something a retry can improve.
   */
  useEffect(() => {
    const reason = applyMono(mono)
    if (reason !== 'ok') logWarn('mono.refused', reason)
  }, [mono])

  /*
   * There is deliberately **no equaliser cleanup here** — and this is the
   * second time this file has learned it (#189).
   *
   * There used to be one: an effect whose cleanup called `releaseEqualizer` on
   * both decks, to hand the `AudioEffect`s back because they are a limited
   * global resource on Android. It could never work, and on a device it threw
   * on every unmount — which under Fast Refresh is constantly:
   *
   *     Call to function 'MioEqualizer.release' has been rejected.
   *     → the 1st argument cannot be cast to SharedRef (received Integer)
   *     → Cannot use shared object that was already released
   *
   * The two lines are one story. `useAudioPlayer` builds each deck with
   * `useReleasingSharedObject`, whose own cleanup calls `release()`; that hook
   * runs at the top of this component, so its cleanup is registered *first*,
   * and React runs cleanups in declaration order. By the time ours ran the
   * native object was always gone — and a released `SharedObject` no longer
   * converts to a `SharedRef`, so what reaches Kotlin is the bare handle,
   * an `Integer`. That is what the first line is complaining about.
   *
   * It was also unnecessary. The module's `OnDestroy` already releases every
   * processor it holds and clears the map, which is the same reclamation at the
   * only moment it can safely happen.
   *
   * The rule this file now has twice over: **nothing here may touch a deck in
   * an unmount cleanup.** `expo-audio` has already taken it away.
   */

  /**
   * The background window, and what used to happen at the start of it (#470).
   *
   * This effect used to call `finishFadeNow` here, snapping a fade in flight to
   * its end the moment the app was minimised (#455). That was the right trade
   * while the ramp's only driver was a `setInterval`, which Android stops on
   * host pause: the alternative was both decks holding a partial gain forever,
   * with the outgoing one never paused.
   *
   * It is no longer the right trade, because the ramp has a second driver that
   * survives the pause — `expo-audio`'s status heartbeat, measured at 272 ticks
   * over 135 s backgrounded. So a fade begun in the foreground and minimised
   * half way through now *continues* rather than being cut short, and one begun
   * while away runs at ~2 Hz instead of not at all.
   *
   * The listener stays, because it is still the thing that knows when the window
   * opens and closes, and `AppState` events arrive when timers do not.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (!appIsActive(state)) {
        // Start the window. Reset rather than accumulated, so each trip away is
        // its own measurement and a rate can be worked out from one line.
        backgroundTicks.current = { since: Date.now(), count: 0 }
        return
      }

      /*
       * Report the trip that just ended (#470).
       *
       * Logged on the way *back* and never while away, because `logInfo` writes
       * to a store the diagnostics screen reads — and a line written during the
       * window would be one more thing to explain if it turned out the JS thread
       * was not running at all.
       *
       * `expected` is what a live 500 ms heartbeat would have produced over the
       * same window, so the line answers the question by itself instead of
       * needing the reader to do arithmetic on a device report. `ticks` near
       * `expected` means the ramp can be driven from this event in JavaScript;
       * `ticks=0` means #470 needs the native ticker.
       */
      const line = heartbeatReport(
        backgroundTicks.current,
        Date.now(),
        usePlayer.getState().isPlaying,
      )
      backgroundTicks.current = { since: 0, count: 0 }
      if (line) logInfo('queue.heartbeat', line)
    })
    /*
     * Optional, because a cleanup that throws is worse than one that does
     * nothing. React Native's `addEventListener` returns a subscription; the
     * jest environment's returns `undefined`, and the first version of this
     * took eleven tests down from inside an unmount — which on a device is the
     * player disappearing rather than a red suite. Same rule as never touching
     * a deck in an unmount cleanup.
     */
    return () => subscription?.remove()
  }, [])

  /**
   * Crossfade into the next track (#201).
   *
   * Driven off the active deck's status ticks — about twice a second — rather
   * than a timer set at load, because a seek moves the end without warning and
   * a timer would then fade at the wrong moment.
   *
   * ## What happens, in order
   *
   * 1. Ask the store what it *would* play next (`peekNextSong`), so the fade
   *    brings in the track the queue will actually advance to.
   * 2. Load it on the idle deck at silence and start it.
   * 3. Hand over the lock screen and call `trackEnded()`, so the UI and the
   *    lock screen name the incoming track from the moment it becomes audible.
   * 4. Ramp both decks along the equal-power curve.
   * 5. Stop the outgoing deck and let go of it.
   *
   * Step 3 sitting *before* the ramp rather than after is the judgement call.
   * It means `current` changes while the old track is still audible — but the
   * alternative is a lock screen naming a track that is fading away, and a
   * "next" press mid-fade skipping to the wrong place.
   */
  useEffect(() => {
    const state = usePlayer.getState()
    const next = peekNextSong(state)
    if (
      !shouldStartCrossfade({
        currentTime: status.currentTime,
        duration: status.duration ?? null,
        nextDuration: next?.duration ?? null,
        requestedSeconds: crossfadeSeconds,
        hasNext: next !== null,
        transitioning: transitioning.current,
        isPlaying,
      }) ||
      !next
    ) {
      return
    }

    const outgoing = activeDeck
    const incoming: 0 | 1 = outgoing === 0 ? 1 : 0
    const seconds = effectiveCrossfadeSeconds(
      crossfadeSeconds,
      status.duration ?? null,
      next.duration ?? null,
    )
    setTransitioning(true)

    let cancelled = false
    /**
     * Whether this run got as far as handing over to the ramp — #304.
     *
     * The latch used to be set here and cleared only by the ramp's last step,
     * which meant **every** other way out of the async work below left it set
     * forever, and `shouldStartCrossfade` then answered false for the rest of
     * the app's life. Crossfade died silently, after one race, and the race was
     * easy to lose: this effect re-runs on every status tick — twice a second —
     * and React runs the previous cleanup first, so any tick landing inside the
     * two awaits below cancelled the run mid-flight.
     *
     * The `finally` is the fix and the flag is what makes it safe: the one path
     * that must *not* clear the latch is the one that succeeded, because there
     * the fade is genuinely still running and the ramp will clear it when it
     * ends. Everything else — cancelled, no source, or a throw — clears it, so
     * the next tick simply tries again.
     */
    let started = false

    void (async () => {
      try {
        // The same lookup the load effect does: a device-fetched song already
        // carries its `file_uri`, a server one has to be found by its id.
        let fileUri: string | null = next.file_uri ?? null
        let coverUri: string | null = null
        try {
          const local =
            typeof next.id === 'number'
              ? await getLocalSongByServerId(next.id)
              : await getLocalSong(next.id)
          fileUri ??= local?.file_uri ?? null
          coverUri = local?.cover_uri ?? null
        } catch {
          // A database that will not open must not stop playback.
        }
        if (cancelled) return

        const source = audioSourceFor(next, serverUrl, accessKey, fileUri)
        // Nothing to fade into. Let the ordinary end-of-track path handle it.
        if (!source) return

        await (audioModeReady.current ?? Promise.resolve())
        if (cancelled) return

        // From here down there is no await, so nothing can cancel this run
        // half-built: either the ramp is set up, or it never started.
        started = true

        deckSongs.current[incoming] = next
        crossFade.current[incoming] = 0
        crossFade.current[outgoing] = 1
        decks[incoming].replace(source)
        // A new source is a new audio session on that deck (#303).
        appliedEq.current[incoming] = null
        eqAttempts.current[incoming] = 0
        eqPermanent.current[incoming] = false
        applyGainFor(incoming)
        decks[incoming].play()
        // The crossfade path reaches the same question by a different route, and
        // it is the one where candidate 3 is live: a ramp that does not run
        // leaves this deck at the gain set two lines above — zero.
        reportBackgroundStart(incoming, incoming)

        // The lock screen moves with the store, not with the audio: from here
        // on the incoming track is what the user is listening to.
        //
        // With `OWNS_SESSION` this stops being a handover at all — there is one
        // session and this is a metadata update on it, which is the whole of
        // why the banner used to go blank exactly here.
        announceLockScreen(decks[incoming], next, coverUri, true, sessionInfo)
        // Claimed so the load effect sees the track it is about to be told
        // about as already loaded, and does not `replace()` it a second time.
        loadedId.current = next.id
        generation.current += 1
        setActiveDeck(incoming)
        usePlayer.getState().trackEnded()

        /**
         * End the fade here and now, wherever the curve had got to.
         *
         * Extracted so the two ways a fade can end share one path: the ramp
         * reaching 1, and the app being minimised part-way (#455). The second
         * one used to have no path at all — the interval simply stopped, and
         * both decks sat at whatever partial gain they had reached, with the
         * outgoing one never paused. Two tracks, both quiet, until the app came
         * back.
         */
        const finishFade = () => {
          /*
           * **Did the fade actually fade?** (#467)
           *
           * I has reported hearing no crossfade across three device passes,
           * while every reading said the transition itself worked. Those are
           * different claims and nothing in the app could tell them apart: a
           * ramp that ran 240 times over 12 seconds and one that ran twice
           * produce the same track change and the same logs.
           *
           * So this counts. `steps` against `plannedMs` is the whole answer —
           * a healthy 12-second fade at CROSSFADE_STEP_MS is ~240 steps, and
           * anything in single figures is a ramp that was frozen, cut short, or
           * never really ran. `vol` is what the incoming deck actually reached,
           * read back rather than assumed, because the gain we intend and the
           * volume the player holds have disagreed before.
           */
          logInfo(
            'queue.fade',
            `steps=${fadeSteps} over=${Date.now() - startedAt}ms planned=${Math.round(seconds * 1000)}ms` +
              ` gain=${crossFade.current[incoming].toFixed(2)}` +
              ` vol=${typeof decks[incoming].volume === 'number' ? decks[incoming].volume.toFixed(2) : '?'}` +
              ` state=${AppState.currentState}`,
          )
          if (fadeTimer.current !== null) clearInterval(fadeTimer.current)
          fadeTimer.current = null
          finishFadeNow.current = null
          // The heartbeat keeps arriving long after the fade ends, so the
          // status effect must stop finding a step to call (#470).
          fadeStep.current = null
          crossFade.current[incoming] = 1
          applyGainFor(incoming)
          decks[outgoing].pause()
          // Reset rather than leave at zero: this deck is the *next* incoming
          // one, and a deck left silent would fade in from nothing to nothing.
          crossFade.current[outgoing] = 1
          deckSongs.current[outgoing] = null
          setTransitioning(false)
        }
        finishFadeNow.current = finishFade

        let startedAt = Date.now()
        let steppedAt = startedAt
        /** How many times the ramp actually ran, which is the #467 measurement. */
        let fadeSteps = 0
        const step = () => {
          fadeSteps += 1
          const now = Date.now()
          /*
           * Paused mid-fade: hold the curve exactly where it is, and push the
           * fade's clock along with the wall clock so that resuming continues
           * the fade instead of finding it already over.
           *
           * Found on a device: pausing during a transition left both tracks
           * ramping on regardless, so a fade paused half way through came back
           * finished — the outgoing track gone and the incoming one at full
           * level, having crossfaded to nobody.
           */
          if (!usePlayer.getState().isPlaying) {
            startedAt += now - steppedAt
            steppedAt = now
            return
          }
          steppedAt = now

          const progress = (now - startedAt) / (seconds * 1000)
          const gains = equalPowerGains(progress)
          crossFade.current[outgoing] = gains.outgoing
          crossFade.current[incoming] = gains.incoming
          applyGainFor(outgoing)
          applyGainFor(incoming)
          if (progress < 1) return
          finishFade()
        }
        /*
         * **Two drivers, and the second one is why this works backgrounded**
         * (#470).
         *
         * The interval is the smooth one — 50 ms, ~240 steps across a
         * 12-second fade — and it is dead the moment Android pauses the
         * activity. The heartbeat is `expo-audio`'s `playbackStatusUpdate`,
         * emitted from a Kotlin coroutine on the main looper, which keeps
         * arriving while the app is away: measured at 272 ticks over 135 s.
         * At ~2 Hz that is ~24 steps across the same fade.
         *
         * Running both is safe because `step` is **wall-clock**, not
         * step-counted: it recomputes progress from `Date.now()` every time, so
         * an extra caller changes the resolution of the ramp and never its
         * shape or its duration. In the foreground both fire and the interval
         * dominates; in the background only the heartbeat does.
         */
        fadeStep.current = step
        fadeTimer.current = setInterval(step, CROSSFADE_STEP_MS)
      } finally {
        // The ramp owns the latch from here; every other way out gives it back.
        if (!started) setTransitioning(false)
      }
    })()

    /**
     * Only the *load* is cancellable, never the ramp.
     *
     * This effect flips `activeDeck`, which is one of its own dependencies, so
     * it tears itself down the moment a fade starts. Clearing the interval here
     * — the obvious thing, and what this did first — killed every fade on its
     * first tick: the incoming deck stayed at silence and the outgoing one
     * never stopped. The ramp therefore lives in a ref and is cleared on
     * unmount, below.
     */
    return () => {
      cancelled = true
    }
    // `status.currentTime` is the tick this watches; the rest are read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.currentTime, crossfadeSeconds, isPlaying, activeDeck])

  /**
   * Advance when a track plays out.
   *
   * Latched on `generation` so one ending is handled once: `didJustFinish`
   * stays true across status ticks, and firing per tick would skip several
   * tracks at the end of every song.
   */
  useEffect(() => {
    const finished = status.didJustFinish === true
    /*
     * **A rising edge, not a level** — the whole of #444.
     *
     * The latch below compares `finishedGeneration` with `generation`, and
     * `generation` is bumped by the *load* that this very ending causes. So a
     * second `didJustFinish` arriving after the next track has loaded — a
     * trailing event from the replaced source, or the flag flapping false and
     * true again — sees a generation it has not handled and advances a second
     * time. One ending, two `trackEnded()` calls.
     *
     * That is my 2026-08-09 report exactly: *"1 -> 2 (forced jump) -> 3
     * (finish playing) -> 4 (forced jump) -> 5"*. The skipped track is loaded
     * and announced — I watched its artwork appear on the lock screen — and is
     * then advanced past before a note of it plays. It alternates because the
     * spurious fire consumes the generation the *next* real ending would have
     * used.
     *
     * It disappears with crossfade on because that path hands over to the other
     * deck, and `status` then follows a deck whose flag was never set.
     */
    const rising = finished && !wasFinished.current
    wasFinished.current = finished

    /*
     * …and a second guard, because the edge alone does not cover it.
     *
     * If the flag goes false and true again — which is what a trailing event
     * from the replaced source looks like — the edge is genuine and the advance
     * fires anyway. The discriminator that survives is **time**: a real track
     * takes minutes to end, and a spurious ending arrives in the moment after
     * the last one.
     *
     * The clock was the obvious alternative and is not usable: a genuine ending
     * can report `currentTime: 0`, so gating on "near the end" would block real
     * advances and stop the queue — which is worse than the bug.
     *
     * Two seconds cannot swallow a real track. It could swallow a repeat-one of
     * something shorter than that, which is a trade taken knowingly.
     */
    const sinceLastEnding = Date.now() - lastEndingAt.current
    const tooSoon = sinceLastEnding < MIN_MS_BETWEEN_ENDINGS

    if (!rising || tooSoon) {
      /*
       * Logged, and this is the line that decides whether the reading above is
       * right. A suppression landing immediately after a track loads is the
       * double-advance being caught; none at all means the second fire came
       * from somewhere this guard does not cover, and the search moves on.
       *
       * Only the interesting half: a plain `false` is every ordinary tick.
       */
      /*
       * Logged with **why**, and this is the line that says whether the reading
       * above is right. A suppression landing right after a track loads is the
       * double-advance being caught; `reason=edge` and `reason=soon` say which
       * guard did it, which is the difference between the flag being re-read
       * and a trailing event from the source that was replaced.
       *
       * Only the interesting half: a plain `false` is every ordinary tick.
       */
      if (finished) {
        logInfo(
          'queue.endingIgnored',
          `reason=${!rising ? 'edge' : 'soon'} gen=${generation.current}` +
            ` since=${sinceLastEnding}ms at=${status.currentTime?.toFixed?.(1) ?? '?'}`,
        )
      }
      return
    }
    lastEndingAt.current = Date.now()
    if (finishedGeneration.current === generation.current) return
    finishedGeneration.current = generation.current
    /*
     * Timestamped, because we do not yet know that this is the broken hop
     * (#371, ADR-019).
     *
     * Bug 4 — "the track paused when the last one finished; I reopened and the
     * next one was already playing" — was diagnosed as Android suspending the
     * app's JavaScript. Reading `expo-audio`'s Android source argues against
     * that: `setActiveForLockScreen(true)` binds a `MediaSessionService` that
     * calls `startForeground`, and a process with a foreground service is
     * exempt from the cached-app freezer. So while music plays, the app is not
     * frozen and this effect should run.
     *
     * There are four hops between the track ending and this line — ExoPlayer,
     * a Kotlin coroutine poll (`BaseAudioPlayer.startUpdating`), the JS event,
     * then React rendering this effect — and reading cannot say which one
     * stalls. `AppState` is recorded with it because the answer is entirely
     * "was the app in the background when this ran, or had it just resumed".
     *
     * The diagnostic goes in **before** the fix, which is the lesson three of
     * this cluster's four reports already cost once.
     */
    // The deck and its clock ride along, because a genuine ending happens at
    // the end of a track and a spurious one does not — so the next report can
    // tell them apart without another build.
    logInfo(
      'queue.trackEnded',
      `${AppState.currentState} gen=${generation.current}` +
        ` at=${status.currentTime?.toFixed?.(1) ?? '?'}/${status.duration ?? '?'}`,
    )
    usePlayer.getState().trackEnded()
    // The clock is *read* for the log, never watched: `currentTime` changes
    // twice a second, and re-running this effect on every tick is precisely the
    // shape of repeated firing the guards above exist to stop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.didJustFinish])

  /** The last command we issued to the player. */
  const appliedIntent = useRef<boolean | null>(null)
  /** Whether the player has been *seen* obeying that command yet. */
  const obeyed = useRef(false)

  /**
   * Apply play/pause intent — to **every deck that is holding a track**.
   *
   * Guarded by a ref so a status tick, which arrives twice a second, does not
   * re-issue a command the player is already obeying.
   *
   * It used to command only the active deck, which is the same thing except
   * during a crossfade — when two decks are audible and only one of them
   * stopped. Reported from a device: "when 2 tracks are crossfading and I hit
   * pause, it should pause both; now the track that's fading still plays."
   *
   * A deck with no song is skipped rather than commanded: with crossfade off
   * `deckB` is never fed, and pausing a player that has loaded nothing is a
   * native call that means nothing.
   */
  useEffect(() => {
    if (!current) {
      appliedIntent.current = null
      obeyed.current = false
      return
    }
    if (appliedIntent.current === isPlaying) return
    appliedIntent.current = isPlaying
    obeyed.current = false
    decks.forEach((deck, index) => {
      if (!deckSongs.current[index]) return
      if (isPlaying) deck.play()
      else deck.pause()
    })
  }, [current, isPlaying, decks])

  /**
   * Reflect what the player actually did back into the store, so an OS-driven
   * pause — a phone call, another app taking audio focus — shows up in the UI.
   *
   * The `obeyed` latch is what makes this safe. A command is asynchronous: for
   * a tick or two after `play()` the status still reads `playing: false`, and
   * writing that straight back would cancel the user's own tap. So a
   * disagreement only counts as the OS intervening *after* we have seen the
   * player agree with us at least once.
   *
   * Buffering is excluded for the same reason: a stall reports `playing: false`
   * without anyone having pressed pause.
   */
  useEffect(() => {
    if (!current || !status.isLoaded || status.isBuffering) return
    /*
     * A crossfade is the one time this cannot be believed at all.
     *
     * `status` follows the **active** deck, and a handover moves it. For a
     * render or two it still describes the deck being left, and then it
     * describes one that has not started reporting yet — so a `playing: false`
     * arrives that is about neither the OS nor the user. Acting on it stopped
     * the music half way through the fade, which is also how the fade came to
     * look like it was not fading: the store said paused, and the decks carried
     * on regardless.
     *
     * `fading` is state rather than the ref beside it precisely so that this
     * effect re-runs when the fade ends, at which point the latch is dropped
     * and the new deck has to confirm for itself before anything is believed
     * about it.
     */
    if (fading) {
      obeyed.current = false
      return
    }
    if (status.playing === appliedIntent.current) {
      obeyed.current = true
      return
    }
    if (!obeyed.current) return
    appliedIntent.current = status.playing
    setPlaying(status.playing)
  }, [current, fading, status.isLoaded, status.isBuffering, status.playing, setPlaying])

  /*
   * There is deliberately **no unmount cleanup here** (#189).
   *
   * There used to be one — `clearLockScreenControls()` in an effect cleanup, to
   * stop the media notification outliving the player. It could never work, and
   * it crashed the app on resume:
   *
   *     Call to function 'AudioPlayer.clearLockScreenControls' has been rejected.
   *     → Caused by: Cannot use shared object that was already released
   *
   * `useAudioPlayer` builds the player with `useReleasingSharedObject`, whose own
   * effect cleanup calls `release()`. That hook runs at the top of this
   * component, so its cleanup is registered *first* — and React runs cleanups in
   * declaration order. By the time ours ran, the native object was always gone.
   *
   * It was also redundant. Android's `AudioPlayer.releasePlayer()` already calls
   * `mediaSession.release()`, unregisters from the foreground service when
   * `isActiveForLockScreen`, and unbinds; `sharedObjectDidRelease()` releases the
   * service connection. Releasing the player *is* the teardown.
   *
   * `SharedObject` exposes no liveness flag, only `release()`, so there is
   * nothing to guard on — which is the other reason not to reinstate this with a
   * check. A try/catch would work and would swallow real errors alongside this
   * one.
   *
   * Clearing the controls when playback *stops* is a different thing and still
   * happens above, while the player is alive.
   */

  /**
   * Publish what the player is doing, for `MiniPlayer` and the queue screen.
   *
   * In an effect rather than during render because a store write while
   * rendering is a side effect on a value other components subscribe to — React
   * may warn, and under concurrent rendering it can be run twice. The store
   * bails out when nothing changed, so a paused player publishes once and then
   * goes quiet despite `status` ticking on.
   */
  /**
   * A track that will not play, written down (#322).
   *
   * Keyed on the error and the song rather than on the whole status, so it
   * fires when a failure *appears* rather than on every tick of a player that
   * is already failed. The user sees this as "it just doesn't play", with
   * nothing on screen naming the file or the reason — which is precisely the
   * kind of report that has been impossible to act on.
   */
  useEffect(() => {
    if (!song || !status.error) return
    // The player's error, not the song. What failed to play is the user's
    // listening history; why it failed is the bug (#354).
    logError('playback.failed', status.error)
  }, [song, status.error])

  useEffect(() => {
    /*
     * **Does expo-audio's heartbeat survive being backgrounded?** (#470)
     *
     * The one fact #470's whole design rests on, and it is not readable. What
     * *is* readable: `BaseAudioPlayer.startUpdating` emits `playbackStatusUpdate`
     * from a Kotlin coroutine on `Dispatchers.Main` driven by `delay()`
     * (`BaseAudioPlayer.kt:52-68`) — a **native** timer, not a JS one, so nothing
     * in `JavaTimerManager` can stop it.
     *
     * ⚠️ **The background advance is not evidence for this.** `didJustFinish`
     * comes from `onPlaybackStateChanged` (`:99`), a player *listener*, so the
     * queue advancing while minimised proves event **delivery** and says nothing
     * about the **periodic** loop. Two different mechanisms, and only one of
     * them is the one a ramp would need.
     *
     * So this counts, and it deliberately changes no behaviour: if the count
     * comes back healthy the ramp can be driven from this event in JavaScript,
     * and if it comes back zero #470 needs the native ticker after all. Either
     * answer is worth more than the guess it replaces.
     *
     * Counted here rather than on a new listener because this effect already
     * re-runs on every status change, so the instrument costs one comparison
     * and cannot itself be the thing that breaks.
     */
    if (!appIsActive(AppState.currentState)) backgroundTicks.current.count += 1

    /*
     * **Drive the crossfade ramp from the heartbeat** (#470).
     *
     * This effect re-runs on every `playbackStatusUpdate`, which `expo-audio`
     * emits from a Kotlin coroutine on `Dispatchers.Main` — a native timer that
     * keeps firing while the activity is paused, where the ramp's `setInterval`
     * does not. Measured before relying on it, over 135 s backgrounded with
     * audio playing: `ticks=272 over=134582ms expected=269 playing=true`.
     *
     * Calling it here rather than adding a listener of our own keeps the driver
     * and the measurement the *same signal*, so `queue.heartbeat` remains
     * evidence about the thing that actually moves the fade.
     */
    fadeStep.current?.()

    if (!song) {
      resetPlaybackStatus()
      return
    }
    usePlaybackStatus.getState().setStatus({
      position: status.currentTime,
      duration: status.duration,
      isBuffering: status.isBuffering || !status.isLoaded,
      error: status.error,
    })
  }, [song, status.currentTime, status.duration, status.isBuffering, status.isLoaded, status.error])

  // Nothing to draw: see the note at the top on why the mini player left.
  return null
}
