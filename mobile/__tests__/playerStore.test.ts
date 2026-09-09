import AsyncStorage from '@react-native-async-storage/async-storage'
import type { Song } from '../src/api/types'
import { CROSSFADE_MAX_SECONDS, peekNextSong, upNext, usePlayer } from '../src/player/store'
import { useResume } from '../src/player/resume'

/**
 * The two-tier queue (ADR-011), mirrored on the phone.
 *
 * The rules being pinned here are the ones that are easy to get subtly wrong
 * and impossible to notice until a user loses their queue: that the user queue
 * survives a context change, that the context pointer does not move while a
 * hand-queued song plays, and that shuffle is a permutation rather than a
 * rewrite.
 */

function song(id: number, title = `Song ${id}`): Song {
  return {
    id,
    title,
    artist: `Artist ${id}`,
    album: null,
    duration: 200,
    source_url: `https://example.com/${id}`,
    source_platform: 'youtube',
    added_at: '2026-07-25T00:00:00Z',
    loudness_lufs: null,
    peak_dbfs: null,
  }
}

const LIBRARY = [song(1), song(2), song(3)]

function reset() {
  usePlayer.setState({
    context: null,
    contextQueue: [],
    contextOrder: [],
    contextIndex: -1,
    userQueue: [],
    current: null,
    history: [],
    isPlaying: false,
    shuffle: false,
    repeat: 'off',
    restartNonce: 0,
  })
}

beforeEach(reset)

const state = () => usePlayer.getState()
const currentId = () => state().current?.song.id ?? null

describe('playing from a context', () => {
  it('starts at the chosen song and plays', () => {
    state().playFromContext(LIBRARY, 1, { kind: 'library' })

    expect(currentId()).toBe(2)
    expect(state().isPlaying).toBe(true)
    expect(state().current?.source).toBe('context')
  })

  it('walks the rest of the list on next', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().next()

    expect(currentId()).toBe(2)
  })

  it('stops at the end rather than looping, with repeat off', () => {
    state().playFromContext(LIBRARY, 2, { kind: 'library' })
    state().next()

    expect(currentId()).toBe(3)
  })

  it('clamps a start index that is past the end', () => {
    state().playFromContext(LIBRARY, 99, { kind: 'library' })

    expect(currentId()).toBe(3)
  })

  it('ignores an empty list rather than clearing what is playing', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().playFromContext([], 0, { kind: 'playlist' })

    expect(currentId()).toBe(1)
  })
})

describe('the user queue outlives the context', () => {
  it('survives starting a different list — the whole point of two tiers', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().addToQueue(song(50))
    state().addToQueue(song(51))

    state().playFromContext([song(90), song(91)], 0, { kind: 'playlist', name: 'Road Trip' })

    expect(state().userQueue.map((s) => s.id)).toEqual([50, 51])
    expect(currentId()).toBe(90)
  })

  it('plays hand-queued songs before the context', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().addToQueue(song(50))
    state().next()

    expect(currentId()).toBe(50)
    expect(state().current?.source).toBe('user')
  })

  it('leaves the context pointer alone while a queued song plays', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().addToQueue(song(50))

    state().next() // the queued song
    state().next() // back into the context

    // Song 2, not song 3: the queued entry did not consume a context slot.
    expect(currentId()).toBe(2)
  })

  it('puts playNext ahead of everything already queued', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().addToQueue(song(50))
    state().playNext(song(60))

    expect(state().userQueue.map((s) => s.id)).toEqual([60, 50])
  })

  it('makes a queued song current when nothing is playing, not invisible', () => {
    state().addToQueue(song(50))

    expect(currentId()).toBe(50)
    expect(state().isPlaying).toBe(true)
  })

  it('removes one entry without disturbing the rest', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().addToQueue(song(50))
    state().addToQueue(song(51))
    state().addToQueue(song(52))
    state().removeFromUserQueue(1)

    expect(state().userQueue.map((s) => s.id)).toEqual([50, 52])
  })
})

