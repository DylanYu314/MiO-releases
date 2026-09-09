import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'

/**
 * Playback settings that outlive a launch.
 *
 * Loudness normalization (P8), the ten-band EQ (#202), balance (#380) and
 * channel mode (#482). The last two were absent for a long time because they
 * are Web Audio graph nodes on the web (ADR-012) with no React Native
 * equivalent — balance turned out to ride the equaliser's own processor, and
 * mono needed an audio processor inside ExoPlayer's sink.
 *
 * The EQ arrived later than the web's and had to be *native* to arrive at all —
 * `modules/mio-equalizer` wraps `DynamicsProcessing`. The gains themselves are
 * ordinary state, and they are stored here rather than in the player store for
 * the same reason as the web: they are a preference the listener tunes once and
 * forgets, not something that changes per track.
 *
 * Ordinary configuration, so AsyncStorage rather than SecureStore; the
 * credential/config split is explained in `src/api/connection.ts`.
 */

const NORMALIZE_KEY = 'mio-normalize-loudness'
const EQ_KEY = 'mio-eq-gains'
const PRESET_KEY = 'mio-eq-preset'
const BALANCE_KEY = 'mio-balance'
const MONO_KEY = 'mio-mono'

export type EqPresetName = 'flat' | 'bass' | 'vocal' | 'treble' | 'podcast' | 'loudness'

/**
 * Curves per band: 31, 62, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz.
 *
 * The first four are **copied from the web client**, value for value
 * (`frontend/src/player/audioSettings.ts`). Not re-derived: a preset that meant
 * something slightly different on each client would be a bug nobody could see,
 * only hear, and only by switching between them.
 *
 * The last two are #242, which was folded into this issue — the extra presets
 * were asked for on the app, and the app had no equaliser to put them on until
 * now.
 */
export const EQ_PRESETS: Record<EqPresetName, readonly number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  // Lift the bottom two octaves and dip the low mids slightly, so "more bass"
  // doesn't just mean "muddier".
  bass: [7, 6, 4, 2, -1, -1, 0, 0, 0, 1],
  // Presence range (1–4 kHz) is where intelligibility lives; the shelves come
  // down to get everything else out of the way.
  vocal: [-3, -2, -1, 1, 3, 4, 4, 2, 0, -1],
  treble: [0, 0, 0, -1, -1, 0, 2, 4, 6, 7],
  // Speech, not singing: the bottom two octaves carry almost nothing but rumble
  // and handling noise, so they come out rather than being left flat.
  podcast: [-6, -5, -2, 0, 2, 4, 4, 3, 1, 0],
  // The ends lifted against the middle, which is what quiet listening needs:
  // human hearing loses the extremes first as level drops (Fletcher–Munson).
  loudness: [6, 5, 3, 0, -1, -1, 0, 2, 4, 5],
}

export const FLAT_GAINS: readonly number[] = EQ_PRESETS.flat

interface AudioSettingsState {
  /** Even out per-track loudness using the measurements taken at import. */
  normalizeLoudness: boolean
  setNormalizeLoudness: (enabled: boolean) => Promise<void>
  /** Per-band gain in dB, one entry per band (#202). */
  eqGains: readonly number[]
  /** Which preset the curve came from, or null once it has been hand-adjusted.
   *  Null is not "no EQ" — it is "yours", and the UI says so. */
  preset: EqPresetName | null
  setBandGain: (index: number, gainDb: number) => Promise<void>
  /** Move a band without writing to disk — for a finger that is still moving. */
  previewBandGain: (index: number, gainDb: number) => void
  /** Write whatever the bands currently are. The other half of a preview. */
  commitBandGains: () => Promise<void>
  applyPreset: (preset: EqPresetName) => Promise<void>
  resetEq: () => Promise<void>
  /**
   * Left/right balance, −1 hard left to 1 hard right, 0 centred (#380).
   *
   * Rides the equaliser's `DynamicsProcessing` rather than a second effect,
   * because per-channel input gain is already a property of it.
   */
  balance: number
  /** Move it without writing to disk — for a finger that is still moving, the
   *  same split the bands have. */
  previewBalance: (balance: number) => void
  setBalance: (balance: number) => Promise<void>
  /**
   * Play both channels as their sum (#482).
   *
   * **Not a preference about taste, which is why it is off by default and why
   * it exists at all**: it is what makes a stereo recording listenable through
   * one earbud, or with asymmetric hearing. Nothing is lost — a channel that
   * was only in the left is now in both.
   *
   * Unlike the EQ and balance, this is not applied per deck: it is one flag in
   * the audio sink that every player reads (`modules/mio-equalizer`'s
   * `setMono`).
   */
  mono: boolean
  setMono: (enabled: boolean) => Promise<void>
}

/** Anything nearer the centre than this is centred. A slider cannot be dropped
 *  on exactly 0, and a permanent third of a decibel of tilt is worse than a
 *  control that admits a dead zone. */
const BALANCE_DEADZONE = 0.02

/** Clamp, and snap a near-centre value to true centre. Exported because the
 *  panel needs the same answer the store will store. */
export const normalizeBalance = (balance: number): number => {
  if (!Number.isFinite(balance)) return 0
  const clamped = Math.min(Math.max(balance, -1), 1)
  return Math.abs(clamped) < BALANCE_DEADZONE ? 0 : clamped
}

