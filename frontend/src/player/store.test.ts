import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Song } from '../api/types'
import {
  selectContextUpNext,
  selectCurrentSong,
  selectHasNext,
  usePlayerStore,
  type PlayerStore,
} from './store'

function makeSong(id: number): Song {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: null,
    duration: 100,
    source_url: `https://example.com/${id}`,
    source_platform: 'Youtube',
    added_at: '2026-07-22T12:00:00Z',
  }
}

const songs = [makeSong(1), makeSong(2), makeSong(3)]

function state(): PlayerStore {
  return usePlayerStore.getState()
}

function current() {
  return selectCurrentSong(state())
}

function play(list: Song[] = songs, startIndex = 0) {
  state().playFromContext(list, startIndex, { kind: 'library' })
}

beforeEach(() => {
  localStorage.clear()
  usePlayerStore.setState({
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
    restartNonce: 0,
  })
})

describe('playFromContext', () => {
  it('starts playing from the requested song', () => {
    play(songs, 1)

    expect(current()?.id).toBe(2)
    expect(state().isPlaying).toBe(true)
    expect(state().current?.source).toBe('context')
  })

  it('ignores an empty list', () => {
    play([])

    expect(current()).toBeNull()
    expect(state().isPlaying).toBe(false)
  })

  it('clamps an out-of-range start index', () => {
    play(songs, 99)

    expect(current()?.id).toBe(3)
  })

  it('plays the chosen song first even with shuffle on', () => {
    usePlayerStore.setState({ shuffle: true })

    play(songs, 2)

    expect(current()?.id).toBe(3)
    expect(state().contextOrder).toHaveLength(3)
  })

  it('records the context so the queue panel can name it', () => {
    state().playFromContext(songs, 0, { kind: 'playlist', id: 7, name: 'Road Trip' })

    expect(state().context).toEqual({ kind: 'playlist', id: 7, name: 'Road Trip' })
  })
})

// The whole reason this store was rewritten.
describe('the user queue survives context changes', () => {
  it('keeps hand-queued tracks when a different list starts playing', () => {
    play(songs, 0)
    state().addToQueue(makeSong(99))

    play([makeSong(50), makeSong(51)], 0)

    expect(state().userQueue.map((song) => song.id)).toEqual([99])
    expect(current()?.id).toBe(50)
  })

  it('plays the user queue before resuming the context', () => {
    play(songs, 0) // playing 1, context continues 2, 3
    state().addToQueue(makeSong(99))

    state().next()
    expect(current()?.id).toBe(99)
    expect(state().current?.source).toBe('user')

    // Consumed as it plays, and the context picks up where it left off.
    expect(state().userQueue).toEqual([])
    state().next()
    expect(current()?.id).toBe(2)
    expect(state().current?.source).toBe('context')
  })

  it('drains several queued tracks in order before the context', () => {
    play(songs, 0)
    state().addToQueue(makeSong(98))
    state().addToQueue(makeSong(99))

    state().next()
    expect(current()?.id).toBe(98)
    state().next()
    expect(current()?.id).toBe(99)
    state().next()
    expect(current()?.id).toBe(2)
  })

  it('puts playNext ahead of anything already queued', () => {
    play(songs, 0)
    state().addToQueue(makeSong(98))
    state().playNext(makeSong(99))

    expect(state().userQueue.map((song) => song.id)).toEqual([99, 98])
  })

  it('makes a queued song current when nothing is playing, without autoplaying', () => {
    state().addToQueue(makeSong(42))

    expect(current()?.id).toBe(42)
    expect(state().isPlaying).toBe(false)
  })
})