describe('repeat', () => {
  it('wraps to the start of the context on repeat-all', () => {
    state().playFromContext(LIBRARY, 2, { kind: 'library' })
    usePlayer.setState({ repeat: 'all' })
    state().next()

    expect(currentId()).toBe(1)
  })

  it('asks for a restart rather than advancing on repeat-one', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    usePlayer.setState({ repeat: 'one' })
    const before = state().restartNonce
    state().trackEnded()

    expect(state().restartNonce).toBe(before + 1)
    expect(currentId()).toBe(1)
  })

  it('stops at the end of the context when a track finishes with repeat off', () => {
    state().playFromContext(LIBRARY, 2, { kind: 'library' })
    state().trackEnded()

    expect(state().isPlaying).toBe(false)
    expect(currentId()).toBe(3)
  })

  it('drains the user queue before honouring repeat-all', () => {
    state().playFromContext(LIBRARY, 2, { kind: 'library' })
    usePlayer.setState({ repeat: 'all' })
    state().addToQueue(song(50))
    state().trackEnded()

    expect(currentId()).toBe(50)
  })
})

describe('previous', () => {
  it('steps back through the context', () => {
    state().playFromContext(LIBRARY, 1, { kind: 'library' })
    state().previous()

    expect(currentId()).toBe(1)
  })

  it('restarts the first track rather than falling off the front', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    const before = state().restartNonce

    state().previous()

    expect(currentId()).toBe(1)
    expect(state().restartNonce).toBe(before + 1)
  })
})

/**
 * Walking back through what actually played (2026-08-10 device pass).
 *
 * `previous` used to be `contextIndex - 1`, which made it a function of the
 * *list* rather than of playback. A hand-queued song is consumed out of
 * `userQueue` the moment it starts, so it had nothing behind it and the button
 * restarted the track instead. I built a session by swiping songs into the
 * queue and reported previous as broken: *"the tracks before it somehow not
 * exist. or, it could just be that the previous track button mistakenly
 * programmed to replay a track"* — both readings were right.
 *
 * These are the cases the context arithmetic could never cover.
 */
describe('previous, across both tiers', () => {
  it('goes back out of a hand-queued song into what played before it', () => {
    state().playFromContext(LIBRARY, 1, { kind: 'library' })
    state().addToQueue(song(50))
    state().next()
    expect(currentId()).toBe(50)

    state().previous()

    expect(currentId()).toBe(2)
    // Back in the list, so the *next* press carries on down it rather than
    // jumping to wherever the pointer happened to be left.
    expect(state().current?.source).toBe('context')
    state().next()
    expect(currentId()).toBe(3)
  })

  it('walks back through a whole session of hand-queued songs', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().addToQueue(song(50))
    state().addToQueue(song(51))
    state().next()
    state().next()
    expect(currentId()).toBe(51)

    state().previous()
    expect(currentId()).toBe(50)
    state().previous()
    expect(currentId()).toBe(1)
  })

  it('returns to the song playing before a different list was started', () => {
    state().playFromContext(LIBRARY, 2, { kind: 'library' })
    state().playFromContext([song(90), song(91)], 0, { kind: 'playlist', id: 'p1' })
    expect(currentId()).toBe(90)

    state().previous()

    expect(currentId()).toBe(3)
    /*
     * A song from the *old* list, so the pointer must not be moved to match it —
     * `contextIndex` describes the list playing now. Treated as a queue entry
     * instead, which is what makes the following `next` carry on down the new
     * list rather than jumping back into the old one.
     */
    expect(state().current?.source).toBe('user')
    state().next()
    expect(currentId()).toBe(91)
  })

  it('records a track that ended on its own, not only one that was skipped', () => {
    // `trackEnded` is the common case by a wide margin — most tracks are not
    // skipped — and it is a different code path from `next`.
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().addToQueue(song(50))
    state().trackEnded()
    expect(currentId()).toBe(50)

    state().previous()

    expect(currentId()).toBe(1)
  })

  it('records a jump made from the queue panel', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().skipToContext(1)
    expect(currentId()).toBe(3)

    state().previous()

    expect(currentId()).toBe(1)
  })

  it('does not record a track that merely restarted', () => {
    /*
     * One song on repeat-all: `restartContext` lands on the song already
     * playing, which is the same track going round rather than two tracks
     * having played. Recording it would add an entry per loop — a night of
     * one song on repeat evicts the real history — and it is also just untrue.
     */
    state().playFromContext([song(7)], 0, { kind: 'library' })
    usePlayer.setState({ repeat: 'all' })
    state().trackEnded()
    state().trackEnded()
    state().trackEnded()

    expect(currentId()).toBe(7)
    expect(state().history).toHaveLength(0)
  })

  it('does not record a track that repeat-one played again', () => {
    state().playFromContext(LIBRARY, 1, { kind: 'library' })
    usePlayer.setState({ repeat: 'one' })
    state().trackEnded()
    state().trackEnded()
    usePlayer.setState({ repeat: 'off' })

    state().previous()

    // Not song 2 three times over: repeat-one is the same track playing again,
    // not two tracks having played.
    expect(currentId()).toBe(1)
  })

  it('forgets a song that has been deleted from the device', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().next()
    expect(currentId()).toBe(2)

    state().removeSongById(1)
    state().previous()

    // Song 1 is gone, so previous must not land on it — the nearest thing it can
    // honestly do is restart, which is what the empty-history fallback does.
    expect(currentId()).toBe(2)
    expect(state().history).toHaveLength(0)
  })

  it('keeps the pointer usable after going back across a deletion', () => {
    state().playFromContext([song(1), song(2), song(3), song(4)], 0, { kind: 'library' })
    state().next()
    state().next()
    expect(currentId()).toBe(3)

    // Removes an entry *before* the recorded one, which shifts every later
    // position left by one — the case a naive filter gets wrong by landing the
    // user on the neighbour of the song they asked for.
    state().removeSongById(1)
    state().previous()

    expect(currentId()).toBe(2)
    state().next()
    expect(currentId()).toBe(3)
  })

  it('stops growing without end', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    for (let i = 0; i < 120; i++) {
      state().addToQueue(song(1000 + i))
      state().next()
    }

    // Persisted state, so an unbounded record is a file that grows for as long
    // as the app is used.
    expect(state().history.length).toBeLessThanOrEqual(50)
    // And it is the *recent* end that is kept: the button walks backwards.
    expect(state().history[state().history.length - 1]?.song.id).toBe(1118)
  })
})

