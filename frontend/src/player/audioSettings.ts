import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { EQ_BANDS, EQ_MAX_GAIN_DB, type ChannelMode } from './audioGraph'

/**
 * Audio *processing* preferences — how the sound is shaped, as opposed to the
 * player store's *playback* state (what is playing, and where in the queue).
 * Kept apart for the same reason the theme store is: this is a settings blob
 * the listener tunes once and forgets, not something that changes per track.
 *
 * The graph is the only consumer; see `applyAudioProcessing`.
 */

export type EqPresetName = 'flat' | 'bass' | 'vocal' | 'treble'

/** Curves are per EQ_BANDS: 31, 62, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz. */
export const EQ_PRESETS: Record<EqPresetName, readonly number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  // Lift the bottom two octaves and dip the low mids slightly, so "more bass"
  // doesn't just mean "muddier".
  bass: [7, 6, 4, 2, -1, -1, 0, 0, 0, 1],
  // Presence range (1–4 kHz) is where intelligibility lives; the shelves come
  // down to get everything else out of the way.
  vocal: [-3, -2, -1, 1, 3, 4, 4, 2, 0, -1],
  treble: [0, 0, 0, -1, -1, 0, 2, 4, 6, 7],
}

export const FLAT_GAINS: readonly number[] = EQ_PRESETS.flat

interface AudioSettingsState {
  eqGains: readonly number[]
  /** Which preset the current curve came from, or null once hand-adjusted. */
  preset: EqPresetName | null
  channelMode: ChannelMode
  balance: number
  /** Even out per-track loudness using the measurements taken at import. */
  normalizeLoudness: boolean
}

interface AudioSettingsActions {
  setBandGain: (index: number, gainDb: number) => void
  applyPreset: (preset: EqPresetName) => void
  resetEq: () => void
  setChannelMode: (mode: ChannelMode) => void
  setBalance: (balance: number) => void
  setNormalizeLoudness: (enabled: boolean) => void
}

const initialState: AudioSettingsState = {
  eqGains: FLAT_GAINS,
  preset: 'flat',
  channelMode: 'stereo',
  balance: 0,
  // On by default, unlike crossfade: this corrects an inconsistency rather
  // than adding an effect, and a library where every track plays at its own
  // level is the problem, not the baseline.
  normalizeLoudness: true,
}

const clampGain = (value: number) => Math.min(Math.max(value, -EQ_MAX_GAIN_DB), EQ_MAX_GAIN_DB)

export const useAudioSettingsStore = create<AudioSettingsState & AudioSettingsActions>()(
  persist(
    (set) => ({
      ...initialState,

      setBandGain: (index, gainDb) =>
        set((state) => {
          if (index < 0 || index >= EQ_BANDS.length) return state
          const eqGains = state.eqGains.map((existing, position) =>
            position === index ? clampGain(gainDb) : existing,
          )
          // Touching a slider means the curve is no longer the preset, even if
          // the numbers happen to coincide — the label would otherwise claim a
          // preset the user has since moved away from.
          return { eqGains, preset: null }
        }),

      applyPreset: (preset) => set({ eqGains: [...EQ_PRESETS[preset]], preset }),

      resetEq: () => set({ eqGains: [...EQ_PRESETS.flat], preset: 'flat' }),

      setChannelMode: (channelMode) => set({ channelMode }),

      setBalance: (balance) => set({ balance: Math.min(Math.max(balance, -1), 1) }),

      setNormalizeLoudness: (normalizeLoudness) => set({ normalizeLoudness }),
    }),
    {
      name: 'mio-audio',
      version: 1,
    },
  ),
)

/** True when the chain is doing nothing — used to show "off" rather than
 *  implying the listener has a custom sound they didn't ask for. */
export function selectIsNeutral(state: AudioSettingsState): boolean {
  return (
    state.eqGains.every((gain) => gain === 0) &&
    state.channelMode === 'stereo' &&
    state.balance === 0
  )
}
