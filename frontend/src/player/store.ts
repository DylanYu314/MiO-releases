import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { Song } from '../api/types'

export type RepeatMode = 'off' | 'all' | 'one'

/** Where the currently-playing list came from, for the queue panel's
 *  "Next from: …" heading. */
export type ContextKind = 'library' | 'playlist' | 'search'

export interface PlaybackContext {
  kind: ContextKind
  /** The playlist's id, when kind is 'playlist'. */
  id?: number
  /** Human-readable name of the source, shown in the queue panel. */
  name?: string
}

export interface CurrentTrack {
  source: 'user' | 'context'
  song: Song
}

/**
 * Playback runs on two tiers, like Spotify's:
 *
 * - the **context queue** is whatever list you started playing (a playlist, a
 *   page of the library). Playing something else replaces it wholesale.
 * - the **user queue** is what you added by hand. It always plays first, and
 *   nothing replaces it — that is the entire point. Entries are consumed as
 *   they play.
 *
 * `contextOrder` is a permutation of indices into `contextQueue`, so shuffling
 * reorders playback without destroying the list's own order.
 */
interface PlayerState {
  context: PlaybackContext | null
  contextQueue: Song[]
  contextOrder: number[]
  /** Position within `contextOrder`; -1 before anything from the context plays. */
  contextIndex: number
  userQueue: Song[]
  current: CurrentTrack | null
  isPlaying: boolean
  shuffle: boolean
  repeat: RepeatMode
  volume: number
  muted: boolean
  /** Playback speed multiplier; 1 is normal. */
  playbackRate: number
  /** Epoch ms at which playback should stop, or null for no timer. */
  sleepAt: number | null
  /** Stop once the current track finishes, rather than at a wall-clock time. */
  sleepAfterTrack: boolean
  /** Seconds of overlap between tracks; 0 is off. See CROSSFADE_MAX_SECONDS. */
  crossfadeSeconds: number
  /** Bumped to ask the audio element to restart the track from 0. */
  restartNonce: number
  /**
   * Where playback had reached, so a reload returns to the same second (#183).
   *
   * Keyed by song id rather than stored bare, which makes it self-invalidating:
   * a position only ever applies to the track it was taken from, so nothing has
   * to remember to clear it on every queue transition. Coming back to a track
   * after playing something else starts it from zero, because only the most
   * recent position is kept.
   */
  resume: { songId: number; seconds: number } | null
}

interface PlayerActions {
  /** Play `songs` from `startIndex`, replacing the context. Never touches the
   *  user queue. */
  playFromContext: (songs: Song[], startIndex?: number, context?: PlaybackContext | null) => void
  /** Append to the user queue. */
  addToQueue: (song: Song) => void
  /** Put at the front of the user queue, so it plays after the current track. */
  playNext: (song: Song) => void
  removeFromUserQueue: (index: number) => void
  /** Remove by position within the playback order, not the source list. */
  removeFromContextQueue: (position: number) => void
  /** Move a user-queue entry, by index within the user queue. */
  reorderUserQueue: (from: number, to: number) => void
  /** Move an upcoming context track, by index within what's still to play. */
  reorderContextUpNext: (from: number, to: number) => void
  clearUserQueue: () => void
  clearQueue: () => void
  /** Drop every occurrence of a song id — used when a song is deleted, so it
   *  doesn't linger in the (persisted) queue. */
  removeSongById: (songId: number) => void
  togglePlay: () => void
  setPlaying: (isPlaying: boolean) => void
  /** Record how far into a track playback has got. Throttled by the caller. */
  setResume: (songId: number, seconds: number) => void
  next: () => void
  previous: () => void
  /** Called when a track ends, which honours repeat instead of just advancing. */
  trackEnded: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  setPlaybackRate: (rate: number) => void
  /** Minutes from now, 'endOfTrack', or null to cancel. */
  setSleepTimer: (option: number | 'endOfTrack' | null) => void
  /** Seconds of overlap between tracks; 0 turns crossfade off. */
  setCrossfadeSeconds: (seconds: number) => void
}

export type PlayerStore = PlayerState & PlayerActions

/** The longest overlap the slider offers. Beyond ~12s the blend stops reading
 *  as a transition and starts sounding like two songs playing at once. */
export const CROSSFADE_MAX_SECONDS = 12