describe('shuffle', () => {
  it('keeps the tapped song playing when shuffle is turned on', () => {
    state().playFromContext(LIBRARY, 1, { kind: 'library' })
    state().toggleShuffle()

    expect(currentId()).toBe(2)
  })

  it('plays the tapped song first even when shuffle is already on', () => {
    usePlayer.setState({ shuffle: true })
    state().playFromContext(LIBRARY, 2, { kind: 'library' })

    expect(currentId()).toBe(3)
  })

  it('restores the list order on unshuffle, still on the same song', () => {
    state().playFromContext(LIBRARY, 1, { kind: 'library' })
    state().toggleShuffle()
    state().toggleShuffle()

    expect(state().contextOrder).toEqual([0, 1, 2])
    expect(currentId()).toBe(2)
  })

  it('never loses or duplicates a song, because the order is a permutation', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().toggleShuffle()

    expect([...state().contextOrder].sort()).toEqual([0, 1, 2])
    expect(state().contextQueue).toHaveLength(3)
  })
})

describe('transport', () => {
  it('pauses and resumes without changing track', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().togglePlay()
    expect(state().isPlaying).toBe(false)

    state().togglePlay()
    expect(state().isPlaying).toBe(true)
    expect(currentId()).toBe(1)
  })

  it('ignores a toggle when nothing is loaded', () => {
    state().togglePlay()

    expect(state().current).toBeNull()
    expect(state().isPlaying).toBe(false)
  })

  it('records what the player actually did, without changing the track', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().setPlaying(false)

    expect(state().isPlaying).toBe(false)
    expect(currentId()).toBe(1)
  })

  it('clears everything on stop', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().addToQueue(song(50))
    state().stop()

    expect(state().current).toBeNull()
    expect(state().userQueue).toEqual([])
    expect(state().contextQueue).toEqual([])
  })
})

describe('upNext', () => {
  it('lists what is left of the context, in playback order', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    const { contextQueue, contextOrder, contextIndex } = state()

    expect(upNext(contextQueue, contextOrder, contextIndex).map((s) => s.id)).toEqual([2, 3])
  })

  it('is empty on the last track', () => {
    state().playFromContext(LIBRARY, 2, { kind: 'library' })
    const { contextQueue, contextOrder, contextIndex } = state()

    expect(upNext(contextQueue, contextOrder, contextIndex)).toEqual([])
  })
})