describe('next and previous', () => {
  beforeEach(() => play(songs, 0))

  it('advances through the context', () => {
    state().next()

    expect(current()?.id).toBe(2)
  })

  it('stays put at the end when repeat is off', () => {
    play(songs, 2)

    state().next()

    expect(current()?.id).toBe(3)
  })

  it('wraps to the start at the end when repeating all', () => {
    play(songs, 2)
    usePlayerStore.setState({ repeat: 'all' })

    state().next()

    expect(current()?.id).toBe(1)
  })

  it('goes back a track', () => {
    play(songs, 1)

    state().previous()

    expect(current()?.id).toBe(1)
  })

  it('restarts the track instead of moving when already first', () => {
    const before = state().restartNonce

    state().previous()

    expect(current()?.id).toBe(1)
    expect(state().restartNonce).toBe(before + 1)
  })

  it('wraps backwards to the last track when repeating all', () => {
    usePlayerStore.setState({ repeat: 'all' })

    state().previous()

    expect(current()?.id).toBe(3)
  })

  it('restarts rather than rewinding out of a consumed user-queue track', () => {
    state().addToQueue(makeSong(99))
    state().next()
    const before = state().restartNonce

    state().previous()

    expect(current()?.id).toBe(99)
    expect(state().restartNonce).toBe(before + 1)
  })
})

describe('trackEnded', () => {
  beforeEach(() => play(songs, 0))

  it('advances to the next track', () => {
    state().trackEnded()

    expect(current()?.id).toBe(2)
  })

  it('takes the user queue first', () => {
    state().addToQueue(makeSong(99))

    state().trackEnded()

    expect(current()?.id).toBe(99)
  })

  it('replays the same track when repeating one', () => {
    usePlayerStore.setState({ repeat: 'one' })
    const before = state().restartNonce

    state().trackEnded()

    expect(current()?.id).toBe(1)
    expect(state().restartNonce).toBe(before + 1)
  })

  it('repeats a user-queue track too when repeating one', () => {
    state().addToQueue(makeSong(99))
    state().next()
    usePlayerStore.setState({ repeat: 'one' })

    state().trackEnded()

    expect(current()?.id).toBe(99)
  })

  it('stops at the end of the context when repeat is off', () => {
    play(songs, 2)

    state().trackEnded()

    expect(state().isPlaying).toBe(false)
    expect(current()?.id).toBe(3)
  })

  it('loops back to the first track when repeating all', () => {
    play(songs, 2)
    usePlayerStore.setState({ repeat: 'all' })

    state().trackEnded()

    expect(current()?.id).toBe(1)
  })
})

describe('shuffle', () => {
  it('keeps the current song playing when turned on', () => {
    play(songs, 1)

    state().toggleShuffle()

    expect(current()?.id).toBe(2)
    expect(state().contextOrder).toHaveLength(3)
  })

  it('restores the list order and position when turned off', () => {
    play(songs, 2)
    state().toggleShuffle()

    state().toggleShuffle()

    expect(state().contextOrder).toEqual([0, 1, 2])
    expect(current()?.id).toBe(3)
  })

  it('never loses or duplicates a song', () => {
    play(songs, 0)

    state().toggleShuffle()

    expect([...state().contextOrder].sort()).toEqual([0, 1, 2])
  })

  it('only shuffles what has not played yet', () => {
    play(songs, 1) // positions 0 and 1 are already behind the pointer

    state().toggleShuffle()

    expect(state().contextOrder.slice(0, 2)).toEqual([0, 1])
  })

  it('produces a different order than the source for a large context', () => {
    const many = Array.from({ length: 20 }, (_, i) => makeSong(i + 1))
    vi.spyOn(Math, 'random').mockReturnValue(0)

    play(many, 0)
    state().toggleShuffle()

    expect(state().contextOrder).not.toEqual(many.map((_, i) => i))
    expect([...state().contextOrder].sort((a, b) => a - b)).toEqual(many.map((_, i) => i))
    vi.mocked(Math.random).mockRestore()
  })
})

