import { requireOptionalNativeModule } from 'expo'
import type { AudioPlayer } from 'expo-audio'

/**
 * The ten-band equaliser's native side (#202), or nothing.
 *
 * **`requireOptionalNativeModule`, not `requireNativeModule`.** This module is
 * Kotlin, so it only exists in a binary that was built after it was added — and
 * the app must still run in one that was not. Demanding it would turn "the EQ
 * is missing" into "the app does not start", which is exactly the failure the
 * `playbackRate` crash taught this project to avoid.
 *
 * Everything below therefore has a null path, and the UI asks `isSupported`
 * before offering anything.
 */
interface MioEqualizerNative {
  /** False on Android 8 and below — `DynamicsProcessing` is API 28 — and in any
   *  build that predates this module. */
  readonly isSupported: boolean
  readonly bandCount: number
  readonly bandFrequencies: number[]
  readonly maxGainDb: number
  setGains(player: AudioPlayer, gains: number[]): EqualizerReason | boolean
  /** Absent in every binary built before #380, which is why the wrapper below
   *  checks for the function rather than assuming the module implies it. */
  setBalance?(player: AudioPlayer, balance: number): EqualizerReason | boolean
  /**
   * Whether the **audio processor** is in this binary (#482) — which is a
   * different question from whether this module is.
   *
   * The processor is injected into `expo-audio` by a config plugin at prebuild,
   * so a build from before that plugin has the module without it. Absent
   * entirely in a binary built before mono existed.
   */
  readonly hasMono?: boolean
  /** No player argument: mono is a process-wide flag inside the audio sink,
   *  not an effect attached to one player's session. */
  setMono?(enabled: boolean): EqualizerReason | boolean
}

/**
 * Why the native side did or did not take the curve.
 *
 * Every one of these was `false` until #303's third attempt, which is precisely
 * why the bug survived two fixes: "the equaliser is refused" is not actionable,
 * and "the renderer has no session yet" and "reflection cannot reach the
 * session" want opposite responses.
 */
export type EqualizerReason =
  | 'ok'
  | 'os_too_old'
  | 'no_player'
  | 'no_session_method'
  /**
   * `invoke` threw. **Kept for binaries built before the class was carried**;
   * a current one answers the qualified form below.
   */
  | 'session_blocked'
  /**
   * `invoke` threw, and *what* threw (#303, fifth attempt) — e.g.
   * `session_blocked:IllegalAccessException`.
   *
   * The bare word came back from three device passes and was three different
   * questions each time: the access trap, media3 throwing from inside the call,
   * or the player disappearing mid-call. Naming the exception is the same move
   * that replaced the boolean, applied one level further down — and the lesson
   * this project has now paid for twice is that a failure gets a name before it
   * gets a fix.
   */
  | `session_blocked:${string}`
  | 'no_session_yet'
  | 'effect_unavailable'
  /** No native module at all — this side's own answer, not Kotlin's. */
  | 'no_module'
  /**
   * The module is here and the **audio processor** is not (#482): a binary
   * built before the config plugin, or one where prebuild did not run it.
   * Distinct from mono simply being off.
   */
  | 'no_processor'
  /**
   * A binary built before the codes existed said `false`, and `false` meant
   * five things at once. This side cannot recover which.
   */
  | 'refused'

/**
 * Whether asking again could plausibly succeed.
 *
 * A renderer that has not been given its audio session yet will have one a
 * moment later; a reflection failure or a missing effect will not, and retrying
 * those on every status tick is a native call twice a second whose answer is
 * thrown away — one of #342's candidate costs.
 *
 * **`refused` is transient, and that is the careful choice rather than the
 * obvious one.** It comes from an old binary whose `false` was usually "no
 * session yet", so treating the ambiguity as permanent would quietly undo the
 * retry #303 added, on exactly the installs that still need it. An unnecessary
 * retry costs a few native calls; a missing one costs the whole feature.
 */
export const isTransientEqualizerReason = (reason: EqualizerReason): boolean =>
  reason === 'no_session_yet' || reason === 'refused'

/**
 * Resolved per call rather than cached at import.
 *
 * Not a performance question — it is a lookup in a map, and these are called
 * when a setting changes or a track loads, not per frame. It is a correctness
 * one: a module-level `const` is evaluated the first time *anything* imports
 * this file, which made the "no native module" path — the state every existing
 * install is in until the next build — impossible to exercise in a test. A
 * path that cannot be tested is a path that will be wrong.
 */
const native = () => requireOptionalNativeModule<MioEqualizerNative>('MioEqualizer')

/** Whether an equaliser can be offered at all: the native module is present
 *  *and* the OS is new enough. Both, because either alone is a lie. */