describe('what survives closing the app (#183)', () => {
  it('does not persist isPlaying or restartNonce', async () => {
    usePlayer.getState().playFromContext([song(1, 'One')], 0, { kind: 'library' })
    await usePlayer.persist.rehydrate()

    const raw = await AsyncStorage.getItem('mio-player')
    const persisted = JSON.parse(raw ?? '{}').state

    // Reopening shows the track, at the second you left it, paused. Persisting
    // `isPlaying` would start music because the app was opened; persisting
    // `restartNonce` would replay a "start over" the moment the store rehydrates.
    expect(persisted).not.toHaveProperty('isPlaying')
    expect(persisted).not.toHaveProperty('restartNonce')
    expect(persisted.current?.song?.id).toBe(1)
  })

  /**
   * The resume point moved to its own store (E3, #342).
   *
   * It is the one value written on a **timer** rather than on a user action —
   * every five seconds for as long as anything plays — and zustand's persist
   * middleware serialises the whole partialized state on each change. So each
   * of those writes was re-serialising `contextQueue`: measured at 260 KB for a
   * 500-song library, 496 KB for a thousand, twelve times a minute.
   *
   * This is the guard that keeps them apart. Putting it back in `usePlayer`
   * would restore a periodic cost that grows with the user's library.
   */
  it('keeps the resume point out of the player payload', async () => {
    usePlayer.getState().playFromContext([song(1, 'One')], 0, { kind: 'library' })
    useResume.getState().set(1, 88)
    await usePlayer.persist.rehydrate()
    await useResume.persist.rehydrate()

    const player = JSON.parse((await AsyncStorage.getItem('mio-player')) ?? '{}').state
    const resume = JSON.parse((await AsyncStorage.getItem('mio-resume')) ?? '{}').state

    expect(player).not.toHaveProperty('resume')
    expect(resume.point).toEqual({ songId: 1, seconds: 88 })
    // And the small one really is small — the whole point of the split.
    expect(JSON.stringify(resume).length).toBeLessThan(200)
  })

  it('forgets the resume point when playback is stopped', () => {
    usePlayer.getState().playFromContext([song(1, 'One')], 0, { kind: 'library' })
    useResume.getState().set(1, 88)

    usePlayer.getState().stop()

    // `stop` used to clear this through the `initialState` spread. A stale point
    // would seek the *next* thing played to wherever the last track stopped.
    expect(useResume.getState().point).toBeNull()
  })
})

describe('removing a deleted song from the queue (#200)', () => {
  it('drops it from the user queue', () => {
    usePlayer.getState().playFromContext([song(1, 'One')], 0, { kind: 'library' })
    usePlayer.getState().addToQueue(song(2, 'Two'))
    usePlayer.getState().addToQueue(song(3, 'Three'))

    usePlayer.getState().removeSongById(2)

    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([3])
  })

  it('keeps the playing track under the pointer when an earlier one goes', () => {
    // The subtle case. Removing an entry *before* the pointer has to shift the
    // pointer left, or playback jumps to a different song.
    const songs = [song(1, 'One'), song(2, 'Two'), song(3, 'Three')]
    usePlayer.getState().playFromContext(songs, 2, { kind: 'library' })
    expect(usePlayer.getState().current?.song.id).toBe(3)

    usePlayer.getState().removeSongById(1)

    expect(usePlayer.getState().current?.song.id).toBe(3)
    expect(
      upNext(
        usePlayer.getState().contextQueue,
        usePlayer.getState().contextOrder,
        usePlayer.getState().contextIndex,
      ),
    ).toEqual([])
  })

  it('moves on when the song being played is the one deleted', () => {
    const songs = [song(1, 'One'), song(2, 'Two')]
    usePlayer.getState().playFromContext(songs, 0, { kind: 'library' })

    usePlayer.getState().removeSongById(1)

    expect(usePlayer.getState().current?.song.id).toBe(2)
  })

  it('stops when the deleted song was the last thing to play', () => {
    usePlayer.getState().playFromContext([song(1, 'One')], 0, { kind: 'library' })

    usePlayer.getState().removeSongById(1)

    expect(usePlayer.getState().current).toBeNull()
    expect(usePlayer.getState().isPlaying).toBe(false)
  })

  it('does nothing at all for a song that was not queued', () => {
    // Returning the same state matters: this runs on every delete, and a fresh
    // object would re-render every subscriber for a song nobody was playing.
    usePlayer.getState().playFromContext([song(1, 'One')], 0, { kind: 'library' })
    const before = usePlayer.getState()

    usePlayer.getState().removeSongById(99)

    expect(usePlayer.getState()).toBe(before)
  })
})

/**
 * The playback settings (#234).
 *
 * All six landed together because T4's panels need most of them and T6 needs the
 * rest. The store only *records* the choice — `PlayerHost` applies it — which is
 * what keeps these tests free of a native module.
 */