describe('queue editing', () => {
  it('removes one entry from the user queue', () => {
    play(songs, 0)
    state().addToQueue(makeSong(98))
    state().addToQueue(makeSong(99))

    state().removeFromUserQueue(0)

    expect(state().userQueue.map((song) => song.id)).toEqual([99])
  })

  it('removes an upcoming context track without moving the pointer', () => {
    play(songs, 0)

    state().removeFromContextQueue(2) // drop Song 3

    expect(current()?.id).toBe(1)
    expect(selectContextUpNext(state()).map((song) => song.id)).toEqual([2])
  })

  it('keeps the current track under the pointer when an earlier one is removed', () => {
    play(songs, 2)

    state().removeFromContextQueue(0)

    expect(current()?.id).toBe(3)
    expect(selectContextUpNext(state())).toEqual([])
  })

  it('reorders the user queue', () => {
    play(songs, 0)
    state().addToQueue(makeSong(97))
    state().addToQueue(makeSong(98))
    state().addToQueue(makeSong(99))

    state().reorderUserQueue(2, 0)

    expect(state().userQueue.map((song) => song.id)).toEqual([99, 97, 98])
  })

  it('reorders what is still to play in the context, indexed from the panel', () => {
    play(songs, 0) // playing 1; up next is [2, 3]

    state().reorderContextUpNext(1, 0)

    expect(selectContextUpNext(state()).map((song) => song.id)).toEqual([3, 2])
    // The track playing is untouched by a reorder of what follows it.
    expect(current()?.id).toBe(1)
  })

  it('ignores a reorder that lands nowhere', () => {
    play(songs, 0)
    state().addToQueue(makeSong(99))

    state().reorderUserQueue(0, 5)
    state().reorderUserQueue(-1, 0)
    state().reorderUserQueue(0, 0)

    expect(state().userQueue.map((song) => song.id)).toEqual([99])
  })

  it('clears only the user queue, leaving the context playing', () => {
    play(songs, 0)
    state().addToQueue(makeSong(99))

    state().clearUserQueue()

    expect(state().userQueue).toEqual([])
    expect(current()?.id).toBe(1)
  })

  it('clears everything but the volume settings', () => {
    play(songs, 0)
    state().addToQueue(makeSong(99))
    state().setVolume(0.5)

    state().clearQueue()

    expect(current()).toBeNull()
    expect(state().userQueue).toEqual([])
    expect(state().contextOrder).toEqual([])
    expect(state().volume).toBe(0.5)
  })
})

describe('removeSongById', () => {
  it('drops a deleted song from both tiers', () => {
    play(songs, 0)
    state().addToQueue(makeSong(2))

    state().removeSongById(2)

    expect(state().userQueue).toEqual([])
    expect(selectContextUpNext(state()).map((song) => song.id)).toEqual([3])
  })

  it('keeps the current song under the pointer when an earlier one is removed', () => {
    play(songs, 2)

    state().removeSongById(1)

    expect(current()?.id).toBe(3)
  })

  it('advances to the next song when the current one is removed', () => {
    play(songs, 1)

    state().removeSongById(2)

    expect(current()?.id).toBe(3)
  })

  it('falls through to the user queue when the current song is removed', () => {
    play(songs, 2) // last context track
    state().addToQueue(makeSong(99))

    state().removeSongById(3)

    expect(current()?.id).toBe(99)
  })

  it('stops playing when removing the last remaining song', () => {
    play([songs[0]])

    state().removeSongById(1)

    expect(current()).toBeNull()
    expect(state().isPlaying).toBe(false)
  })

  it('is a no-op for a song that is not queued', () => {
    play(songs, 1)

    state().removeSongById(99)

    expect(state().contextOrder).toHaveLength(3)
    expect(current()?.id).toBe(2)
  })
})

describe('playback rate', () => {
  it('clamps to a sane range', () => {
    state().setPlaybackRate(9)
    expect(state().playbackRate).toBe(4)

    state().setPlaybackRate(0)
    expect(state().playbackRate).toBe(0.25)
  })

  it('is persisted, unlike the sleep timer', () => {
    state().setPlaybackRate(1.5)
    state().setSleepTimer(30)

    const persisted = JSON.parse(localStorage.getItem('mio-player') ?? '{}').state
    expect(persisted.playbackRate).toBe(1.5)
    // A timer that survived a reload would stop playback out of nowhere.
    expect(persisted).not.toHaveProperty('sleepAt')
  })
})

