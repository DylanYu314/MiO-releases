import { create } from 'zustand'

/**
 * What the native player is *currently doing*, published for the UI to read.
 *
 * ## Why this store exists
 *
 * #226 split `PlayerHost` in two, because its halves have opposite mounting
 * requirements: the audio must never unmount (so it lives at the root, outside
 * the navigator) while the mini player must be positioned by the navigator to
 * sit above the tab bar (so it lives inside). Once they are in two places, the
 * position and duration the bar draws can no longer be passed down as props.
 *
 * `usePlayer` is the wrong home for this. That store is the *intent* — the
 * queue, shuffle, repeat, and whether we want sound — and it is deliberately
 * pure so it stays testable. This is the opposite: an observation of the native
 * player, overwritten about twice a second. Mixing the two would make every
 * queue subscriber re-render on a progress tick.
 *
 * So: `usePlayer` is what the user asked for, this is what is actually
 * happening. Only `PlayerHost` writes here.
 */
interface PlaybackStatus {
  /** Seconds into the current track. */
  position: number
  /** Track length in seconds, or 0 until the stream's header has been read. */
  duration: number
  /** Stalled, or not yet loaded — either way there is no sound right now. */
  isBuffering: boolean
  /** A playback error from the native player, or null. */
  error: string | null
}

interface PlaybackStatusStore extends PlaybackStatus {
  setStatus: (status: PlaybackStatus) => void
}

const IDLE: PlaybackStatus = { position: 0, duration: 0, isBuffering: false, error: null }

export const usePlaybackStatus = create<PlaybackStatusStore>((set) => ({
  ...IDLE,

  /**
   * Written on every status tick, so it must not wake subscribers that would
   * see no change.
   *
   * **Most of that protection is not this check**, and the previous version of
   * this comment implied it was. Zustand bails out **per selector** with
   * `Object.is`, which is what keeps a paused player free and what stops the
   * queue screen re-rendering while `position` moves — measured in
   * `playbackTickRenders.test.tsx`, where deleting the check below changes the
   * mini player's commit count by nothing at all.
   *
   * What the check *does* protect is a subscriber that selects the **whole
   * object**: without it that gets a new identity on every tick and re-renders
   * twice a second forever. Nothing does that today, which is precisely why the
   * guard needs a test of its own rather than an assumption that the bar covers
   * it.
   */
  setStatus: (status) =>
    set((previous) =>
      previous.position === status.position &&
      previous.duration === status.duration &&
      previous.isBuffering === status.isBuffering &&
      previous.error === status.error
        ? previous
        : status,
    ),
}))

/** Forget the last track's progress. Called when playback stops entirely. */
export function resetPlaybackStatus(): void {
  usePlaybackStatus.setState(IDLE)
}
