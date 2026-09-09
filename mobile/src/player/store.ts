import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import type { PlayableSong } from '../api/types'
import { useResume } from './resume'

/**
 * What is playing, what plays next, and whether it should be playing.
 *
 * Deliberately free of `expo-audio`: the same rule the web client follows
 * (ADR-003) — the store is pure state, and a single host component binds it to
 * the actual player. That is what makes playback logic testable without a
 * native module.
 *
 * `isPlaying` is *intent*, not truth. The OS can pause us for a phone call, so
 * the host writes the real state back with `setPlaying`.
 *
 * ## Two tiers, mirroring ADR-011
 *
 * The **context queue** is whatever list you started playing — the library, a
 * playlist. Playing something else replaces it wholesale. The **user queue** is
 * what you added by hand; it always plays first and *nothing* replaces it.
 *
 * That second promise is the whole point. Queue three songs, then tap a
 * playlist, and the three survive — losing them was the bug ADR-011 was written
 * to fix, and the fix is worth as much on a phone as on a desktop.
 *
 * `contextOrder` is a permutation of indices into `contextQueue`, not a
 * reordered copy, so shuffling never loses the list's own order and unshuffling
 * needs no second array kept in sync.
 */

export type RepeatMode = 'off' | 'all' | 'one'

/** Where the playing list came from, so the queue panel can say "Next from: …". */
export type ContextKind = 'library' | 'playlist'

export interface PlaybackContext {
  kind: ContextKind
  /** The playlist's id, when kind is 'playlist'. A local minted string since
   *  #219; the number form is gone with the server's playlists. */
  id?: string | number
  name?: string
}

/** Which tier the current track came from. `next()` needs this: the context
 *  pointer must not move while a hand-queued song plays. */
export interface CurrentTrack {
  source: 'user' | 'context'
  song: PlayableSong
}

/**
 * A track that has already played, and where it sat while it did.
 *
 * `contextIndex` is stored with the song rather than derived on the way back:
 * the pointer is a position in `contextOrder`, and a shuffle, a reorder or a
 * deletion between then and now means "find this song again" would answer a
 * different question than "put the pointer back where it was".
 */
interface HistoryEntry {
  source: 'user' | 'context'
  song: PlayableSong
  contextIndex: number
}

/**
 * How far back `previous` can walk.
 *
 * A bound rather than everything: this is persisted, and an unbounded list of
 * whole song records in AsyncStorage grows for as long as the app is used. Fifty
 * is far more than anyone presses the button for and still a few kilobytes.
 */
const HISTORY_LIMIT = 50

interface PlayerState {
  context: PlaybackContext | null
  contextQueue: PlayableSong[]
  contextOrder: number[]
  /** Position within `contextOrder`; -1 before the context starts. */
  contextIndex: number
  userQueue: PlayableSong[]
  current: CurrentTrack | null
  /**
   * What actually played, oldest first — what `previous` walks back through.
   *
   * Before this existed, `previous` was derived from `contextIndex` alone, and
   * so it could only go back through the *context*. A track that came from the
   * user queue had nothing behind it, because a consumed queue entry is gone
   * from `userQueue` the moment it starts — so pressing previous restarted the
   * song instead. I built a listening session by swiping songs into the
   * queue and reported the button as broken, which it effectively was: "the
   * tracks before it somehow not exist".
   *
   * A record of what played answers that regardless of which tier a track came
   * from, and it is the only thing that can: the two tiers are interleaved at
   * playback time and nothing else keeps the interleaving.
   */
  history: HistoryEntry[]
  isPlaying: boolean
  shuffle: boolean
  repeat: RepeatMode
  /**
   * Playback settings the user controls (#234).
   *
   * All six landed together because T4's panels need most of them and T6 needs
   * the rest, and because they share one property: **the store only records the
   * choice.** Applying it is `PlayerHost`'s job, which is what keeps this file
   * free of `expo-audio` and therefore testable without a native module.
   */
  /** 0..1. Multiplied with the loudness correction, never replacing it (P8). */
  volume: number
  muted: boolean
  /** Playback speed multiplier; 1 is normal. */
  playbackRate: number
  /** Epoch ms at which playback should stop, or null for no timer. */
  sleepAt: number | null
  /** Stop once the current track finishes, rather than at a wall-clock time. */
  sleepAfterTrack: boolean
  /**
   * Seconds of overlap between tracks; 0 is off.
   *
   * **Recorded but not yet applied on Android**, and knowingly so. Crossfade is
   * a Web Audio graph on the web (ADR-012) and needs a native module here, which
   * is #201. The setting lives in the store now so the T4 panel that offers it
   * has somewhere to write, and so the value survives the app that will
   * eventually honour it — not because anything reads it today.
   */
  crossfadeSeconds: number
  /**
   * Bumped to ask the host to restart the current track from zero.
   *
   * Needed because "play this again" is not a state change — the current track
   * is already current, so no amount of comparing state would tell the host
   * that anything happened. Repeat-one and pressing previous both rely on it.
   */
  restartNonce: number
  /**
   * A scrub the host has not applied yet (#231).
   *
   * Carries a nonce for the same reason `restartNonce` exists: dragging back to
   * a second you are already at is a real instruction, and comparing state alone
   * could not tell it from no instruction at all.
   *
   * The host clears it once applied, so this is never a record of where playback
   * *is* — `usePlaybackStatus` is that. It is a request, and a stale one would
   * yank the track back on the next unrelated render.
   */
  seekRequest: { seconds: number; nonce: number } | null