describe('playback settings (#234)', () => {
  it('clamps volume to 0..1', () => {
    usePlayer.getState().setVolume(2)
    expect(usePlayer.getState().volume).toBe(1)

    usePlayer.getState().setVolume(-1)
    expect(usePlayer.getState().volume).toBe(0)
  })

  it('unmutes when the volume is set', () => {
    usePlayer.getState().toggleMute()
    expect(usePlayer.getState().muted).toBe(true)

    usePlayer.getState().setVolume(0.4)

    // Reaching for the volume means "let me hear this". Leaving it silent
    // because a mute flag is still set is a bug with no visible cause.
    expect(usePlayer.getState().muted).toBe(false)
    expect(usePlayer.getState().volume).toBe(0.4)
  })

  it('clamps the playback rate to what Android can actually do', () => {
    // Narrower than the web's 0.25..4 on purpose: Android's own
    // `setPlaybackRate` does `rate.coerceIn(0.1f, 2.0f)`, so storing 4 would
    // show a speed the audio never plays at.
    usePlayer.getState().setPlaybackRate(99)
    expect(usePlayer.getState().playbackRate).toBe(2)

    usePlayer.getState().setPlaybackRate(0)
    expect(usePlayer.getState().playbackRate).toBe(0.25)
  })

  it('clamps and rounds the crossfade, matching the web', () => {
    usePlayer.getState().setCrossfadeSeconds(3.6)
    expect(usePlayer.getState().crossfadeSeconds).toBe(4)

    usePlayer.getState().setCrossfadeSeconds(100)
    expect(usePlayer.getState().crossfadeSeconds).toBe(CROSSFADE_MAX_SECONDS)

    usePlayer.getState().setCrossfadeSeconds(-5)
    expect(usePlayer.getState().crossfadeSeconds).toBe(0)
  })

  it('keeps settings when the queue is cleared', () => {
    usePlayer.getState().setVolume(0.3)
    usePlayer.getState().setPlaybackRate(1.5)

    usePlayer.getState().stop()

    // Clearing the queue is not a reason to forget someone listens at 1.5x.
    expect(usePlayer.getState().volume).toBe(0.3)
    expect(usePlayer.getState().playbackRate).toBe(1.5)
    expect(usePlayer.getState().current).toBeNull()
  })
})

describe('the sleep timer (#234)', () => {
  it('sets an absolute time from minutes', () => {
    const before = Date.now()
    usePlayer.getState().setSleepTimer(20)

    const { sleepAt, sleepAfterTrack } = usePlayer.getState()
    expect(sleepAt).toBeGreaterThanOrEqual(before + 20 * 60_000)
    expect(sleepAfterTrack).toBe(false)
  })

  it('treats end-of-track and a wall-clock time as mutually exclusive', () => {
    usePlayer.getState().setSleepTimer(20)
    usePlayer.getState().setSleepTimer('endOfTrack')

    // Two answers to one question. Holding both would make whichever fired
    // first look arbitrary.
    expect(usePlayer.getState().sleepAt).toBeNull()
    expect(usePlayer.getState().sleepAfterTrack).toBe(true)

    usePlayer.getState().setSleepTimer(5)
    expect(usePlayer.getState().sleepAfterTrack).toBe(false)
    expect(usePlayer.getState().sleepAt).not.toBeNull()
  })

  it('cancels with null', () => {
    usePlayer.getState().setSleepTimer('endOfTrack')
    usePlayer.getState().setSleepTimer(null)

    expect(usePlayer.getState().sleepAt).toBeNull()
    expect(usePlayer.getState().sleepAfterTrack).toBe(false)
  })

  it('stops at the end of the track, and disarms itself', () => {
    usePlayer.getState().playFromContext([song(1), song(2)], 0, { kind: 'library' })
    usePlayer.getState().setSleepTimer('endOfTrack')

    usePlayer.getState().trackEnded()

    expect(usePlayer.getState().isPlaying).toBe(false)
    // One-shot. Leaving it armed would silently stop the next thing played.
    expect(usePlayer.getState().sleepAfterTrack).toBe(false)
    // And it did *not* advance.
    expect(usePlayer.getState().current?.song.id).toBe(1)
  })

  it('beats repeat-one, which would otherwise never let it fire', () => {
    usePlayer.getState().playFromContext([song(1)], 0, { kind: 'library' })
    usePlayer.getState().cycleRepeat()
    usePlayer.getState().cycleRepeat() // off -> all -> one
    expect(usePlayer.getState().repeat).toBe('one')
    usePlayer.getState().setSleepTimer('endOfTrack')

    usePlayer.getState().trackEnded()

    // The one combination a user could plausibly set and be baffled by: a song
    // repeating forever with a sleep timer that never gets a turn.
    expect(usePlayer.getState().isPlaying).toBe(false)
  })
})