describe('sleep timer', () => {
  it('sets a wall-clock deadline from minutes', () => {
    const before = Date.now()

    state().setSleepTimer(30)

    expect(state().sleepAt).toBeGreaterThanOrEqual(before + 30 * 60_000)
    expect(state().sleepAfterTrack).toBe(false)
  })

  it('stops at the end of the track when asked', () => {
    play(songs, 0)
    state().setSleepTimer('endOfTrack')

    state().trackEnded()

    expect(state().isPlaying).toBe(false)
    // ...and the track does not advance.
    expect(current()?.id).toBe(1)
    expect(state().sleepAfterTrack).toBe(false)
  })

  it('beats repeat-one, which would otherwise never let it fire', () => {
    play(songs, 0)
    usePlayerStore.setState({ repeat: 'one' })
    state().setSleepTimer('endOfTrack')

    state().trackEnded()

    expect(state().isPlaying).toBe(false)
  })

  it('cancels back to no timer', () => {
    state().setSleepTimer(15)

    state().setSleepTimer(null)

    expect(state().sleepAt).toBeNull()
    expect(state().sleepAfterTrack).toBe(false)
  })
})

describe('selectors', () => {
  it('reports a next track from the user queue even at the end of the context', () => {
    play(songs, 2)
    expect(selectHasNext(state())).toBe(false)

    state().addToQueue(makeSong(99))

    expect(selectHasNext(state())).toBe(true)
  })

  it('reports a next track when repeating all', () => {
    play(songs, 2)
    usePlayerStore.setState({ repeat: 'all' })

    expect(selectHasNext(state())).toBe(true)
  })
})

describe('persistence', () => {
  it('writes both tiers to localStorage, without transient fields', () => {
    play(songs, 1)
    state().addToQueue(makeSong(99))

    const persisted = JSON.parse(localStorage.getItem('mio-player') ?? '{}').state
    expect(persisted.contextQueue.map((song: Song) => song.id)).toEqual([1, 2, 3])
    expect(persisted.contextIndex).toBe(1)
    expect(persisted.userQueue.map((song: Song) => song.id)).toEqual([99])
    expect(persisted.current.song.id).toBe(2)
    // isPlaying and restartNonce are deliberately not persisted — playback
    // rehydrates paused.
    expect(persisted).not.toHaveProperty('isPlaying')
    expect(persisted).not.toHaveProperty('restartNonce')
  })
})

describe('migrating a v1 queue', () => {
  // Nobody's saved queue should vanish on the upgrade.
  const migrate = usePlayerStore.persist.getOptions().migrate!

  it('maps the old flat queue onto the context tier', () => {
    const migrated = migrate(
      { queue: songs, sourceQueue: songs, index: 1, shuffle: false, repeat: 'all', volume: 0.4 },
      1,
    ) as ReturnType<typeof migrate> & Record<string, unknown>

    expect((migrated.contextQueue as Song[]).map((song) => song.id)).toEqual([1, 2, 3])
    expect(migrated.contextIndex).toBe(1)
    expect((migrated.current as { song: Song }).song.id).toBe(2)
    expect(migrated.userQueue).toEqual([])
    expect(migrated.repeat).toBe('all')
    expect(migrated.volume).toBe(0.4)
  })

  it('uses the unshuffled source order, keeping the playing track current', () => {
    // v1 stored `queue` already shuffled; `sourceQueue` held the real order.
    const migrated = migrate(
      { queue: [songs[2], songs[0], songs[1]], sourceQueue: songs, index: 0 },
      1,
    ) as Record<string, unknown>

    expect((migrated.contextQueue as Song[]).map((song) => song.id)).toEqual([1, 2, 3])
    // Song 3 was playing, and it sits at position 2 of the source order.
    expect(migrated.contextIndex).toBe(2)
    expect((migrated.current as { song: Song }).song.id).toBe(3)
  })

  it('survives an empty or absent v1 queue', () => {
    const migrated = migrate({}, 1) as Record<string, unknown>

    expect(migrated.contextQueue).toEqual([])
    expect(migrated.current).toBeNull()
    expect(migrated.contextIndex).toBe(-1)
  })
})