  playFromContext: (
    songs: PlayableSong[],
    startIndex?: number,
    context?: PlaybackContext | null,
  ) => void
  addToQueue: (song: PlayableSong) => void
  playNext: (song: PlayableSong) => void
  removeFromUserQueue: (index: number) => void
  clearUserQueue: () => void
  togglePlay: () => void
  setPlaying: (isPlaying: boolean) => void
  /** Drop a song from both tiers — it has been deleted from the library. */
  removeSongById: (songId: number) => void
  next: () => void
  previous: () => void
  /** Called by the host when a track plays to its end. Distinct from `next()`
   *  because repeat-one and "stop at the end" only apply here. */
  trackEnded: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  stop: () => void

  /** Move a hand-queued song. Out-of-range indices are a no-op, not a throw. */
  reorderUserQueue: (from: number, to: number) => void
  /**
   * Reorder the **upcoming** part of the context list (#315).
   *
   * Indices count from the next context track, exactly as `skipToContext`'s
   * `offset` does and therefore exactly as the queue panel draws — so a screen
   * can hand back the positions it rendered without translating anything.
   *
   * It moves entries of `contextOrder`, not of `contextQueue`: the order is a
   * permutation of indices into the list, so reordering it leaves the list's
   * own order intact and unshuffling still works. Everything already played,
   * and the track playing now, is untouched — dragging what is coming cannot
   * rewrite what has been.
   */
  reorderContextQueue: (from: number, to: number) => void
  /**
   * Drop one upcoming track from the context list (#572).
   *
   * `offset` counts from the next context track, the same way `skipToContext`
   * and `upNext` do — so it is an index into what the queue panel actually
   * draws, not into `contextQueue`.
   *
   * ## ⚠️ What this removes, and what it does not
   *
   * **Only what plays next.** 2026-08-17: *"we remove track from the
   * queue, not remove from the playlist or library."* So this edits
   * `contextOrder` and never `contextQueue`, and never touches SQLite: the song
   * stays in the playlist it came from and in the library, and reopening that
   * playlist plays it again.
   *
   * ## Why editing the order is enough, and safe
   *
   * `contextOrder` is a permutation of indices into `contextQueue`; dropping an
   * entry is exactly "this position no longer plays". Three things depend on
   * that and all three keep working:
   *
   * - `contextIndex` still points at the current track, because only the slice
   *   **after** it is touched;
   * - `history` entries carry a context pointer into the *head*, which is
   *   untouched — and they are validated against the song on the way back
   *   anyway (the #421 fix);
   * - repeat-all restarts from `contextOrder[0]` via `contextSongAt`, so a
   *   removed track does **not** reappear on the wrap. That is the behaviour to
   *   want: it was removed, not skipped once.
   *
   * A duplicate song in a playlist has two entries in `contextOrder`, and this
   * removes the one at `offset` rather than both.
   */
  removeFromContextQueue: (offset: number) => void
  /**
   * Jump to a track in the context list **without touching the user queue**.
   *
   * `offset` counts from the next context track, matching what `upNext` returns
   * and therefore what the queue panel draws.
   *
   * The promise this keeps is ADR-011's, and it is the whole reason this is a
   * separate action: a naive "play this song" would call `playFromContext`,
   * which replaces the context *and* would leave hand-queued songs stranded
   * behind a pointer that has moved past them. Skipping ahead in the list you
   * are already playing is not starting a new list.
   */
  skipToContext: (offset: number) => void
  /**
   * Add songs to the end of the context list, leaving playback where it is
   * (#237).
   *
   * The counterpart to `playFromContext`, which *replaces* the list. Both are
   * offered by the playlist's 3-dot because they are genuinely different
   * intentions — "play this now" against "and then play this" — and appending is
   * the one that cannot be expressed with what already existed.
   *
   * With nothing playing there is no list to append to, so it starts one,
   * matching `addToQueue`'s reasoning: a button that silently does nothing
   * because the app happens to be idle is a bug report waiting to happen.
   */
  appendToContext: (songs: PlayableSong[], context?: PlaybackContext | null) => void
  /** Drop several hand-queued songs at once, by index into the user queue. */
  removeManyFromUserQueue: (indices: readonly number[]) => void
  /** Move the given hand-queued songs to the front, keeping their order. */
  promoteInUserQueue: (indices: readonly number[]) => void
  /** Clamped to 0..1, and unmutes: dragging a slider up means "let me hear it". */
  setVolume: (volume: number) => void
  toggleMute: () => void
  /** Clamped to 0.25..4 — beyond that is unintelligible, not a feature. */
  setPlaybackRate: (rate: number) => void
  setCrossfadeSeconds: (seconds: number) => void
  /** Minutes, `'endOfTrack'`, or null to cancel. */
  setSleepTimer: (option: number | 'endOfTrack' | null) => void
  /** Ask the host to jump to a position, in seconds (#231). */
  seekTo: (seconds: number) => void
  /** Called by the host once it has done so. */
  clearSeekRequest: () => void
}