describe('reordering the user queue (#234)', () => {
  // Something has to be playing first: `addToQueue` on an idle player starts
  // the song rather than queueing it, so the first add would never reach the
  // queue at all.
  const queueThree = () => {
    usePlayer.getState().playFromContext([song(9)], 0, { kind: 'library' })
    usePlayer.getState().addToQueue(song(1))
    usePlayer.getState().addToQueue(song(2))
    usePlayer.getState().addToQueue(song(3))
  }

  it('moves a song', () => {
    queueThree()
    usePlayer.getState().reorderUserQueue(0, 2)

    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([2, 3, 1])
  })

  it('leaves the queue alone when the drag ends out of range', () => {
    usePlayer.getState().playFromContext([song(9)], 0, { kind: 'library' })
    usePlayer.getState().addToQueue(song(1))
    usePlayer.getState().addToQueue(song(2))

    /*
     * Asserted after **each** call, not once at the end.
     *
     * Written the other way first, and it passed against a deliberately
     * unguarded `moved()` — both out-of-range calls happen to swap the pair, so
     * doing them back to back returned the list to its original order and the
     * test could not tell. Found by mutating the range check out; it survived.
     */
    usePlayer.getState().reorderUserQueue(0, 9)
    // A drag that ends off the list is an ordinary thing for a thumb to do.
    // Clamping would move the song *somewhere*, which is an edit nobody asked
    // for and worse than doing nothing.
    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([1, 2])

    usePlayer.getState().reorderUserQueue(-1, 0)
    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([1, 2])

    usePlayer.getState().reorderUserQueue(0, 2)
    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([1, 2])
  })
})

describe('seeking (#231)', () => {
  it('records a request the host can apply', () => {
    usePlayer.getState().seekTo(42)

    expect(usePlayer.getState().seekRequest).toMatchObject({ seconds: 42 })
  })

  it('never asks for a negative position', () => {
    // What a drag off the left edge of the scrubber produces.
    usePlayer.getState().seekTo(-10)

    expect(usePlayer.getState().seekRequest?.seconds).toBe(0)
  })

  it('carries a fresh nonce, so seeking to the same second twice still counts', () => {
    usePlayer.getState().seekTo(30)
    const first = usePlayer.getState().seekRequest?.nonce

    usePlayer.getState().seekTo(30)

    // Dragging back to where you already are is a real instruction; comparing
    // state alone could not tell it from no instruction at all.
    expect(usePlayer.getState().seekRequest?.nonce).toBe((first ?? 0) + 1)
  })

  it('is cleared once applied, so it cannot fire twice', () => {
    usePlayer.getState().seekTo(42)

    usePlayer.getState().clearSeekRequest()

    // A stale request would yank the track back on the next unrelated render.
    expect(usePlayer.getState().seekRequest).toBeNull()
  })

  it('does not survive the queue being cleared', () => {
    usePlayer.getState().seekTo(42)

    usePlayer.getState().stop()

    expect(usePlayer.getState().seekRequest).toBeNull()
  })
})

describe('the queue panel actions (#233)', () => {
  const play = () =>
    usePlayer.getState().playFromContext([song(1), song(2), song(3)], 0, { kind: 'library' })

  it('skips ahead in the context without consuming the user queue', () => {
    play()
    usePlayer.getState().addToQueue(song(9))

    // Offset 1 counts from the *next* context track, matching `upNext`.
    usePlayer.getState().skipToContext(1)

    expect(usePlayer.getState().current?.song.id).toBe(3)
    expect(usePlayer.getState().current?.source).toBe('context')
    // ADR-011's promise, and the reason this is not `playFromContext`.
    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([9])
  })

  it('leaves the context list itself alone', () => {
    play()

    usePlayer.getState().skipToContext(0)

    expect(usePlayer.getState().contextQueue).toHaveLength(3)
    expect(usePlayer.getState().contextIndex).toBe(1)
  })

  it('ignores an offset past the end', () => {
    play()

    usePlayer.getState().skipToContext(99)

    expect(usePlayer.getState().current?.song.id).toBe(1)
    // The pointer must not move either. Asserting only on `current` let a
    // version through that advanced `contextIndex` into nothing, which would
    // silently end the queue on the next track change.
    expect(usePlayer.getState().contextIndex).toBe(0)
  })

  it('removes several hand-queued songs at once', () => {
    play()
    usePlayer.getState().addToQueue(song(7))
    usePlayer.getState().addToQueue(song(8))
    usePlayer.getState().addToQueue(song(9))

    usePlayer.getState().removeManyFromUserQueue([0, 2])

    // Both go, and the surviving one is the one between them — removing by
    // index one at a time would have shifted the second index onto the wrong
    // song.
    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([8])
  })

  it('promotes several to the front without reshuffling them', () => {
    play()
    usePlayer.getState().addToQueue(song(7))
    usePlayer.getState().addToQueue(song(8))
    usePlayer.getState().addToQueue(song(9))

    usePlayer.getState().promoteInUserQueue([1, 2])

    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([8, 9, 7])
  })

  it('does nothing when nothing is selected', () => {
    play()
    usePlayer.getState().addToQueue(song(7))

    usePlayer.getState().promoteInUserQueue([])
    usePlayer.getState().removeManyFromUserQueue([])

    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([7])
  })
})

