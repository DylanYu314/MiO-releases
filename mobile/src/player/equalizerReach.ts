import { create } from 'zustand'

import type { EqualizerReason } from '../../modules/mio-equalizer'

/**
 * Whether the equaliser is actually reaching the audio.
 *
 * ## Why this needs saying out loud
 *
 * The equaliser has now failed twice on a device while looking completely
 * healthy: the panel draws ten bands, the numbers move, the preset chips
 * highlight, and no sound changes. `applyEqualizer` answers **false** when the
 * native side will not take the curve — no module, an OS below API 28, or a
 * deck with no audio session yet — and nothing has ever shown that answer to
 * anybody.
 *
 * That is the difference between two completely different faults, and knowing
 * which one it is costs a twenty-minute native build to guess wrong:
 *
 * - **false** — the curve never arrived. The fault is in attaching to the
 *   session, which is JavaScript and Kotlin plumbing.
 * - **true**, and still no audible change — the curve arrived and did nothing.
 *   The fault is in the processor's configuration.
 *
 * `isEqualizerSupported()` cannot answer this: it reports whether a module
 * exists, not whether it took.
 *
 * Only `PlayerHost` writes here, exactly like `usePlaybackStatus`.
 */
interface EqualizerReachStore {
  /**
   * True once the native side has accepted the curve for the deck that is
   * playing, false when it has refused it, and **null when there is nothing to
   * attach to** — no track, so no audio session, so no answer to give. Null is
   * not a failure and must not be reported as one.
   */
  reaching: boolean | null
  /**
   * The native side's own word for the last refusal, or null when there is
   * nothing to explain.
   *
   * Derived from the same call as `reaching` rather than stored separately, so
   * the two cannot disagree — a panel saying "refused" beside a stale reason
   * from a previous track would be worse than saying nothing.
   */
  reason: EqualizerReason | null
  setReaching: (reason: EqualizerReason | null) => void
}

export const useEqualizerReach = create<EqualizerReachStore>((set) => ({
  reaching: null,
  reason: null,
  setReaching: (reason) => {
    const reaching = reason === null ? null : reason === 'ok'
    // Bail out when nothing changed: this is written from a status tick, and
    // the panel subscribes to it.
    const state = useEqualizerReach.getState()
    if (state.reaching === reaching && state.reason === reason) return
    set({ reaching, reason })
  },
}))