const initialState = {
  context: null as PlaybackContext | null,
  contextQueue: [] as PlayableSong[],
  contextOrder: [] as number[],
  contextIndex: -1,
  userQueue: [] as PlayableSong[],
  current: null as CurrentTrack | null,
  history: [] as HistoryEntry[],
  isPlaying: false,
  restartNonce: 0,
  // In here, so `stop()` clears them: a sleep timer with nothing playing is a
  // timer that will fire on whatever the user starts next, which is not what
  // anyone set it for. The *settings* below are deliberately not in here.
  sleepAt: null as number | null,
  sleepAfterTrack: false,
  seekRequest: null as { seconds: number; nonce: number } | null,
}

/**
 * Settings, as opposed to playback state.
 *
 * Separate from `initialState` because `stop()` spreads that to wipe the queue,
 * and a volume or speed the user chose must survive it — clearing the queue is
 * not a reason to forget they listen at 1.5x.
 */
const initialSettings = {
  volume: 1,
  muted: false,
  playbackRate: 1,
  crossfadeSeconds: 0,
}

/**
 * The speed range, and why it is **narrower than the web's**.
 *
 * The web clamps to 0.25..4. Android cannot do 4: `AudioPlayer.setPlaybackRate`
 * does `rate.coerceIn(0.1f, 2.0f)` in its own Kotlin, so anything above 2 is
 * silently discarded by the platform.
 *
 * Clamping here rather than storing a value that gets thrown away, for the same
 * reason `ATTENUATE_ONLY` exists for volume (P8): a control that shows 4x while
 * the audio plays at 2x is worse than one that only offers what works. The floor
 * stays at the web's 0.25 — comfortably inside Android's 0.1 — because below
 * that speech is unintelligible.
 */
const RATE_MIN = 0.25
const RATE_MAX = 2

/** Matches the web's `CROSSFADE_MAX_SECONDS`; longer overlaps sound like a fault. */
export const CROSSFADE_MAX_SECONDS = 12

/**
 * Move one item, on a copy. `null` when either index is out of range.
 *
 * Returning null rather than throwing or silently clamping: the caller is a
 * drag, and "the gesture ended somewhere invalid" should leave the list exactly
 * as it was. Clamping would move the song *somewhere*, which is worse — the user
 * sees an edit they did not ask for.
 */