describe('peeking at the next track (#201)', () => {
  /**
   * Crossfade loads the next track while the current one is still playing, so
   * it has to ask what `trackEnded` *would* do. Every test here is really the
   * same claim: the peek and the advance agree. Where that is checkable
   * directly — same queue, peek then end — it is checked directly, because two
   * copies of "user queue first, then context, then wrap" would drift and the
   * symptom would be a track that fades in and is then replaced.
   */
  it('agrees with what actually plays next, for the user queue and the context', () => {
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().addToQueue(song(9, 'Hand-queued'))

    // The user queue wins, and the peek says so before the advance proves it.
    const peeked = peekNextSong(state())
    state().trackEnded()
    expect(peeked?.id).toBe(9)
    expect(currentId()).toBe(9)

    // …and then the context resumes where it left off, still in agreement.
    const peekedAgain = peekNextSong(state())
    state().trackEnded()
    expect(peekedAgain?.id).toBe(2)
    expect(currentId()).toBe(2)
  })

  it('wraps under repeat-all, exactly as ending does', () => {
    state().playFromContext(LIBRARY, 2, { kind: 'library' })
    usePlayer.setState({ repeat: 'all' })

    const peeked = peekNextSong(state())
    state().trackEnded()
    expect(peeked?.id).toBe(1)
    expect(currentId()).toBe(1)
  })

  it('is null at the end of the queue, so the last track does not fade to silence', () => {
    state().playFromContext(LIBRARY, 2, { kind: 'library' })

    expect(peekNextSong(state())).toBeNull()
  })

  it('is null under repeat-one, which is not a crossfade', () => {
    // The next track is this one. Crossfading a track into itself needs the
    // same file open twice at different positions, and it is not what anyone
    // means by repeat-one.
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    usePlayer.setState({ repeat: 'one' })

    expect(peekNextSong(state())).toBeNull()
  })

  it('is null when the sleep timer will stop after this track', () => {
    // The next thing is silence, and #241 already fades that. Fading *into* a
    // track the timer is about to stop would be two fades fighting.
    state().playFromContext(LIBRARY, 0, { kind: 'library' })
    state().setSleepTimer('endOfTrack')

    expect(peekNextSong(state())).toBeNull()
  })

  it('is null with nothing playing', () => {
    expect(peekNextSong(state())).toBeNull()
  })
})

/**
 * Reordering what is coming up in the context list (#315).
 *
 * The user queue could be dragged and this could not, which is an inconsistency
 * you can only find by trying to drag one.
 */
describe('reordering the context queue', () => {
  const songs = [song(1), song(2), song(3), song(4)]

  beforeEach(() => {
    usePlayer.getState().playFromContext(songs, 0, { kind: 'library' })
  })

  it('moves a track within what is coming', () => {
    // Playing #1, so up next is 2, 3, 4 — and index 0 here means #2.
    usePlayer.getState().reorderContextQueue(0, 2)

    expect(upNextIds()).toEqual([3, 4, 2])
  })

  it('leaves the track that is playing exactly where it is', () => {
    usePlayer.getState().reorderContextQueue(0, 2)

    // Dragging what is coming must not rewrite what is playing, or the queue
    // screen would move the music under the user.
    expect(usePlayer.getState().current?.song.id).toBe(1)
  })

  it('leaves what has already played alone', () => {
    usePlayer.getState().next()
    usePlayer.getState().next()
    // Playing #3 now, so the history is 1, 2 and only 4 is coming.
    usePlayer.getState().reorderContextQueue(0, 0)

    expect(usePlayer.getState().contextOrder.slice(0, 3)).toEqual([0, 1, 2])
  })

  it('ignores a move that goes nowhere or off the end', () => {
    const before = [...usePlayer.getState().contextOrder]

    usePlayer.getState().reorderContextQueue(1, 1)
    usePlayer.getState().reorderContextQueue(0, 99)
    usePlayer.getState().reorderContextQueue(-1, 0)

    expect(usePlayer.getState().contextOrder).toEqual(before)
  })

  it('reorders the order, not the list, so unshuffling still works', () => {
    usePlayer.getState().reorderContextQueue(0, 2)

    // `contextOrder` is a permutation of indices into `contextQueue`; the list
    // itself must never be rewritten, or shuffle could not be undone.
    expect(usePlayer.getState().contextQueue.map((s) => s.id)).toEqual([1, 2, 3, 4])
  })
})