const initialState: PlayerState = {
  context: null,
  contextQueue: [],
  contextOrder: [],
  contextIndex: -1,
  userQueue: [],
  current: null,
  isPlaying: false,
  shuffle: false,
  repeat: 'off',
  volume: 1,
  muted: false,
  playbackRate: 1,
  sleepAt: null,
  sleepAfterTrack: false,
  // Off by default: crossfade changes how every transition sounds, so it is
  // opt-in rather than something that arrives unannounced with an update.
  crossfadeSeconds: 0,
  restartNonce: 0,
  resume: null,
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

/** A copy with one item moved, or null if either index is out of range (which
 *  a drag that lands nowhere will produce). */
function moved<T>(items: T[], from: number, to: number): T[] | null {
  if (from === to) return null
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return null
  const result = [...items]
  const [item] = result.splice(from, 1)
  result.splice(to, 0, item)
  return result
}

/** The song at a position in the playback order, if there is one. */
function contextSongAt(state: PlayerState, position: number): Song | null {
  const songIndex = state.contextOrder[position]
  if (songIndex === undefined) return null
  return state.contextQueue[songIndex] ?? null
}

/**
 * Move to the next track: the user queue first, then the context.
 * Returns null when both are exhausted, leaving the caller to decide whether
 * that means wrap, or stop.
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

/** The slice of player state written to localStorage. `isPlaying` and
 *  `restartNonce` are intentionally left out — playback rehydrates paused
 *  (browsers block autoplay) and the nonce is a transient signal. */
type PersistedPlayerState = Pick<
  PlayerState,
  | 'context'
  | 'contextQueue'
  | 'contextOrder'
  | 'contextIndex'
  | 'userQueue'
  | 'current'
  | 'shuffle'
  | 'repeat'
  | 'volume'
  | 'muted'
  | 'playbackRate'
  | 'crossfadeSeconds'
  | 'resume'
>

/** The v1 shape, kept so `migrate` can read it. */
interface PersistedV1 {
  queue?: Song[]
  sourceQueue?: Song[]
  index?: number
  shuffle?: boolean
  repeat?: RepeatMode
  volume?: number
  muted?: boolean
}

// Bump when the persisted shape changes and add a branch to `migrate`.
// Still 2 after G2 added `crossfadeSeconds`: the field is purely additive with a
// safe default, and zustand's merge already leaves a missing key at its initial
// value. A bump here would advertise a migration that does not exist.
const PERSIST_VERSION = 2

/**
 * Selecting the song that is **already loaded** is invisible to the audio layer.
 *
 * `useAudioElement` only assigns `element.src` when the deck's loaded song id
 * changes — correct, since a refetch hands back an equal `Song` and reloading
 * would restart playback under the listener. But the store can legitimately
 * select the same id again, and then no command reaches the element at all:
 * silence, with `isPlaying` still true, which reads as a skipped track.
 *
 * Three ordinary cases land here: repeat-all on a one-song context, hand-queuing
 * the song that is currently playing, and **a playlist holding the same song
 * twice in a row**. The third is what #184 reported.
 *
 * Bumping `restartNonce` is the signal repeat-one already uses, and the element
 * already listens for it. The mobile store solved this in #153; the web store
 * was never given the same guard, which is why the same library misbehaves in a
 * browser and not on the phone.
 */
function keepAudible(state: PlayerStore, patch: Partial<PlayerStore>): Partial<PlayerStore> {
  if (!patch.current) return patch
  if (patch.current.song.id !== state.current?.song.id) return patch
  return { ...patch, restartNonce: state.restartNonce + 1 }
}

export const usePlayerStore = create<PlayerStore>()(
  persist(
    (set, get) => ({
      ...initialState,

      playFromContext: (songs, startIndex = 0, context = null) => {
        if (songs.length === 0) return
        const start = Math.min(Math.max(startIndex, 0), songs.length - 1)
        const identity = songs.map((_, index) => index)

        // With shuffle on the chosen song still plays first; only what follows
        // is randomised.
        const contextOrder = get().shuffle
          ? [start, ...shuffled(identity.filter((index) => index !== start))]
          : identity

        set(
          keepAudible(get(), {
            context,
            contextQueue: songs,
            contextOrder,
            contextIndex: get().shuffle ? 0 : start,
            current: { source: 'context', song: songs[start] },
            isPlaying: true,
            // userQueue is deliberately untouched — it outlives context changes.
          }),
        )
      },

      addToQueue: (song) =>
        set((state) =>
          // With nothing playing, a queued song becomes the current track so it
          // shows up in the player instead of sitting in an invisible queue.
          state.current
            ? { userQueue: [...state.userQueue, song] }
            : { current: { source: 'user', song } },
        ),

      playNext: (song) =>
        set((state) =>
          state.current
            ? { userQueue: [song, ...state.userQueue] }
            : { current: { source: 'user', song } },
        ),

      removeFromUserQueue: (index) =>
        set((state) => ({ userQueue: state.userQueue.filter((_, i) => i !== index) })),

      removeFromContextQueue: (position) =>
        set((state) => {
          if (state.contextOrder[position] === undefined) return state
          return {
            contextOrder: state.contextOrder.filter((_, i) => i !== position),
            // Keep the pointer on the current track when something earlier goes.
            contextIndex:
              position <= state.contextIndex ? state.contextIndex - 1 : state.contextIndex,
          }
        }),

      reorderUserQueue: (from, to) =>
        set((state) => {
          const userQueue = moved(state.userQueue, from, to)
          return userQueue ? { userQueue } : state
        }),

      reorderContextUpNext: (from, to) =>
        set((state) => {
          // The panel indexes what's left to play; the store indexes the whole
          // order, so shift past everything already behind the pointer.
          const offset = state.contextIndex + 1
          const contextOrder = moved(state.contextOrder, offset + from, offset + to)
          return contextOrder ? { contextOrder } : state
        }),

      clearUserQueue: () => set({ userQueue: [] }),

      clearQueue: () =>
        set({ ...initialState, volume: get().volume, muted: get().muted, shuffle: get().shuffle }),

      removeSongById: (songId) =>
        set((state) => {
          const isCurrent = state.current?.song.id === songId
          const present =
            isCurrent ||
            state.userQueue.some((song) => song.id === songId) ||
            state.contextQueue.some((song) => song.id === songId)
          if (!present) return state

          const userQueue = state.userQueue.filter((song) => song.id !== songId)
          // Positions at or before the pointer that disappear shift it left, so
          // whatever is playing stays under it.
          const removedBefore = state.contextOrder
            .slice(0, state.contextIndex + 1)
            .filter((index) => state.contextQueue[index]?.id === songId).length
          const contextOrder = state.contextOrder.filter(
            (index) => state.contextQueue[index]?.id !== songId,
          )
          const base = {
            userQueue,
            contextOrder,
            contextIndex: state.contextIndex - removedBefore,
          }
          if (!isCurrent) return base

          // The track playing was the one deleted — move on to whatever follows.
          const moved = advance({ ...state, ...base })
          if (moved) return { ...base, ...moved }
          return { ...base, current: null, isPlaying: false }
        }),

      togglePlay: () => set((state) => (state.current ? { isPlaying: !state.isPlaying } : state)),

      setPlaying: (isPlaying) => set({ isPlaying }),

      setResume: (songId, seconds) => set({ resume: { songId, seconds } }),

      next: () =>
        set((state) => {
          if (!state.current) return state
          const moved = advance(state)
          if (moved) return keepAudible(state, moved)
          // Explicit next at the end wraps only when repeating the whole queue.
          const wrapped = state.repeat === 'all' ? restartContext(state) : null
          return wrapped ? keepAudible(state, wrapped) : state
        }),

      previous: () =>
        set((state) => {
          if (!state.current) return state
          // A consumed user-queue entry can't be un-consumed, so going back from
          // one restarts it rather than silently jumping into the context.
          if (state.current.source === 'user') return { restartNonce: state.restartNonce + 1 }

          const song = contextSongAt(state, state.contextIndex - 1)
          if (song)
            return keepAudible(state, {
              contextIndex: state.contextIndex - 1,
              current: { source: 'context', song },
            })

          if (state.repeat === 'all') {
            const last = state.contextOrder.length - 1
            const wrapped = contextSongAt(state, last)
            if (wrapped)
              return keepAudible(state, {
                contextIndex: last,
                current: { source: 'context', song: wrapped },
              })
          }
          return { restartNonce: state.restartNonce + 1 }
        }),

      trackEnded: () =>
        set((state) => {
          if (!state.current) return state
          // A sleep timer set to "end of track" wins over repeat — the point is
          // to stop, and repeat-one would otherwise never let it.
          if (state.sleepAfterTrack) return { isPlaying: false, sleepAfterTrack: false }
          if (state.repeat === 'one') return { restartNonce: state.restartNonce + 1 }

          const moved = advance(state)
          if (moved) return keepAudible(state, moved)
          if (state.repeat === 'all') {
            const wrapped = restartContext(state)
            if (wrapped) return keepAudible(state, wrapped)
          }
          // Reached the end with no repeat: stop rather than looping silently.
          return { isPlaying: false }
        }),

      toggleShuffle: () =>
        set((state) => {
          if (state.shuffle) {
            // Back to the list's own order, keeping the current track under the
            // pointer.
            const currentSongIndex = state.contextOrder[state.contextIndex]
            return {
              shuffle: false,
              contextOrder: state.contextQueue.map((_, index) => index),
              contextIndex: currentSongIndex ?? -1,
            }
          }
          // Shuffle only what hasn't played yet, so the current track keeps
          // playing and what's already been heard isn't replayed.
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

      setVolume: (volume) => set({ volume: Math.min(Math.max(volume, 0), 1), muted: false }),

      toggleMute: () => set((state) => ({ muted: !state.muted })),

      setPlaybackRate: (rate) => set({ playbackRate: Math.min(Math.max(rate, 0.25), 4) }),

      setCrossfadeSeconds: (seconds) =>
        set({
          crossfadeSeconds: Math.min(Math.max(Math.round(seconds), 0), CROSSFADE_MAX_SECONDS),
        }),

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
      version: PERSIST_VERSION,
      partialize: (state): PersistedPlayerState => ({
        context: state.context,
        contextQueue: state.contextQueue,
        contextOrder: state.contextOrder,
        contextIndex: state.contextIndex,
        userQueue: state.userQueue,
        current: state.current,
        shuffle: state.shuffle,
        repeat: state.repeat,
        volume: state.volume,
        muted: state.muted,
        playbackRate: state.playbackRate,
        crossfadeSeconds: state.crossfadeSeconds,
        resume: state.resume,
      }),
      migrate: (persisted, version) => {
        if (version < 2) {
          // v1 held one flat list (`queue`, shuffled in place) plus the
          // unshuffled `sourceQueue`. Map it onto the context tier and start
          // with an empty user queue, so a saved queue survives the upgrade
          // instead of being dropped.
          const old = (persisted ?? {}) as PersistedV1
          const contextQueue = old.sourceQueue?.length ? old.sourceQueue : (old.queue ?? [])
          const playing = old.queue?.[old.index ?? 0] ?? null
          const contextIndex = playing
            ? contextQueue.findIndex((song) => song.id === playing.id)
            : -1

          return {
            context: null,
            contextQueue,
            contextOrder: contextQueue.map((_, index) => index),
            contextIndex,
            userQueue: [],
            current: playing ? { source: 'context', song: playing } : null,
            shuffle: old.shuffle ?? false,
            repeat: old.repeat ?? 'off',
            volume: old.volume ?? 1,
            muted: old.muted ?? false,
            playbackRate: 1,
            crossfadeSeconds: 0,
            // No position was recorded before #183, so an upgraded session
            // starts its restored track from the beginning rather than guessing.
            resume: null,
          } satisfies PersistedPlayerState
        }
        return persisted as PersistedPlayerState
      },
    },
  ),
)

/** The song playing right now, if any. */
export function selectCurrentSong(state: PlayerStore): Song | null {
  return state.current?.song ?? null
}

/** Whether "next" would go anywhere — the user queue, more context, or a wrap. */
export function selectHasNext(state: PlayerStore): boolean {
  if (state.userQueue.length > 0) return true
  if (state.contextIndex + 1 < state.contextOrder.length) return true
  return state.repeat === 'all' && state.contextOrder.length > 0
}

/**
 * What `next()` would land on, without consuming anything.
 *
 * The crossfade needs to know the incoming track a few seconds *before* it
 * plays, so it can preload the other deck. Mirrors `next()`'s own order — user
 * queue first, then the context, then a repeat-all wrap.
 */
export function selectNextSong(state: PlayerStore): Song | null {
  if (!state.current) return null
  if (state.userQueue.length > 0) return state.userQueue[0]

  const upcoming = contextSongAt(state, state.contextIndex + 1)
  if (upcoming) return upcoming

  if (state.repeat === 'all') return contextSongAt(state, 0)
  return null
}

/** What's left of the context after the current track, in playback order. */
export function selectContextUpNext(state: PlayerStore): Song[] {
  return state.contextOrder
    .slice(state.contextIndex + 1)
    .map((index) => state.contextQueue[index])
    .filter((song): song is Song => song !== undefined)
}