function moved<T>(items: T[], from: number, to: number): T[] | null {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length) return null
  if (from === to) return null
  const result = [...items]
  const [item] = result.splice(from, 1)
  result.splice(to, 0, item)
  return result
}

/** Fisher-Yates, on a copy. */
function shuffled<T>(items: T[]): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/** The song at a position in the playback order, if there is one. */
function contextSongAt(state: PlayerState, position: number): PlayableSong | null {
  const songIndex = state.contextOrder[position]
  if (songIndex === undefined) return null
  return state.contextQueue[songIndex] ?? null
}

/**
 * Move to the next track: the user queue first, then the context. Returns null
 * when both are exhausted, leaving the caller to decide whether that means
 * wrap or stop.
 */
function advance(state: PlayerState): Partial<PlayerState> | null {
  if (state.userQueue.length > 0) {
    const [song, ...rest] = state.userQueue
    // The context pointer stays put, so the context resumes where it left off
    // once the user queue drains.
    return { userQueue: rest, current: { source: 'user', song } }
  }
  const nextPosition = state.contextIndex + 1
  const song = contextSongAt(state, nextPosition)
  if (!song) return null
  return { contextIndex: nextPosition, current: { source: 'context', song } }
}

/** Restart the context from its first track — the repeat-all wrap. */
function restartContext(state: PlayerState): Partial<PlayerState> | null {
  const song = contextSongAt(state, 0)
  if (!song) return null
  return { contextIndex: 0, current: { source: 'context', song } }
}

/**
 * Selecting the song that is *already loaded* is invisible to the host, which
 * skips reloading a track whose id has not changed — so nothing would restart
 * and the music would simply stop. Bump the restart nonce, the same signal
 * repeat-one already uses.
 *
 * Three ordinary cases land here: repeat-all on a one-song context, hand-queuing
 * the song that is currently playing, and a playlist holding the same song
 * twice in a row.
 */
function keepAudible(state: PlayerState, patch: Partial<PlayerState>): Partial<PlayerState> {
  if (!patch.current) return patch
  if (patch.current.song.id !== state.current?.song.id) return patch
  return { ...patch, restartNonce: state.restartNonce + 1 }
}

/**
 * Push the outgoing track onto the history, so `previous` can get back to it.
 *
 * Wrapped around every patch that moves playing *forward* — `next`, the natural
 * end of a track, and skipping into the context — and deliberately not around
 * `previous` itself, which consumes the history rather than adding to it.
 *
 * A patch that lands on the same song records nothing: repeat-one, and the
 * three cases `keepAudible` exists for, are the track playing again rather than
 * a track being left behind. Pressing previous after one of those should reach
 * whatever came before it, not the same song twice.
 */
function remembering(state: PlayerState, patch: Partial<PlayerState>): Partial<PlayerState> {
  if (!patch.current || !state.current) return patch
  if (patch.current.song.id === state.current.song.id) return patch
  return {
    ...patch,
    history: [
      ...state.history,
      {
        source: state.current.source,
        song: state.current.song,
        contextIndex: state.contextIndex,
      },
    ].slice(-HISTORY_LIMIT),
  }
}

/**
 * What survives closing the app (#183).
 *
 * `isPlaying` and `restartNonce` are deliberately absent. Reopening should show
 * the track you were on, at the second you left it, **paused** — starting music
 * by itself because the app was reopened is the behaviour I asked us not to
 * have. `restartNonce` is a signal to the host, not state; persisting it would
 * replay a "start over" the moment the store rehydrates.
 */
type PersistedPlayer = Pick<
  PlayerState,
  | 'context'
  | 'contextQueue'
  | 'contextOrder'
  | 'contextIndex'
  | 'userQueue'
  | 'current'
  // Persisted so previous still works after the app is reopened, which is the
  // moment it is least able to reconstruct anything: `contextIndex` alone could
  // only ever walk back through the context, and this is the record of what
  // actually played. Bounded by `HISTORY_LIMIT` so it cannot grow without end.
  | 'history'
  | 'shuffle'
  | 'repeat'
  | 'volume'
  | 'muted'
  | 'playbackRate'
  | 'crossfadeSeconds'
>