export const isEqualizerSupported = (): boolean => native()?.isSupported ?? false

/** The band centre frequencies, from the native side so the labels cannot
 *  disagree with what is actually being filtered. */
export const equalizerBands = (): number[] => native()?.bandFrequencies ?? []

export const maxGainDb = (): number => native()?.maxGainDb ?? 12

/**
 * Apply gains to one deck, answering why it did or did not land.
 *
 * `'ok'` is the only success. The boolean branch is not dead code: an install
 * running a binary built before this change has a Kotlin `setGains` that still
 * answers `Boolean`, and that binary is exactly the one a person debugging the
 * equaliser is likely to be holding.
 */
export function applyEqualizer(player: AudioPlayer, gains: readonly number[]): EqualizerReason {
  const answer = native()?.setGains(player, [...gains])
  if (answer === undefined) return 'no_module'
  if (typeof answer === 'boolean') return answer ? 'ok' : 'refused'
  return answer
}

/**
 * Whether this binary can pan between the channels (#380).
 *
 * Asked about the **function** rather than about the module, because the module
 * has existed since #202 and `setBalance` has not. `isEqualizerSupported()`
 * would answer true on a binary that has no idea what balance is, and the
 * settings panel would then offer a control that silently does nothing —
 * which is precisely the class of lie iteration v0.5.0 was named after.
 */
export const isBalanceSupported = (): boolean =>
  (native()?.isSupported ?? false) && typeof native()?.setBalance === 'function'

/**
 * Pan one deck between the channels, −1 hard left to 1 hard right.
 *
 * Shares the equaliser's processor rather than attaching a second effect:
 * `DynamicsProcessing` carries per-channel input gain, so the thing already
 * bound to this player's audio session can do it. Reasons come back by the same
 * names `applyEqualizer` uses, so `isTransientEqualizerReason` applies here too
 * — `no_session_yet` is as real for balance as it is for the bands.
 */
export function applyBalance(player: AudioPlayer, balance: number): EqualizerReason {
  const module = native()
  if (!module || typeof module.setBalance !== 'function') return 'no_module'
  const answer = module.setBalance(player, balance)
  if (answer === undefined) return 'no_module'
  if (typeof answer === 'boolean') return answer ? 'ok' : 'refused'
  return answer
}

/**
 * Whether this binary can sum the channels (#482).
 *
 * **Three things have to be true and only one of them is the module.** The
 * native side has to exist, it has to know the word `setMono`, and the
 * *processor* has to have been injected into `expo-audio` at prebuild — which
 * is what `hasMono` answers, by looking the flag up rather than assuming.
 *
 * Deliberately **not** gated on `isSupported`: that reports API 28 for
 * `DynamicsProcessing`, and channel mixing has nothing to do with
 * `DynamicsProcessing`. Mono works on every version this app runs on, and
 * reusing the equaliser's gate would have hidden it on Android 7 and 8 for a
 * reason that does not apply to it.
 */
export const isMonoSupported = (): boolean => {
  const module = native()
  return typeof module?.setMono === 'function' && module.hasMono === true
}

/**
 * Sum the channels into both, or stop.
 *
 * Called when the *setting* changes and not per deck or per track: the flag
 * lives in the sink for the life of the process, so a new player is mixed
 * without anyone re-applying anything. That is the one way this differs from
 * `applyEqualizer` and `applyBalance`, and it is why there is no player here.
 */
export function applyMono(enabled: boolean): EqualizerReason {
  const module = native()
  if (!module || typeof module.setMono !== 'function') return 'no_module'
  const answer = module.setMono(enabled)
  if (answer === undefined) return 'no_module'
  if (typeof answer === 'boolean') return answer ? 'ok' : 'refused'
  return answer
}

/*
 * There is no `releaseEqualizer` here, and its absence is a decision.
 *
 * There was one, and `PlayerHost` called it from an unmount cleanup to hand the
 * `AudioEffect`s back. On a device that threw every single time:
 *
 *     Call to function 'MioEqualizer.release' has been rejected.
 *     → the 1st argument cannot be cast to SharedRef (received Integer)
 *     → Cannot use shared object that was already released
 *
 * `useAudioPlayer` releases each deck in its own cleanup, which is registered
 * before ours and therefore runs first — so the player was always gone by then,
 * and a released `SharedObject` no longer converts to a `SharedRef`; what
 * reached Kotlin was the bare handle, an `Integer`. It is the same trap #189
 * hit with `clearLockScreenControls`.
 *
 * The native side keeps its `release` function and its `OnDestroy`, which frees
 * every processor it holds. That is the same reclamation at the only moment it
 * can safely happen, so nothing calls it from here.
 */