export const useAudioSettings = create<AudioSettingsState>((set, get) => ({
  // On by default, and deliberately so: this corrects an inconsistency rather
  // than adding an effect. A library where every track plays at its own level is
  // the problem, not the baseline. The web client defaults the same way.
  normalizeLoudness: true,

  setNormalizeLoudness: async (enabled) => {
    // Set first, then persist. The toggle should move under the thumb that
    // pressed it rather than after a round trip to disk.
    set({ normalizeLoudness: enabled })
    await AsyncStorage.setItem(NORMALIZE_KEY, enabled ? 'true' : 'false')
  },

  eqGains: FLAT_GAINS,
  preset: 'flat',

  setBandGain: async (index, gainDb) => {
    get().previewBandGain(index, gainDb)
    await persistEq(get().eqGains, null)
  },

  /**
   * Move a band and **do not touch the disk** (#317).
   *
   * A drag calls this sixty times a second, and `setBandGain` ends in an
   * `await persistEq(...)` — an AsyncStorage write. Persisting per frame is a
   * storage round-trip per pixel of finger travel, which is what made the new
   * band drag "too laggy, huge latency" on a device: not the gesture, not the
   * equaliser, the *saving*.
   *
   * The store still updates, so the bar moves and `PlayerHost` re-applies the
   * curve to the audio as the finger travels — which is the point of dragging
   * it. Only the record of it waits for the finger to lift.
   */
  previewBandGain: (index, gainDb) => {
    const next = [...get().eqGains]
    if (index < 0 || index >= next.length) return
    next[index] = Math.min(Math.max(Math.round(gainDb), -MAX_GAIN_DB), MAX_GAIN_DB)
    // Moving one band means the curve is no longer the preset it came from.
    // Saying so is the point: a UI still highlighting "Bass" after the user has
    // pulled 4 kHz down is describing a curve that does not exist.
    set({ eqGains: next, preset: null })
  },

  commitBandGains: async () => {
    await persistEq(get().eqGains, get().preset)
  },

  applyPreset: async (preset) => {
    const gains = [...EQ_PRESETS[preset]]
    set({ eqGains: gains, preset })
    await persistEq(gains, preset)
  },

  resetEq: async () => {
    const gains = [...FLAT_GAINS]
    set({ eqGains: gains, preset: 'flat' })
    await persistEq(gains, 'flat')
  },

  // Centred, which is the only default that is not an opinion about the music.
  balance: 0,

  previewBalance: (balance) => set({ balance: normalizeBalance(balance) }),

  setBalance: async (balance) => {
    const next = normalizeBalance(balance)
    // Set first, then persist — the same order the loudness toggle uses, so the
    // control moves under the finger rather than after a write.
    set({ balance: next })
    await AsyncStorage.setItem(BALANCE_KEY, String(next))
  },

  // Off, because stereo is what the recording is. This is an accessibility
  // affordance, not an improvement to be applied by default.
  mono: false,

  setMono: async (enabled) => {
    set({ mono: enabled })
    await AsyncStorage.setItem(MONO_KEY, enabled ? 'true' : 'false')
  },
}))

/** The store's own clamp, mirroring the native module's. Kept here too so a
 *  gain that never reaches the native side is still in range. */
export const MAX_GAIN_DB = 12

async function persistEq(gains: readonly number[], preset: EqPresetName | null): Promise<void> {
  await AsyncStorage.multiSet([
    [EQ_KEY, JSON.stringify(gains)],
    // An empty string for "hand-adjusted": AsyncStorage cannot store null, and
    // removing the key would be indistinguishable from never having set one.
    [PRESET_KEY, preset ?? ''],
  ])
}

/**
 * Apply the stored preference, if there is one.
 *
 * Called from the root layout alongside the other stored-state loaders. A
 * missing value leaves the default alone, so "never touched the setting" and
 * "turned it on" are not stored differently — only an explicit *off* has to
 * survive a restart.
 *
 * Nothing waits for this. The default is what the great majority of listeners
 * want, so the worst case is that the first track of a cold start plays
 * uncorrected for the moment before storage answers — which is what happens
 * today anyway, and is not worth a loading gate over.
 */
export async function loadAudioSettings(): Promise<void> {
  const stored = await AsyncStorage.getItem(NORMALIZE_KEY)
  if (stored != null) {
    useAudioSettings.setState({ normalizeLoudness: stored === 'true' })
  }

  const storedBalance = await AsyncStorage.getItem(BALANCE_KEY)
  if (storedBalance != null) {
    // Through the same normaliser the setter used, so a value written by a
    // build with a different dead zone still lands somewhere valid, and a
    // corrupt one reads as centred rather than as NaN reaching the native side.
    useAudioSettings.setState({ balance: normalizeBalance(Number(storedBalance)) })
  }

  const storedMono = await AsyncStorage.getItem(MONO_KEY)
  if (storedMono != null) {
    useAudioSettings.setState({ mono: storedMono === 'true' })
  }

  const [storedGains, storedPreset] = await Promise.all([
    AsyncStorage.getItem(EQ_KEY),
    AsyncStorage.getItem(PRESET_KEY),
  ])
  if (storedGains != null) {
    try {
      const parsed: unknown = JSON.parse(storedGains)
      // Length-checked, not just type-checked: a stored curve from a build with
      // a different band count would otherwise leave bands unset, and the ones
      // it did set would be at the wrong frequencies.
      if (
        Array.isArray(parsed) &&
        parsed.length === FLAT_GAINS.length &&
        parsed.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        useAudioSettings.setState({
          eqGains: parsed as number[],
          preset: (storedPreset || null) as EqPresetName | null,
        })
      }
    } catch {
      // Unreadable stored settings are not worth failing a launch over; the
      // defaults are what most listeners want anyway.
    }
  }
}