export const usePlayer = create<PlayerState>()(
  persist(
    (set, get) => ({
      ...initialState,
      ...initialSettings,
      shuffle: false,
      repeat: 'off' as RepeatMode,

      playFromContext: (songs, startIndex = 0, context = null) => {
        if (songs.length === 0) return
        const start = Math.min(Math.max(startIndex, 0), songs.length - 1)
        const identity = songs.map((_, index) => index)

        // With shuffle on, the song actually tapped still plays first; only what
        // follows is randomised. Tapping a song and hearing a different one is not
        // a shuffle feature, it is a bug.
        const contextOrder = get().shuffle
          ? [start, ...shuffled(identity.filter((index) => index !== start))]
          : identity

        // Wrapped in `remembering` too: starting a different list is still one
        // track following another, and "what played before this" is the question
        // previous answers. Without it, picking a song from the library would
        // silently empty the history the user had built up by listening.
        set(
          remembering(
            get(),
            keepAudible(get(), {
              context,
              contextQueue: songs,
              contextOrder,
              contextIndex: get().shuffle ? 0 : start,
              current: { source: 'context', song: songs[start] },
              isPlaying: true,
              // userQueue is deliberately untouched — it outlives context changes.
            }),
          ),
        )
      },

      appendToContext: (songs, context = null) => {
        if (songs.length === 0) return
        const state = get()
        // Nothing playing, or nothing to append to: this is a fresh start, and
        // `playFromContext` already knows how to build one (including the
        // shuffle-aware order).
        if (state.contextQueue.length === 0 || state.current === null) {
          get().playFromContext(songs, 0, context ?? state.context)
          return
        }

        const appended = songs.map((_, offset) => state.contextQueue.length + offset)
        set({
          contextQueue: [...state.contextQueue, ...songs],
          // Shuffled among themselves, but always *after* what is already
          // queued: "append" means these play last, and folding them into the
          // unplayed remainder would reorder music the user can already see.
          contextOrder: [...state.contextOrder, ...(state.shuffle ? shuffled(appended) : appended)],
        })
      },

      addToQueue: (song) =>
        set((state) =>
          // With nothing playing, a queued song becomes the current track, so it is
          // audible rather than sitting in an invisible queue.
          state.current
            ? { userQueue: [...state.userQueue, song] }
            : { current: { source: 'user', song }, isPlaying: true },
        ),

      playNext: (song) =>
        set((state) =>
          state.current
            ? { userQueue: [song, ...state.userQueue] }
            : { current: { source: 'user', song }, isPlaying: true },
        ),

      removeFromUserQueue: (index) =>
        set((state) => ({ userQueue: state.userQueue.filter((_, i) => i !== index) })),

      clearUserQueue: () => set({ userQueue: [] }),

      togglePlay: () => set((state) => (state.current ? { isPlaying: !state.isPlaying } : state)),

      setPlaying: (isPlaying) => set({ isPlaying }),

      /**
       * Take a deleted song out of the queue (#200).
       *
       * Mirrors the web store, which had this from the start. It matters more
       * here since #183: the queue is persisted now, so a deleted song left in
       * it would come back on the next launch and 404 when it was reached.
       *
       * `contextQueue` is deliberately left alone — `contextOrder` holds the
       * indices that drive playback, so filtering the order makes the song
       * unreachable, and rewriting the queue would mean renumbering every index.
       */
      removeSongById: (songId) =>
        set((state) => {
          const isCurrent = state.current?.song.id === songId
          const present =
            isCurrent ||
            state.userQueue.some((song) => song.id === songId) ||
            state.contextQueue.some((song) => song.id === songId)
          if (!present) return state

          const userQueue = state.userQueue.filter((song) => song.id !== songId)
          // Entries at or before the pointer that disappear shift it left, so
          // whatever is playing stays under it.
          const removedBefore = state.contextOrder
            .slice(0, state.contextIndex + 1)
            .filter((index) => state.contextQueue[index]?.id === songId).length
          const contextOrder = state.contextOrder.filter(
            (index) => state.contextQueue[index]?.id !== songId,
          )
          /*
           * The history goes too — the song is off the device, and a `previous`
           * that lands on it would be the deleted-track-in-the-library bug in a
           * different place. Each surviving entry's pointer is shifted by the
           * same rule as the live one: entries removed at or before it move it
           * left, which keeps a later `previous` landing on the song it recorded
           * rather than its neighbour.
           */
          const history = state.history
            .filter((entry) => entry.song.id !== songId)
            .map((entry) => ({
              ...entry,
              contextIndex:
                entry.contextIndex -
                state.contextOrder
                  .slice(0, entry.contextIndex + 1)
                  .filter((index) => state.contextQueue[index]?.id === songId).length,
            }))

          const base = {
            userQueue,
            history,
            contextOrder,
            contextIndex: state.contextIndex - removedBefore,
          }
          if (!isCurrent) return base

          // The track playing was the one deleted — move on to whatever follows.
          const moved = advance({ ...state, ...base })
          if (moved) return { ...base, ...moved }
          return { ...base, current: null, isPlaying: false }
        }),

      next: () =>
        set((state) => {
          if (!state.current) return state
          // An explicit next at the end wraps only when repeating the whole queue.
          const moved = advance(state) ?? (state.repeat === 'all' ? restartContext(state) : null)
          return moved ? remembering(state, keepAudible(state, moved)) : state
        }),

      /**
       * Back to whatever actually played last.
       *
       * This used to read `contextIndex - 1`, which made it a function of the
       * *context* rather than of playback: a track that came from the user queue
       * had no predecessor to find, so the button restarted the song. I hit
       * exactly that and read it as previous being "programmed to replay a
       * track" — a fair reading, because from the outside it is.
       *
       * The history is consulted first and the context arithmetic is kept as the
       * fallback, so a session restored from disk mid-list still goes back one
       * track rather than doing nothing.
       */
      previous: () =>
        set((state) => {
          if (!state.current) return state

          const last = state.history[state.history.length - 1]
          if (last) {
            const history = state.history.slice(0, -1)
            /*
             * Is the recorded pointer still describing this song?
             *
             * A history entry outlives the context it was made in — the user can
             * start a different playlist, shuffle, or reorder — so the stored
             * index is a hint, not a fact. Checking it against the song is what
             * makes the entry self-invalidating, the same trick `resume` uses
             * with its song id.
             *
             * When it no longer holds, the track is played as a queue entry and
             * the context pointer is left alone: the song is genuinely not part
             * of the list playing now, and `next` should carry on down that list
             * rather than jump to wherever the old index happens to land.
             */
            const stillInContext =
              last.source === 'context' &&
              contextSongAt(state, last.contextIndex)?.id === last.song.id

            return keepAudible(state, {
              history,
              contextIndex: stillInContext ? last.contextIndex : state.contextIndex,
              current: {
                source: stillInContext ? 'context' : 'user',
                song: last.song,
              },
            })
          }

          // Nothing recorded — a session restored from disk, or the first track
          // of a run. Fall back to the position in the list.
          if (state.current.source === 'user') return { restartNonce: state.restartNonce + 1 }

          const song = contextSongAt(state, state.contextIndex - 1)
          if (song) {
            return keepAudible(state, {
              contextIndex: state.contextIndex - 1,
              current: { source: 'context', song },
            })
          }
          if (state.repeat === 'all') {
            const last = state.contextOrder.length - 1
            const wrapped = contextSongAt(state, last)
            if (wrapped) {
              return keepAudible(state, {
                contextIndex: last,
                current: { source: 'context', song: wrapped },
              })
            }
          }
          return { restartNonce: state.restartNonce + 1 }
        }),

      trackEnded: () =>
        set((state) => {
          if (!state.current) return state
          /**
           * "Stop after this track" is decided here, before repeat (#234).
           *
           * Checked first on purpose: repeat-one would otherwise restart the
           * song forever and the timer would never get a turn, which is the one
           * combination a user could plausibly have set and be baffled by.
           *
           * The flag clears itself. A sleep timer is a one-shot instruction, and
           * leaving it armed would silently stop the *next* thing they played.
           */
          if (state.sleepAfterTrack) return { isPlaying: false, sleepAfterTrack: false }
          if (state.repeat === 'one') return { restartNonce: state.restartNonce + 1 }

          const moved = advance(state) ?? (state.repeat === 'all' ? restartContext(state) : null)
          if (moved) return remembering(state, keepAudible(state, moved))
          // Reached the end with no repeat: stop rather than loop silently.
          return { isPlaying: false }
        }),

      toggleShuffle: () =>
        set((state) => {
          if (state.shuffle) {
            // Back to the list's own order, keeping the current track under the
            // pointer so unshuffling does not jump tracks.
            const currentSongIndex = state.contextOrder[state.contextIndex]
            return {
              shuffle: false,
              contextOrder: state.contextQueue.map((_, index) => index),
              contextIndex: currentSongIndex ?? -1,
            }
          }
          // Shuffle only what has not played yet, so the current track keeps
          // playing and what has already been heard is not replayed.
          return {
            shuffle: true,
            contextOrder: [
              ...state.contextOrder.slice(0, state.contextIndex + 1),
              ...shuffled(state.contextOrder.slice(state.contextIndex + 1)),
            ],
          }
        }),

      cycleRepeat: () =>
        set((state) => ({
          repeat: state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off',
        })),

      stop: () => {
        // `resume` lives in its own store since E3 (see `resume.ts`), and it
        // used to be cleared by this spread. Keeping that: stopping means there
        // is nothing to come back to, and a stale point would seek the *next*
        // thing played to wherever the last track stopped.
        useResume.getState().clear()
        set({ ...initialState })
      },

      /**
       * Move a hand-queued song (#234).
       *
       * The user queue only, because it is the only tier whose order is the
       * user's to choose. Reordering the context would mean reordering the
       * playlist or the library it came from, which is a different feature with
       * a different confirmation.
       *
       * An out-of-range index returns the state unchanged rather than throwing:
       * the caller is a drag gesture, and a drag that ends off the list is an
       * ordinary thing for a thumb to do, not an error.
       */
      skipToContext: (offset) =>
        set((state) => {
          // `upNext` starts *after* the pointer, so the panel's index 0 is the
          // store's `contextIndex + 1`.
          const position = state.contextIndex + 1 + offset
          const song = contextSongAt(state, position)
          if (!song) return state
          // `userQueue` is deliberately absent from the patch. Anything queued
          // by hand still plays first once this track ends.
          return remembering(
            state,
            keepAudible(state, {
              contextIndex: position,
              current: { source: 'context', song },
            }),
          )
        }),

      removeManyFromUserQueue: (indices) =>
        set((state) => {
          const drop = new Set(indices)
          return { userQueue: state.userQueue.filter((_, index) => !drop.has(index)) }
        }),

      promoteInUserQueue: (indices) =>
        set((state) => {
          const move = new Set(indices)
          // Both halves keep their existing relative order: promoting three
          // songs should not also shuffle them.
          const promoted = state.userQueue.filter((_, index) => move.has(index))
          if (promoted.length === 0) return state
          const rest = state.userQueue.filter((_, index) => !move.has(index))
          return { userQueue: [...promoted, ...rest] }
        }),

      reorderContextQueue: (from, to) =>
        set((state) => {
          const head = state.contextOrder.slice(0, state.contextIndex + 1)
          const upcoming = moved(state.contextOrder.slice(state.contextIndex + 1), from, to)
          return upcoming ? { contextOrder: [...head, ...upcoming] } : state
        }),

      removeFromContextQueue: (offset) =>
        set((state) => {
          const head = state.contextOrder.slice(0, state.contextIndex + 1)
          const upcoming = state.contextOrder.slice(state.contextIndex + 1)
          // Out of range is a no-op rather than a throw: the panel and the store
          // are separate renders, and a row removed twice by a fast double tap
          // must not take the queue with it.
          if (offset < 0 || offset >= upcoming.length) return state
          return {
            contextOrder: [...head, ...upcoming.slice(0, offset), ...upcoming.slice(offset + 1)],
          }
        }),

      reorderUserQueue: (from, to) =>
        set((state) => {
          const userQueue = moved(state.userQueue, from, to)
          return userQueue ? { userQueue } : state
        }),

      /**
       * Unmuting on purpose: reaching for the volume means "let me hear this",
       * and leaving it silent because a mute flag is still set is a bug the user
       * cannot see the cause of.
       */
      setVolume: (volume) => set({ volume: Math.min(Math.max(volume, 0), 1), muted: false }),

      toggleMute: () => set((state) => ({ muted: !state.muted })),

      setPlaybackRate: (rate) =>
        set({ playbackRate: Math.min(Math.max(rate, RATE_MIN), RATE_MAX) }),

      setCrossfadeSeconds: (seconds) =>
        set({
          crossfadeSeconds: Math.min(Math.max(Math.round(seconds), 0), CROSSFADE_MAX_SECONDS),
        }),

      /**
       * Three states in one setter, matching the web.
       *
       * `null` cancels, `'endOfTrack'` waits for the current song to finish, and
       * a number is minutes from now. The wall-clock and end-of-track forms are
       * mutually exclusive — setting either clears the other — because "stop in
       * 20 minutes" and "stop after this track" are two answers to one question,
       * and holding both would make whichever fired first look arbitrary.
       *
       * An absolute time rather than a countdown, so nothing has to tick: the
       * store stays pure, and a timer survives the app being backgrounded for
       * the same reason `resume` does.
       */
      seekTo: (seconds) =>
        set((state) => ({
          seekRequest: {
            // Negative is what a drag off the left edge produces, and it is the
            // caller's job to know the duration — so only the floor is enforced
            // here, where it is cheap and unambiguous.
            seconds: Math.max(seconds, 0),
            nonce: (state.seekRequest?.nonce ?? 0) + 1,
          },
        })),

      clearSeekRequest: () => set({ seekRequest: null }),

      setSleepTimer: (option) =>
        set(
          option === null
            ? { sleepAt: null, sleepAfterTrack: false }
            : option === 'endOfTrack'
              ? { sleepAt: null, sleepAfterTrack: true }
              : { sleepAt: Date.now() + option * 60_000, sleepAfterTrack: false },
        ),
    }),
    {
      name: 'mio-player',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state): PersistedPlayer => ({
        context: state.context,
        contextQueue: state.contextQueue,
        contextOrder: state.contextOrder,
        contextIndex: state.contextIndex,
        userQueue: state.userQueue,
        current: state.current,
        history: state.history,
        shuffle: state.shuffle,
        repeat: state.repeat,
        // Settings, so they outlive a launch — the queue is restored anyway, and
        // a phone that forgot you listen at 1.5x every morning is worse than one
        // that forgot the queue. `sleepAt` is deliberately absent: an absolute
        // time restored days later would stop playback the instant it started.
        volume: state.volume,
        muted: state.muted,
        playbackRate: state.playbackRate,
        crossfadeSeconds: state.crossfadeSeconds,
      }),
    },
  ),
)