describe('a song that appears twice in a row (#184)', () => {
  // Not contrived: an imported playlist can hold the same track twice, and two
  // overlapping playlists mean one Song row under both entries.
  const twice = [makeSong(1), makeSong(1), makeSong(2)]

  it('restarts the track rather than silently doing nothing', () => {
    state().playFromContext(twice, 0)
    const before = state().restartNonce

    state().trackEnded()

    // Moved on in the queue...
    expect(state().contextIndex).toBe(1)
    // ...and told the element to start over, which is the only way the second
    // copy is audible: `useAudioElement` skips reloading a deck whose song id
    // has not changed, so without this the track silently stops.
    expect(state().restartNonce).toBe(before + 1)
  })

  it('leaves the nonce alone when the next track is genuinely different', () => {
    state().playFromContext(twice, 1)
    const before = state().restartNonce

    state().trackEnded()

    expect(state().contextIndex).toBe(2)
    expect(selectCurrentSong(state())?.id).toBe(2)
    // A real track change reloads the deck by itself; bumping here would restart
    // a track that had only just started.
    expect(state().restartNonce).toBe(before)
  })

  it('does the same for an explicit next', () => {
    state().playFromContext(twice, 0)
    const before = state().restartNonce

    state().next()

    expect(state().contextIndex).toBe(1)
    expect(state().restartNonce).toBe(before + 1)
  })

  it('does the same going backwards', () => {
    state().playFromContext(twice, 1)
    const before = state().restartNonce

    state().previous()

    expect(state().contextIndex).toBe(0)
    expect(state().restartNonce).toBe(before + 1)
  })

  it('restarts when the song already playing is tapped again', () => {
    state().playFromContext(twice, 0)
    const before = state().restartNonce

    state().playFromContext(twice, 0)

    expect(state().restartNonce).toBe(before + 1)
  })

  it('restarts on repeat-all in a one-song context', () => {
    state().playFromContext([makeSong(1)], 0)
    state().cycleRepeat() // off -> all
    expect(state().repeat).toBe('all')
    const before = state().restartNonce

    state().trackEnded()

    expect(state().restartNonce).toBe(before + 1)
  })
})

describe('resuming where playback stopped (#183)', () => {
  it('starts with nothing to resume', () => {
    expect(state().resume).toBeNull()
  })

  it('remembers a position against the song it came from', () => {
    state().playFromContext(songs, 0)
    state().setResume(1, 42.5)

    expect(state().resume).toEqual({ songId: 1, seconds: 42.5 })
  })

  it('keys the position by song, so it cannot be applied to the wrong track', () => {
    // The self-invalidating property is the point: nothing has to remember to
    // clear this on a queue transition, because a position for song 1 is
    // meaningless once song 2 is playing.
    state().playFromContext(songs, 0)
    state().setResume(1, 30)
    state().next()

    expect(selectCurrentSong(state())?.id).toBe(2)
    expect(state().resume?.songId).toBe(1)
  })

  it('keeps only the most recent position', () => {
    state().setResume(1, 30)
    state().setResume(2, 5)

    // Coming back to song 1 later therefore starts from the beginning. Storing
    // a position per song would be a different feature ("remember where I was in
    // every track"), and is not what was asked for.
    expect(state().resume).toEqual({ songId: 2, seconds: 5 })
  })

  it('does not persist whether it was playing, so a reload comes back paused', () => {
    // I asked for this explicitly: restored on the same timestamp, but
    // paused. `isPlaying` is absent from `partialize`, so it rehydrates false.
    state().playFromContext(songs, 0)
    expect(state().isPlaying).toBe(true)

    const persisted = JSON.parse(localStorage.getItem('mio-player') ?? '{}')
    expect(persisted.state).not.toHaveProperty('isPlaying')
    expect(persisted.state).toHaveProperty('resume')
  })
})