describe('removing from the context queue (#572)', () => {
  const songs = [song(1), song(2), song(3), song(4)]

  beforeEach(() => {
    usePlayer.getState().playFromContext(songs, 0, { kind: 'library' })
  })

  it('drops the chosen upcoming track', () => {
    // Playing #1, so up next is 2, 3, 4 — index 0 here means #2.
    usePlayer.getState().removeFromContextQueue(1)

    expect(upNextIds()).toEqual([2, 4])
  })

  it('leaves the track that is playing alone', () => {
    usePlayer.getState().removeFromContextQueue(0)

    expect(usePlayer.getState().current?.song.id).toBe(1)
  })

  it('leaves what has already played alone', () => {
    usePlayer.getState().next()
    usePlayer.getState().next()
    // Playing #3, history is 1 and 2, only #4 is coming.
    usePlayer.getState().removeFromContextQueue(0)

    expect(usePlayer.getState().contextOrder.slice(0, 3)).toEqual([0, 1, 2])
    expect(usePlayer.getState().current?.song.id).toBe(3)
  })

  it('⚠️ does not remove the song from the list itself', () => {
    /*
     * 2026-08-17: *"we remove track from the queue, not remove from the
     * playlist or library."*
     *
     * `contextOrder` is a permutation of indices into `contextQueue`; editing
     * the order says "this position no longer plays" and editing the list would
     * say "this song is gone", which is a different and much larger claim. It
     * is also what keeps shuffle undoable.
     */
    usePlayer.getState().removeFromContextQueue(1)

    expect(usePlayer.getState().contextQueue.map((s) => s.id)).toEqual([1, 2, 3, 4])
  })

  it('does not bring it back when repeat-all wraps', () => {
    /*
     * The behaviour to *want*, and worth pinning because the opposite is just
     * as implementable: a track that was removed was removed, not skipped once.
     * `restartContext` reads `contextOrder[0]` through `contextSongAt`, so the
     * dropped entry is gone for good — but only as long as nothing rebuilds the
     * order from `contextQueue` on the wrap.
     */
    usePlayer.setState({ repeat: 'all' })
    usePlayer.getState().removeFromContextQueue(1)

    usePlayer.getState().next()
    usePlayer.getState().next()
    usePlayer.getState().next()

    // 1 → 2 → 4 → back to 1. Never 3.
    expect(usePlayer.getState().current?.song.id).toBe(1)
    expect(upNextIds()).toEqual([2, 4])
  })

  it('removes one of a duplicated song, not both', () => {
    // A playlist can hold the same song twice, which is two entries in
    // `contextOrder` pointing at one entry in `contextQueue`.
    usePlayer.getState().playFromContext([song(1), song(2), song(2), song(3)], 0, {
      kind: 'library',
    })

    usePlayer.getState().removeFromContextQueue(0)

    expect(upNextIds()).toEqual([2, 3])
  })

  it('ignores an offset that is off either end', () => {
    // The panel and the store are separate renders, so a fast double tap can
    // ask twice for a row that has already gone.
    const before = [...usePlayer.getState().contextOrder]

    usePlayer.getState().removeFromContextQueue(99)
    usePlayer.getState().removeFromContextQueue(-1)

    expect(usePlayer.getState().contextOrder).toEqual(before)
  })

  it('leaves the hand-queued songs alone', () => {
    // The two lists are separate on purpose (ADR-011). Removing from one must
    // not reach into the other.
    usePlayer.getState().addToQueue(song(9))

    usePlayer.getState().removeFromContextQueue(0)

    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([9])
  })
})

function upNextIds(): number[] {
  const state = usePlayer.getState()
  return upNext(state.contextQueue, state.contextOrder, state.contextIndex).map(
    (song) => song.id as number,
  )
}