/**
 * What is left to play in the context, in playback order — the "up next" list
 * shown below the hand-queued entries.
 *
 * Takes the three fields rather than the whole state so callers can memoize on
 * them. A selector returning a fresh array every render breaks zustand v5's
 * snapshot equality and re-renders forever.
 */
export function upNext(
  contextQueue: PlayableSong[],
  contextOrder: number[],
  contextIndex: number,
): PlayableSong[] {
  return contextOrder
    .slice(contextIndex + 1)
    .map((index) => contextQueue[index])
    .filter((song): song is PlayableSong => song != null)
}

/**
 * What `trackEnded` *would* play next, without playing it (#201).
 *
 * Crossfade has to load the next track while the current one is still going,
 * which means asking a question the store has never been asked: what comes
 * after this, if nothing changes? It has to give the same answer `trackEnded`
 * would, or the fade brings in a track the queue then does not advance to.
 *
 * That is why this reuses `advance` and `restartContext` rather than
 * reimplementing "user queue first, then context, then wrap". A second copy of
 * that order would drift, and the failure would be a track that fades in and is
 * then replaced.
 *
 * Two cases deliberately answer **null** — meaning "do not crossfade" rather
 * than "nothing is next":
 *
 * - **`sleepAfterTrack`**, because the next thing is silence. #241 already
 *   fades that, and fading *into* a track the timer is about to stop would be
 *   two fades fighting.
 * - **`repeat === 'one'`**, where the next track is this one. Crossfading a
 *   track into itself needs the same file open on both decks at different
 *   positions; it is a real thing some players do, and it is not what anyone
 *   means by repeat-one.
 */
export function peekNextSong(state: PlayerState): PlayableSong | null {
  if (!state.current) return null
  if (state.sleepAfterTrack) return null
  if (state.repeat === 'one') return null

  const moved = advance(state) ?? (state.repeat === 'all' ? restartContext(state) : null)
  return moved?.current?.song ?? null
}
