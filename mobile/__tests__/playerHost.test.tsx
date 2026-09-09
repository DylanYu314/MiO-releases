import { act, render, screen, waitFor } from '@testing-library/react-native'
import { AppState } from 'react-native'

import { useConnection } from '../src/api/connection'
import type { Song } from '../src/api/types'
import { useAudioSettings } from '../src/player/audioSettings'
import { PlayerHost } from '../src/player/PlayerHost'
import { usePlaybackStatus, resetPlaybackStatus } from '../src/player/playbackStatus'
import { usePlayer } from '../src/player/store'
import { useResume } from '../src/player/resume'
import '../src/i18n'

/**
 * These tests prove the *wiring*: that `setActiveForLockScreen` is called, with
 * the right metadata, and that the audio session asks for background playback.
 *
 * They cannot prove the thing that actually matters — that Android honours it
 * and keeps playing once the screen is off. No mock can. That check is a real
 * phone, a locked screen and five minutes of waiting; see
 * `docs/mobile-testing.md`.
 */

const INITIAL_STATUS = {
  isLoaded: true,
  isBuffering: false,
  playing: false,
  currentTime: 0,
  duration: 180,
  didJustFinish: false,
  error: null,
}

// Everything the mock needs is built *inside* the factory: `jest.mock` is
// hoisted above every declaration in this file, so referencing an outer binding
// here is a temporal-dead-zone error rather than a working mock. That is why
// the initial status is spelled out twice — `INITIAL_STATUS` is out of reach.
// The device library, mocked: without this the real one reaches expo-sqlite,
// which is native and absent under jest — and every lookup would fail into the
// streaming fallback, hiding whether the local path works at all.
const mockLocalSong = jest.fn()
jest.mock('../src/library/songs', () => ({
  getLocalSongByServerId: (...args: unknown[]) => mockLocalSong(...args),
}))

/**
 * The equaliser's native side, refusing exactly the way the real one does.
 *
 * `MioEqualizerModule.kt` answers `no_session_yet` when the player's
 * `audioSessionId` is still 0 — the value ExoPlayer reports until its renderer
 * is initialised — because session 0 is the global output mix. That refusal is
 * the whole of #303, so the mock models it rather than always succeeding: a
 * mock that cannot refuse cannot show the bug.
 *
 * `mock`-prefixed so the hoisted factory may reference them (a convention in this repo).
 */
let mockSessionReady = false
/**
 * Answers the reason codes the Kotlin answers, not a boolean (#303).
 *
 * It returned `mockSessionReady` directly until the third attempt at this bug,
 * which made the mock model a binary that no longer exists — and the
 * transient/permanent split is invisible to a boolean, so a test using one
 * cannot see the difference between "the renderer is not up yet" and "this can
 * never work". The legacy boolean contract still has to be handled, and is
 * covered in `equalizerReason.test.ts` where it belongs.
 */
const mockSetGains = jest.fn((...args: [player: unknown, gains: number[]]): string => {
  void args
  return mockSessionReady ? 'ok' : 'no_session_yet'
})
/** Stable across calls, unlike the module object around it, so a test can
 *  assert this is *never* reached — see the unmount test. */
const mockRelease = jest.fn()
/**
 * **Answers by name**, which it did not, and that was a real trap (#397).
 *
 * This ignored its argument and handed the equaliser's shape to *every*
 * `requireOptionalNativeModule` call. The moment a second optional module
 * existed — `mio-media-session` — the host saw `isSupported: true` for it and
 * took the owned-session path in a file whose whole subject is the expo-audio
 * one, so five tests failed with no product bug behind them.
 *
 * Exactly the failure `docs/lessons.md` records: a test environment supplying an
 * API the runtime does not have. This file is about the **fallback** path, so
 * every module but the equaliser is absent here, as it is in a binary built
 * before #397. `playerHostMediaSession.test.tsx` is the other side.
 */
jest.mock('expo', () => ({
  requireOptionalNativeModule: (name: string) =>
    name === 'MioEqualizer'
      ? {
          isSupported: true,
          bandCount: 10,
          bandFrequencies: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
          maxGainDb: 12,
          setGains: (...args: [unknown, number[]]) => mockSetGains(...args),
          release: (...args: unknown[]) => mockRelease(...args),
        }
      : null,
}))

jest.mock('expo-audio', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')

  /**
   * **One fake player per `useAudioPlayer()` call, not one shared object.**
   *
   * It used to return a single module-level player however many times it was
   * called, which was fine while there was one deck and actively wrong once
   * #201 added a second: two decks sharing one fake cannot show a crossfade at
   * all — every assertion about "the outgoing deck" would be reading the
   * incoming one. A mock that cannot represent the bug cannot catch it.
   *
   * Memoized per hook instance with a ref, because the real `useAudioPlayer`
   * returns the same native object across renders and a fresh one each render
   * would make `replace()` counts meaningless.
   */
  /** Status is **per player**: the host reads the active deck's, and a shared
   *  one would let a fade on deck B move deck A's clock.
   *
   *  Declared above `makePlayer` because the player's `currentTime` and
   *  `playing` getters read it — they model the real object, where those track
   *  playback rather than sitting at a constant. */
  const statuses = new Map<object, Record<string, unknown>>()

  const makePlayer = () => {
    let appliedRate = 1
    return {
      play: jest.fn(),
      pause: jest.fn(),
      replace: jest.fn(),
      setActiveForLockScreen: jest.fn(),
      updateLockScreenMetadata: jest.fn(),
      clearLockScreenControls: jest.fn(),
      seekTo: jest.fn(async () => {}),
      // A plain property, like the real one: `volume` is a setter on the native
      // object, not a method, so P8's gain shows up as an assignment.
      volume: 1,
      /**
       * **Getter-only, exactly like the native object.**
       *
       * This was writable once, and that is why the suite passed while the app
       * crashed on launch: `player.playbackRate = rate` throws on a device.
       * `expo-audio`'s types actively mislead here — the Android source has a
       * getter-only `Property` plus a `setPlaybackRate` function, and the mock
       * models the source.
       */
      setPlaybackRate: jest.fn((rate: number) => {
        appliedRate = rate
      }),
      get playbackRate() {
        return appliedRate
      },
      /**
       * `currentTime` and `playing` are on the real `AudioPlayer` and were
       * missing here, which #396's diagnostic found the hard way: it read
       * `currentTime` two lines after `play()` and threw, taking 56 tests with
       * it. On a device that would have been playback stopping between songs.
       *
       * Backed by the same per-player status the host subscribes to, so a test
       * that emits a tick moves them — a constant would model a player whose
       * clock never runs, which is one of the states the diagnostic exists to
       * tell apart.
       */
      get currentTime() {
        return (statuses.get(this as object)?.currentTime as number) ?? 0
      },
      get playing() {
        return (statuses.get(this as object)?.playing as boolean) ?? false
      },
    }
  }

  const players: ReturnType<typeof makePlayer>[] = []

  const listeners = new Map<object, Set<Function>>()

  const blankStatus = () => ({
    isLoaded: true,
    isBuffering: false,
    playing: false,
    currentTime: 0,
    duration: 180,
    didJustFinish: false,
    error: null,
  })

  const emitFor = (player: object, next: Record<string, unknown>) => {
    const merged = { ...(statuses.get(player) ?? blankStatus()), ...next }
    statuses.set(player, merged)
    listeners.get(player)?.forEach((listener) => listener(merged))
  }

  return {
    useAudioPlayer: () => {
      const ref = React.useRef(null)
      if (!ref.current) {
        ref.current = makePlayer()
        players.push(ref.current)
        statuses.set(ref.current, blankStatus())
      }
      return ref.current
    },
    useAudioPlayerStatus: (player: object) => {
      const [local, setLocal] = React.useState(() => statuses.get(player) ?? blankStatus())
      React.useEffect(() => {
        const set = listeners.get(player) ?? new Set()
        set.add(setLocal)
        listeners.set(player, set)
        setLocal(statuses.get(player) ?? blankStatus())
        return () => {
          set.delete(setLocal)
        }
      }, [player])
      return local
    },
    setAudioModeAsync: jest.fn(async () => {}),
    /** The first deck — what every pre-#201 test means by "the player". */
    get __player() {
      return players[0]
    },
    /** Both decks, in creation order, for the crossfade tests. */
    __decks: players,
    /** Emit on deck 0 by default, so existing tests read unchanged. */
    __emit: (next: Record<string, unknown>) => emitFor(players[0], next),
    __emitOn: (index: number, next: Record<string, unknown>) => emitFor(players[index], next),
    __reset: (next: Record<string, unknown>) => {
      players.length = 0
      statuses.clear()
      listeners.clear()
      void next
    },
  }
})

type FakeDeck = Record<string, jest.Mock> & { volume: number; readonly playbackRate: number }

const audio = jest.requireMock('expo-audio') as {
  __player: FakeDeck
  __decks: FakeDeck[]
  __emit: (next: Record<string, unknown>) => void
  __emitOn: (index: number, next: Record<string, unknown>) => void
  __reset: (next: typeof INITIAL_STATUS) => void
  setAudioModeAsync: jest.Mock
}

const SONG: Song = {
  id: 7,
  title: 'Background Test',
  artist: 'The Testers',
  album: 'Locked Screen',
  duration: 180,
  source_url: 'https://example.com/7',
  source_platform: 'youtube',
  added_at: '2026-07-25T00:00:00Z',
  loudness_lufs: null,
  peak_dbfs: null,
}

beforeEach(() => {
  jest.clearAllMocks()
  // A module-level store outlives the test that wrote to it, so a leftover
  // position would leak into the next assertion.
  resetPlaybackStatus()
  usePlayer.setState({
    context: null,
    contextQueue: [],
    contextOrder: [],
    contextIndex: -1,
    userQueue: [],
    current: null,
    isPlaying: false,
    shuffle: false,
    repeat: 'off',
    restartNonce: 0,
    // `previous` walks history rather than doing index arithmetic, so a test
    // that advanced through tracks leaves entries that make the *next* test's
    // `previous()` go back instead of restarting. Every other field here was
    // reset; this one was missed, and #444's tests are what found it.
    history: [],
  })
  // Its own store since E3 — see `src/player/resume.ts`.
  useResume.setState({ point: null })
  useConnection.setState({
    serverUrl: 'http://192.168.1.143:8000',
    accessKey: null,
    loaded: true,
  })
  audio.__reset({ ...INITIAL_STATUS })
  // No volume or rate reset any more: since the mock builds a *fresh* player
  // per mount (#201 needs two decks, so one shared object would not do), each
  // test starts with a new one at its defaults. Reaching for `__player` here
  // would also be reaching before any deck exists.
  useAudioSettings.setState({ normalizeLoudness: true })
})

/** Render, then let the audio-mode promise settle before asserting. */
async function mount() {
  const view = await render(<PlayerHost />)
  await act(async () => {})
  return view
}

describe('PlayerHost', () => {
  it('shows nothing and claims no media session until something plays', async () => {
    await mount()

    expect(screen.queryByText('Background Test')).toBeNull()
    expect(audio.__player.setActiveForLockScreen).not.toHaveBeenCalled()
  })

  it('asks for background playback and exclusive audio focus', async () => {
    await mount()

    expect(audio.setAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        shouldPlayInBackground: true,
        // Required for lock screen controls to bind to this player, and what
        // makes the OS pause us for a phone call.
        interruptionMode: 'doNotMix',
      }),
    )
  })

  it('claims the lock screen when a track starts', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })

    await waitFor(() => expect(audio.__player.setActiveForLockScreen).toHaveBeenCalled())

    const [active, metadata, options] = audio.__player.setActiveForLockScreen.mock.calls[0]
    expect(active).toBe(true)
    expect(metadata).toMatchObject({
      title: 'Background Test',
      artist: 'The Testers',
      albumTitle: 'Locked Screen',
    })
    expect(options).toMatchObject({ showSeekForward: true, showSeekBackward: true })
  })

  it('streams from the song audio endpoint', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })

    await waitFor(() => expect(audio.__player.replace).toHaveBeenCalled())
    expect(audio.__player.replace).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'http://192.168.1.143:8000/songs/7/audio' }),
    )
    expect(audio.__player.play).toHaveBeenCalled()
  })

  it('does not reload the track when a refetch hands back an equal song object', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })
    await waitFor(() => expect(audio.__player.replace).toHaveBeenCalledTimes(1))

    // Same id, new object — exactly what TanStack Query produces on a refetch.
    await act(async () => {
      usePlayer.setState({ current: { source: 'context', song: { ...SONG } } })
    })

    expect(audio.__player.replace).toHaveBeenCalledTimes(1)
  })

  it('releases the media session when playback is stopped', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })
    await waitFor(() => expect(audio.__player.replace).toHaveBeenCalled())

    await act(async () => {
      usePlayer.getState().stop()
    })

    expect(audio.__player.clearLockScreenControls).toHaveBeenCalled()
    expect(screen.queryByText('Background Test')).toBeNull()
  })

  it('does not cancel the tap while the player is still starting up', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })

    // The native player has not caught up yet: it still reports playing: false
    // a tick or two after `play()`. That must not read as "the user paused".
    await act(async () => {
      audio.__emit({ playing: false })
    })

    expect(usePlayer.getState().isPlaying).toBe(true)
  })

  it('reflects an OS-driven pause, such as an incoming call', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })
    // The player confirms it is playing...
    await act(async () => {
      audio.__emit({ playing: true })
    })
    expect(usePlayer.getState().isPlaying).toBe(true)

    // ...then the OS takes audio focus away and stops it without us asking.
    await act(async () => {
      audio.__emit({ playing: false })
    })

    await waitFor(() => expect(usePlayer.getState().isPlaying).toBe(false))
  })

  it('does not treat a buffering stall as a pause', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })
    await act(async () => {
      audio.__emit({ playing: true })
    })

    await act(async () => {
      audio.__emit({ playing: false, isBuffering: true })
    })

    expect(usePlayer.getState().isPlaying).toBe(true)
  })

  /**
   * This used to assert the title and the pause button were on screen, because
   * `PlayerHost` rendered the mini player itself. #226 took its output away —
   * the bar has to be positioned by the tab navigator, and the audio has to sit
   * outside it — so what is left to prove here is the seam: the host publishes
   * what it can see. `miniPlayer.test.tsx` proves the other end draws it.
   */
  it('publishes what is playing, so the bar has something to draw', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })

    await waitFor(() => expect(usePlaybackStatus.getState().duration).toBe(180))
    await act(async () => {
      audio.__emit({ currentTime: 42, isBuffering: false })
    })
    expect(usePlaybackStatus.getState().position).toBe(42)
    expect(usePlaybackStatus.getState().isBuffering).toBe(false)
  })

  it('forgets the last track when playback stops entirely', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })
    await act(async () => {
      audio.__emit({ currentTime: 42 })
    })
    expect(usePlaybackStatus.getState().position).toBe(42)

    // Otherwise the bar's next appearance starts 42 seconds into a track that
    // has not begun.
    await act(async () => {
      usePlayer.getState().stop()
    })
    await waitFor(() => expect(usePlaybackStatus.getState().position).toBe(0))
  })

  it('advances to the next track when one plays out', async () => {
    const second = { ...SONG, id: 8, title: 'Second Track' }
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG, second], 0, { kind: 'library' })
    })

    await act(async () => {
      audio.__emit({ didJustFinish: true })
    })

    await waitFor(() => expect(usePlayer.getState().current?.song.id).toBe(8))
  })

  it('handles one ending once, however many status ticks report it', async () => {
    const songs = [SONG, { ...SONG, id: 8 }, { ...SONG, id: 9 }]
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext(songs, 0, { kind: 'library' })
    })

    // `didJustFinish` stays true across ticks. Acting on each one would skip
    // several tracks every time a song ended.
    await act(async () => {
      audio.__emit({ didJustFinish: true })
    })
    await act(async () => {
      audio.__emit({ didJustFinish: true, currentTime: 1 })
    })

    expect(usePlayer.getState().current?.song.id).toBe(8)
  })

  /**
   * One ending must not advance twice (#444).
   *
   * The latch compared `finishedGeneration` with `generation`, and `generation`
   * is bumped by the load this ending causes — so a second `didJustFinish`
   * arriving *after* the next track loaded saw a generation it had not handled
   * and advanced again. I watched the skipped track's artwork appear on the
   * lock screen and then vanish: `1 -> 2 (jumped) -> 3 (played) -> 4 (jumped)`.
   *
   * The flag has to go **false and true again** for this to bite, which is what
   * the existing "however many status ticks" test does not do — it re-emits
   * `true`, and React skips an effect whose dependency has not changed.
   */
  it('does not advance twice when the finish flag flaps after the next track loads', async () => {
    const songs = [SONG, { ...SONG, id: 8 }, { ...SONG, id: 9 }]
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext(songs, 0, { kind: 'library' })
    })

    // Track 1 plays out.
    await act(async () => {
      audio.__emit({ didJustFinish: true })
    })
    expect(usePlayer.getState().current?.song.id).toBe(8)

    // The next track has loaded by now. A trailing finish from the source that
    // was just replaced arrives — false, then true again.
    await act(async () => {
      audio.__emit({ didJustFinish: false, currentTime: 0 })
    })
    await act(async () => {
      audio.__emit({ didJustFinish: true, currentTime: 0 })
    })

    // Still on track 2. It was skipped before a note of it played.
    expect(usePlayer.getState().current?.song.id).toBe(8)
  })

  it('still advances when a track genuinely ends after playing', async () => {
    const songs = [SONG, { ...SONG, id: 8 }, { ...SONG, id: 9 }]
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext(songs, 0, { kind: 'library' })
    })

    await act(async () => {
      audio.__emit({ didJustFinish: true })
    })

    /*
     * Three minutes pass, because that is what a track is.
     *
     * The echo guard measures *time since the last ending*, so a test that ends
     * two tracks in the same millisecond is not modelling a queue — it is
     * modelling the bug. `Date.now` is spied rather than the timers faked,
     * because this file runs on real ones and the component only reads the
     * clock.
     */
    const realNow = Date.now
    const clock = jest.spyOn(Date, 'now').mockReturnValue(realNow() + 180_000)

    // Track 2 plays, then ends. The guard must not swallow this one — that
    // would be a queue that stops after one song, which is worse than the bug.
    await act(async () => {
      audio.__emit({ didJustFinish: false, currentTime: 5 })
    })
    await act(async () => {
      audio.__emit({ didJustFinish: true, currentTime: 180 })
    })

    expect(usePlayer.getState().current?.song.id).toBe(9)
    clock.mockRestore()
  })

  /**
   * A track with no audio must be skipped, not sat on (#446).
   *
   * *"the not downloaded track is added to the queue, and when queue
   * playing, that failed download track wont get skipped"*. The load effect
   * returned when there was no source, which leaves the deck holding the
   * previous track and the queue pointing at a song that can never start —
   * silence, with the app insisting it is playing.
   *
   * A row with no audio is an ordinary state since #159: a playlist import
   * records every accepted track, and a failed one leaves a row behind.
   */
  describe('a queue containing tracks that were never downloaded', () => {
    /**
     * Known about, not here — the row a failed import leaves behind.
     *
     * A **string** id, because that is what makes it a device track: a numeric
     * id is the server's, and the server can stream it. That distinction is the
     * whole of the check being tested.
     */
    const missing = (id: string) => ({ ...SONG, id, file_uri: null, server_song_id: null })

    it('skips past one that cannot be played', async () => {
      await mount()
      await act(async () => {
        usePlayer.getState().playFromContext([missing('local-21'), SONG], 0, { kind: 'library' })
      })

      await waitFor(() => expect(usePlayer.getState().current?.song.id).toBe(SONG.id))
    })

    it('gives up rather than spinning when nothing in the queue is playable', async () => {
      await mount()
      const nothingPlayable = Array.from({ length: 4 }, (_, i) => missing(`local-${30 + i}`))
      await act(async () => {
        usePlayer.getState().playFromContext(nothingPlayable, 0, { kind: 'library' })
      })

      // `next()` at the end of a list can hand back the song it was already on,
      // so without a bound this walks itself forever.
      await waitFor(() => expect(usePlayer.getState().isPlaying).toBe(false))
    })

    it('plays a device track that does have its file', async () => {
      await mount()
      // The ordinary case for everything imported since #159: a string id, and
      // the file carried on the song itself. Treating these as unplayable would
      // skip the entire library.
      await act(async () => {
        usePlayer
          .getState()
          .playFromContext(
            [{ ...SONG, id: 'local-9', file_uri: 'file:///music/local-9.opus' }],
            0,
            {
              kind: 'library',
            },
          )
      })

      await waitFor(() =>
        expect(audio.__player.replace).toHaveBeenCalledWith(
          expect.objectContaining({ uri: 'file:///music/local-9.opus' }),
        ),
      )
      expect(usePlayer.getState().current?.song.id).toBe('local-9')
    })

    it('still plays a track that is only on the server', async () => {
      await mount()
      // `server_song_id` with no local file is streamable, not missing — the
      // difference `isPlayable` exists for. Skipping these would be a worse bug
      // than the one being fixed.
      await act(async () => {
        usePlayer
          .getState()
          .playFromContext([{ ...SONG, file_uri: null, server_song_id: 7 }], 0, { kind: 'library' })
      })

      await waitFor(() => expect(audio.__player.replace).toHaveBeenCalled())
      expect(usePlayer.getState().isPlaying).toBe(true)
    })
  })

  it('replays the current track when the store bumps the restart nonce', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })
    audio.__player.play.mockClear()

    // Repeat-one and "previous" on the first track both mean this.
    await act(async () => {
      usePlayer.getState().previous()
    })

    await waitFor(() => expect(audio.__player.seekTo).toHaveBeenCalledWith(0))
    expect(audio.__player.play).toHaveBeenCalled()
    expect(usePlayer.getState().current?.song.id).toBe(7)
  })

  /**
   * The host skips reloading a track whose id has not changed, because a
   * refetch hands back an equal `Song` and reloading on that would restart
   * playback under the user (see the test above). That guard makes reselecting
   * the *same* song invisible: without an explicit restart the player sits
   * finished at the end of the file while the store insists it is playing.
   *
   * These three cover the ordinary ways a queue reselects what is already
   * loaded. Each asserts a *command reached the player* — the store being
   * right is not the same as a sound coming out, and only the host can tell
   * the difference.
   */
  describe('reselecting the track that is already loaded', () => {
    it('plays a one-song context again on repeat-all', async () => {
      await mount()
      await act(async () => {
        usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
        usePlayer.setState({ repeat: 'all' })
      })
      await waitFor(() => expect(audio.__player.play).toHaveBeenCalled())
      audio.__player.play.mockClear()
      audio.__player.seekTo.mockClear()

      await act(async () => {
        audio.__emit({ didJustFinish: true })
      })

      await waitFor(() => expect(audio.__player.seekTo).toHaveBeenCalledWith(0))
      expect(audio.__player.play).toHaveBeenCalled()
      expect(usePlayer.getState().contextIndex).toBe(0)
    })

    it('plays the current song again when it was also queued by hand', async () => {
      await mount()
      await act(async () => {
        usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
      })
      await waitFor(() => expect(audio.__player.play).toHaveBeenCalled())
      await act(async () => {
        usePlayer.getState().addToQueue(SONG)
      })
      audio.__player.play.mockClear()
      audio.__player.seekTo.mockClear()

      await act(async () => {
        audio.__emit({ didJustFinish: true })
      })

      await waitFor(() => expect(audio.__player.seekTo).toHaveBeenCalledWith(0))
      expect(audio.__player.play).toHaveBeenCalled()
      expect(usePlayer.getState().current).toMatchObject({ source: 'user' })
    })

    it('advances audibly through a list holding the same song twice over', async () => {
      // Not contrived: an imported playlist can hold the same track twice, and
      // two playlists overlapping means one `Song` row under both entries.
      const songs = [SONG, { ...SONG }, { ...SONG, id: 9, title: 'Other' }]
      await mount()
      await act(async () => {
        usePlayer.getState().playFromContext(songs, 0, { kind: 'library' })
      })
      await waitFor(() => expect(audio.__player.play).toHaveBeenCalled())
      audio.__player.play.mockClear()
      audio.__player.seekTo.mockClear()

      await act(async () => {
        audio.__emit({ didJustFinish: true })
      })

      await waitFor(() => expect(audio.__player.seekTo).toHaveBeenCalledWith(0))
      expect(audio.__player.play).toHaveBeenCalled()
      expect(usePlayer.getState().contextIndex).toBe(1)

      // Stops at the duplicate rather than running past it (#184). `didJustFinish`
      // stays true across status ticks, so an ending handled once must not be
      // handled again just because the restart bumped the generation counter —
      // that would skip the second copy instantly, which is the symptom reported.
      await act(async () => {
        audio.__emit({ currentTime: 1 })
        audio.__emit({ currentTime: 2 })
      })
      expect(usePlayer.getState().contextIndex).toBe(1)
    })
  })

  describe('coming back where playback stopped (#183)', () => {
    it('does not start playing just because the app was reopened', async () => {
      // A restored session: a track is current, but nobody pressed play.
      usePlayer.setState({
        current: { source: 'context', song: SONG },
        contextQueue: [SONG],
        contextOrder: [0],
        contextIndex: 0,
        isPlaying: false,
      })

      await mount()

      await waitFor(() => expect(audio.__player.replace).toHaveBeenCalled())
      // The track is loaded and ready, and silent. Auto-playing on launch is
      // exactly what was asked against.
      expect(audio.__player.play).not.toHaveBeenCalled()
    })

    it('seeks a restored track back to the stored second', async () => {
      usePlayer.setState({
        current: { source: 'context', song: SONG },
        contextQueue: [SONG],
        contextOrder: [0],
        contextIndex: 0,
        isPlaying: false,
      })
      useResume.setState({ point: { songId: SONG.id, seconds: 96 } })

      await mount()

      await waitFor(() => expect(audio.__player.seekTo).toHaveBeenCalledWith(96))
    })

    /**
     * The race the split introduced (E3, #342).
     *
     * `resume` lives in its own persisted store now, so it rehydrates
     * independently of `usePlayer` — at launch the queue can be restored while
     * the position is still `null`. The seek effect spends **one attempt per
     * track**, so reading during that window would burn it and lose the
     * position silently: a feature that works except when it does not, which is
     * the worst kind.
     *
     * Nothing else in the suite would catch it. Hydration is a microtask and
     * loading audio is not, so on a laptop the store always wins.
     */
    it('still seeks when the stored position arrives after the track loads', async () => {
      // Hydration has not finished: the store answers null, exactly as it does
      // in the window this guards.
      useResume.setState({ point: null })
      useResume.persist.clearStorage()
      const listeners: (() => void)[] = []
      const onFinish = jest
        .spyOn(useResume.persist, 'onFinishHydration')
        .mockImplementation((fn) => {
          listeners.push(() => fn(useResume.getState()))
          return () => undefined
        })
      jest.spyOn(useResume.persist, 'hasHydrated').mockReturnValue(false)

      usePlayer.setState({
        current: { source: 'context', song: SONG },
        contextQueue: [SONG],
        contextOrder: [0],
        contextIndex: 0,
        isPlaying: false,
      })

      await mount()
      await waitFor(() => expect(audio.__player.replace).toHaveBeenCalled())
      // The track is loaded and the position has not arrived. Nothing yet.
      expect(audio.__player.seekTo).not.toHaveBeenCalled()

      // Storage answers, late.
      await act(async () => {
        useResume.setState({ point: { songId: SONG.id, seconds: 96 } })
        listeners.forEach((fn) => fn())
      })

      await waitFor(() => expect(audio.__player.seekTo).toHaveBeenCalledWith(96))
      onFinish.mockRestore()
      jest.restoreAllMocks()
    })

    it('ignores a position belonging to a different track', async () => {
      usePlayer.setState({
        current: { source: 'context', song: SONG },
        contextQueue: [SONG],
        contextOrder: [0],
        contextIndex: 0,
        isPlaying: false,
      })
      useResume.setState({ point: { songId: 999, seconds: 96 } })

      await mount()

      await waitFor(() => expect(audio.__player.replace).toHaveBeenCalled())
      // Keyed by song id precisely so a stale position cannot be applied to
      // whatever happens to be playing now.
      expect(audio.__player.seekTo).not.toHaveBeenCalled()
    })

    it('records the position when playback pauses', async () => {
      await mount()
      await act(async () => {
        usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
      })
      await waitFor(() => expect(audio.__player.play).toHaveBeenCalled())

      await act(async () => {
        usePlayer.getState().setPlaying(false)
        audio.__emit({ currentTime: 37, playing: false })
      })

      // Exact on pause rather than the throttled value, because pausing is when
      // someone is most likely to leave.
      await waitFor(() => expect(useResume.getState().point).toEqual({ songId: 7, seconds: 37 }))
    })
  })

  it('touches nothing on unmount, because expo-audio has already released it', async () => {
    const view = await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })
    await waitFor(() => expect(audio.__player.setActiveForLockScreen).toHaveBeenCalled())
    audio.__player.clearLockScreenControls.mockClear()

    await act(async () => {
      view.unmount()
    })

    // Nor the equaliser's processors, which is the same lesson a second time:
    // `release` used to be called from an unmount cleanup and threw on every
    // unmount, because a released `SharedObject` reaches Kotlin as a bare
    // `Integer` rather than a `SharedRef`. The module's `OnDestroy` frees them.
    expect(mockRelease).not.toHaveBeenCalled()

    // #189: there used to be a cleanup calling `clearLockScreenControls()` here,
    // and it crashed the app on resume with "Cannot use shared object that was
    // already released". `useAudioPlayer` builds the player with
    // `useReleasingSharedObject`, registered before our effects, so its
    // `release()` always runs first — and releasing already tears the media
    // session down. This pins the absence, because the deleted line looks like
    // an omission rather than a decision.
    expect(audio.__player.clearLockScreenControls).not.toHaveBeenCalled()
  })

  it('does not offer lock-screen next/previous, which expo-audio cannot do', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })

    await waitFor(() => expect(audio.__player.setActiveForLockScreen).toHaveBeenCalled())
    const [, , options] = audio.__player.setActiveForLockScreen.mock.calls[0]
    // Pinned so a future "just add next/previous" is met with the reason it
    // cannot work: AudioLockScreenOptions has no such fields, and the platform
    // next button is bound to seek. See PlayerHost.
    expect(options).not.toHaveProperty('showNextTrack')
    expect(options).not.toHaveProperty('showPreviousTrack')
  })

  describe('loudness normalization (P8)', () => {
    /** -8 LUFS: louder than the -14 target, so it should be turned down 6 dB.
     *  The common case — 82% of the reference library sits above target. */
    const LOUD: Song = { ...SONG, id: 8, loudness_lufs: -8, peak_dbfs: -3 }
    /** -24 LUFS: wants +10 dB, which Android cannot apply. */
    const QUIET: Song = { ...SONG, id: 9, loudness_lufs: -24, peak_dbfs: -20 }

    const playSong = async (song: Song) => {
      await act(async () => {
        usePlayer.getState().playFromContext([song], 0, { kind: 'library' })
      })
      await waitFor(() => expect(audio.__player.replace).toHaveBeenCalled())
    }

    it('turns a loud track down', async () => {
      await mount()
      await playSong(LOUD)

      // -6 dB as a linear multiplier.
      expect(audio.__player.volume).toBeCloseTo(10 ** (-6 / 20), 5)
    })

    it('leaves a quiet track at unity rather than asking for a boost', async () => {
      await mount()
      await playSong(QUIET)

      // Not 3.16. Setting that would be discarded by `coerceIn(0f, 1f)` in
      // expo-audio's Android source, so the code must not pretend otherwise.
      expect(audio.__player.volume).toBe(1)
    })

    it('leaves an unmeasured track alone', async () => {
      await mount()
      await playSong(SONG) // loudness_lufs: null

      expect(audio.__player.volume).toBe(1)
    })

    it('restores unity when the setting is turned off mid-track', async () => {
      await mount()
      await playSong(LOUD)
      expect(audio.__player.volume).toBeLessThan(1)

      await act(async () => {
        await useAudioSettings.getState().setNormalizeLoudness(false)
      })

      // The gain has to follow the setting without reloading the track: the
      // effect is deliberately separate from the one that loads audio, which
      // returns early when the song has not changed.
      expect(audio.__player.volume).toBe(1)
      expect(audio.__player.replace).toHaveBeenCalledTimes(1)
    })

    it('applies the new gain when the track changes', async () => {
      await mount()
      await playSong(LOUD)
      await playSong(QUIET)

      expect(audio.__player.volume).toBe(1)
    })
  })
})

describe('playing from the device when the audio is here (#217)', () => {
  it('loads the local file instead of streaming', async () => {
    mockLocalSong.mockResolvedValue({ id: 'abc', file_uri: 'file:///library/abc.opus' })

    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })

    await waitFor(() => expect(audio.__player.replace).toHaveBeenCalled())
    expect(audio.__player.replace.mock.calls.at(-1)?.[0]).toEqual({
      uri: 'file:///library/abc.opus',
    })
    // Looked up by the server's id, which is what the player holds until #216.
    expect(mockLocalSong).toHaveBeenCalledWith(SONG.id)
  })

  it('streams when the bytes are not here yet', async () => {
    mockLocalSong.mockResolvedValue({ id: 'abc', file_uri: null })

    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })

    await waitFor(() => expect(audio.__player.replace).toHaveBeenCalled())
    expect(audio.__player.replace.mock.calls.at(-1)?.[0].uri).toContain(`/songs/${SONG.id}/audio`)
  })

  it('still plays when the local database cannot be read', async () => {
    mockLocalSong.mockRejectedValue(new Error('database is locked'))

    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })

    // A library that will not open is a bad day, not a reason for silence.
    await waitFor(() => expect(audio.__player.replace).toHaveBeenCalled())
    expect(audio.__player.replace.mock.calls.at(-1)?.[0].uri).toContain(`/songs/${SONG.id}/audio`)
  })
})

/**
 * The settings the store records and this component applies (#234).
 *
 * The split is the point: `store.test.ts` proves the *choice* is recorded
 * correctly without touching a native module, and these prove the choice
 * actually reaches the player.
 */
describe('applying the playback settings (#234)', () => {
  it('multiplies the user volume with the loudness correction, rather than replacing it', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })

    // SONG is -12 LUFS, so P8 attenuates it. Whatever that correction is, the
    // user's half volume must halve it — not overwrite it.
    const corrected = audio.__player.volume
    expect(corrected).toBeGreaterThan(0)

    await act(async () => {
      usePlayer.getState().setVolume(0.5)
    })

    expect(audio.__player.volume).toBeCloseTo(corrected * 0.5, 5)
  })

  it('silences on mute and restores on unmute', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })
    const corrected = audio.__player.volume

    await act(async () => {
      usePlayer.getState().toggleMute()
    })
    expect(audio.__player.volume).toBe(0)

    await act(async () => {
      usePlayer.getState().toggleMute()
    })
    expect(audio.__player.volume).toBeCloseTo(corrected, 5)
  })

  it('applies the playback rate', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().setPlaybackRate(1.5)
    })

    expect(audio.__player.playbackRate).toBe(1.5)
  })

  it('stops playback when the sleep timer runs out', async () => {
    jest.useFakeTimers()
    try {
      await mount()
      await act(async () => {
        usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
        usePlayer.getState().setSleepTimer(20)
      })
      expect(usePlayer.getState().isPlaying).toBe(true)

      await act(async () => {
        jest.advanceTimersByTime(20 * 60_000)
      })

      expect(usePlayer.getState().isPlaying).toBe(false)
      // One-shot: it disarms itself, or it would stop the next thing played.
      expect(usePlayer.getState().sleepAt).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  /**
   * The sleep fade (#241).
   *
   * `sleepAt` is 20 minutes out in each of these, so the arithmetic is the same
   * everywhere: the fade is armed at 19:52 and runs the last 8 seconds.
   *
   * jest's modern fake timers move `Date.now()` as well as the timer queue,
   * which is what makes these possible at all — the fade reads the wall clock
   * on every step rather than counting its own ticks, exactly so a backgrounded
   * phone cannot drift.
   */
  const TWENTY_MINUTES = 20 * 60_000
  const FADE_MS = 8_000

  it('fades out over the last seconds instead of cutting the audio dead (#241)', async () => {
    jest.useFakeTimers()
    try {
      await mount()
      await act(async () => {
        usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
        usePlayer.getState().setSleepTimer(20)
      })
      const corrected = audio.__player.volume
      expect(corrected).toBeGreaterThan(0)

      // Nineteen minutes in: nothing has moved. A fade that started early would
      // be a timer that quietly means less than it says.
      await act(async () => {
        jest.advanceTimersByTime(TWENTY_MINUTES - FADE_MS - 1000)
      })
      expect(audio.__player.volume).toBeCloseTo(corrected, 5)
      expect(usePlayer.getState().isPlaying).toBe(true)

      // Half way through the ramp.
      await act(async () => {
        jest.advanceTimersByTime(1000 + FADE_MS / 2)
      })
      const half = audio.__player.volume
      expect(half).toBeLessThan(corrected)
      expect(half).toBeGreaterThan(0)
      // Still playing: a fade that has already stopped the music is just a
      // shorter timer.
      expect(usePlayer.getState().isPlaying).toBe(true)

      // The fade multiplies the loudness correction rather than replacing it,
      // which is what #241 asks to keep. Half way means half of the corrected
      // level, not half of unity.
      expect(half).toBeCloseTo(corrected * 0.5, 2)

      await act(async () => {
        jest.advanceTimersByTime(FADE_MS / 2)
      })
      expect(usePlayer.getState().isPlaying).toBe(false)
      expect(usePlayer.getState().sleepAt).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it('leaves the volume where it was once the timer has fired (#241)', async () => {
    jest.useFakeTimers()
    try {
      await mount()
      await act(async () => {
        usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
        usePlayer.getState().setSleepTimer(20)
      })
      const corrected = audio.__player.volume

      await act(async () => {
        jest.advanceTimersByTime(TWENTY_MINUTES)
      })
      expect(usePlayer.getState().isPlaying).toBe(false)

      // A fade left at zero is an app that plays nothing next time it opens,
      // with a volume slider that says it is turned up.
      expect(audio.__player.volume).toBeCloseTo(corrected, 5)
    } finally {
      jest.useRealTimers()
    }
  })

  it('restores the volume when the timer is cancelled mid-fade (#241)', async () => {
    jest.useFakeTimers()
    try {
      await mount()
      await act(async () => {
        usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
        usePlayer.getState().setSleepTimer(20)
      })
      const corrected = audio.__player.volume

      await act(async () => {
        jest.advanceTimersByTime(TWENTY_MINUTES - FADE_MS / 2)
      })
      expect(audio.__player.volume).toBeLessThan(corrected)

      await act(async () => {
        usePlayer.getState().setSleepTimer(null)
      })

      expect(audio.__player.volume).toBeCloseTo(corrected, 5)
      expect(usePlayer.getState().isPlaying).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('fires immediately for a timer whose moment has already passed', async () => {
    // What a phone coming back from being backgrounded looks like.
    jest.useFakeTimers()
    try {
      await mount()
      await act(async () => {
        usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
      })
      await act(async () => {
        usePlayer.setState({ sleepAt: Date.now() - 1000 })
      })

      expect(usePlayer.getState().isPlaying).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })
})

/**
 * The equaliser reaching the track that is actually playing (#303).
 *
 * Reported as "it doesn't apply to the track that's playing, nor if you set it
 * before the track plays — it just doesn't work", and it was all one thing: the
 * curve was pushed when the *store's* song changed, which is two awaits before
 * `player.replace()` gives the deck an audio session to attach to. The one
 * attempt failed and nothing ever repeated it, so the equaliser came alive on
 * the second track.
 *
 * These drive it from the deck's own status ticks, which is what the fix does.
 */
describe('the equaliser and the audio session (#303)', () => {
  const CURVE = [6, 5, 4, 0, 0, 0, 0, 2, 3, 4]

  beforeEach(() => {
    mockSetGains.mockClear()
    // Restored, not just cleared: a test that pins one reason with
    // `mockImplementation` would otherwise hand it to every test after it, and
    // the failure lands in the *next* test rather than the one that caused it.
    mockSetGains.mockImplementation(() => (mockSessionReady ? 'ok' : 'no_session_yet'))
    mockSessionReady = false
    useAudioSettings.setState({ eqGains: CURVE })
  })

  const playIt = async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })
    await waitFor(() => expect(audio.__player.replace).toHaveBeenCalled())
  }

  it('keeps trying until the deck has a session, rather than giving up after one refusal', async () => {
    await playIt()

    // It asked, and the deck refused — no session yet.
    expect(mockSetGains).toHaveBeenCalled()
    expect(mockSetGains.mock.results.every((result) => result.value === 'no_session_yet')).toBe(
      true,
    )
    const refusals = mockSetGains.mock.calls.length

    // ExoPlayer's renderer comes up and the session id stops being 0. Nothing
    // in the store changed — this is the moment the old code could not see.
    mockSessionReady = true
    await act(async () => {
      audio.__emit({ currentTime: 1, playing: true })
    })

    expect(mockSetGains.mock.calls.length).toBeGreaterThan(refusals)
    expect(mockSetGains).toHaveLastReturnedWith('ok')
    expect(mockSetGains.mock.calls.at(-1)?.[1]).toEqual(CURVE)
  })

  it('stops asking once the curve is on', async () => {
    mockSessionReady = true
    await playIt()
    // One tick past the load first: `replace()` gives the deck a *new* session,
    // so the attempt made before it is legitimately re-made after it.
    await act(async () => {
      audio.__emit({ currentTime: 1, playing: true })
    })
    await waitFor(() => expect(mockSetGains).toHaveLastReturnedWith('ok'))
    const applied = mockSetGains.mock.calls.length

    // Status ticks arrive twice a second for as long as the app is open, and
    // each one is a chance to retry. Retrying something that has already worked
    // would be a native call every 500 ms for the life of the app.
    await act(async () => {
      audio.__emit({ currentTime: 2, playing: true })
      audio.__emit({ currentTime: 3, playing: true })
    })

    expect(mockSetGains.mock.calls.length).toBe(applied)
  })

  it('follows the curve when a band is moved', async () => {
    mockSessionReady = true
    await playIt()
    await waitFor(() => expect(mockSetGains).toHaveLastReturnedWith('ok'))

    const moved = [...CURVE]
    moved[0] = -6
    await act(async () => {
      useAudioSettings.setState({ eqGains: moved })
    })

    expect(mockSetGains.mock.calls.at(-1)?.[1]).toEqual(moved)
  })

  it('stops asking a deck that will never take it', async () => {
    // The retry #303 added is right for a renderer that has not come up yet —
    // a tick or two of `audioSessionId == 0`. It is wrong for a build that can
    // *never* accept the curve, because then it is a JNI call twice a second
    // for as long as anything plays, with the answer thrown away (#342).
    mockSessionReady = false
    await playIt()

    // One `act` per tick, deliberately. Emitting forty inside a single one
    // batches them into a single render and a single effect run — the retry
    // never happens, the cap is never reached, and the test passes whatever the
    // code does. That is how the first version of this test was wrong.
    for (let tick = 1; tick <= 30; tick++) {
      await act(async () => {
        audio.__emit({ currentTime: tick, playing: true })
      })
    }
    const asked = mockSetGains.mock.calls.length

    for (let tick = 31; tick <= 60; tick++) {
      await act(async () => {
        audio.__emit({ currentTime: tick, playing: true })
      })
    }

    // The property is "it stops", not a particular number — thirty more ticks
    // and not one more call. A magic total would also have to know about the
    // attempt made before `replace()` claimed the deck, which is a detail of
    // the load path and not of this.
    expect(mockSetGains.mock.calls.length).toBe(asked)
  })

  /**
   * A refusal that cannot improve is not worth the whole attempt budget.
   *
   * `no_session_yet` and `session_blocked` are both refusals and want opposite
   * treatment: the first is a renderer that has not come up, the second is
   * reflection that will fail identically every time. Before the reasons
   * existed both were `false`, so this distinction could not be drawn at all —
   * which is why it is asserted as a *difference* between the two rather than
   * as a call count, a number that would also encode the load path's reset.
   */
  /**
   * The transient carve-out, on a renderer that takes its time.
   *
   * The test above lets the session arrive on the very first tick after the
   * load, and the load path resets the attempt budget anyway — so between them
   * a *single* attempt is enough and treating `no_session_yet` as permanent
   * looks harmless. It is not: on a device the renderer takes several ticks,
   * and cutting the retry off at the first refusal is #303 itself.
   *
   * Written after a mutation that made every refusal permanent passed the whole
   * file.
   */
  it('keeps asking across several ticks before the renderer comes up', async () => {
    mockSessionReady = false
    await playIt()

    for (let tick = 1; tick <= 3; tick++) {
      await act(async () => {
        audio.__emit({ currentTime: tick, playing: true })
      })
    }
    expect(mockSetGains).toHaveLastReturnedWith('no_session_yet')

    mockSessionReady = true
    await act(async () => {
      audio.__emit({ currentTime: 4, playing: true })
    })

    expect(mockSetGains).toHaveLastReturnedWith('ok')
  })

  it('gives up sooner on a refusal that can never improve', async () => {
    mockSessionReady = false
    mockSetGains.mockImplementation(() => 'session_blocked')

    await playIt()
    for (let tick = 1; tick <= 20; tick++) {
      await act(async () => {
        audio.__emit({ currentTime: tick, playing: true })
      })
    }

    // Two, and the two are structural rather than a tuning knob: one attempt
    // before `replace()` claims the deck and resets the budget, one after. The
    // point is that it is nowhere near the ten a *transient* refusal is
    // allowed — the test above spends the whole budget on `no_session_yet`
    // under exactly these ticks.
    expect(mockSetGains).toHaveLastReturnedWith('session_blocked')
    expect(mockSetGains.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('asks again when the user changes the curve', async () => {
    mockSessionReady = false
    await playIt()
    for (let tick = 1; tick <= 40; tick++) {
      await act(async () => {
        audio.__emit({ currentTime: tick, playing: true })
      })
    }
    const refusals = mockSetGains.mock.calls.length
    // It really did stop, or the next assertion proves nothing.
    await act(async () => {
      audio.__emit({ currentTime: 41, playing: true })
    })
    expect(mockSetGains.mock.calls.length).toBe(refusals)

    mockSessionReady = true
    await act(async () => {
      useAudioSettings.setState({ eqGains: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
    })

    // A curve the user just moved is a new question. Giving up permanently
    // would mean the equaliser stayed dead until the app restarted.
    expect(mockSetGains.mock.calls.length).toBeGreaterThan(refusals)
    expect(mockSetGains).toHaveLastReturnedWith('ok')
  })

  it('re-attaches to the next track, which is a different session', async () => {
    mockSessionReady = true
    const second = { ...SONG, id: 8, title: 'Second Track' }
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG, second], 0, { kind: 'library' })
    })
    await waitFor(() => expect(mockSetGains).toHaveLastReturnedWith('ok'))
    const applied = mockSetGains.mock.calls.length

    await act(async () => {
      audio.__emit({ didJustFinish: true })
    })
    await waitFor(() => expect(usePlayer.getState().current?.song.id).toBe(8))
    await act(async () => {
      audio.__emit({ currentTime: 1, playing: true })
    })

    // A `replace()` is a new session, so remembering "already applied" across
    // it would leave the second track unequalised — the first bug wearing the
    // opposite coat.
    expect(mockSetGains.mock.calls.length).toBeGreaterThan(applied)
  })
})

describe('applying a scrub (#231)', () => {
  it('seeks the native player and clears the request', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })

    await act(async () => {
      usePlayer.getState().seekTo(42)
    })

    expect(audio.__player.seekTo).toHaveBeenCalledWith(42)
    // Cleared, or an unrelated render would re-run it and yank the track back
    // to wherever the user last dragged, minutes later.
    expect(usePlayer.getState().seekRequest).toBeNull()
  })

  /**
   * Scrubbing a track that has not finished loading.
   *
   * Reachable, and the reason the seek effect also marks the track as restored:
   * a launch can restore a paused track with a stored position (#183), and the
   * restore fires the moment `isLoaded` turns true. Scrub before that lands and
   * — without the marking — the restore would immediately drag playback back to
   * the stored second, undoing the drag with no way for the user to tell why.
   *
   * The mock therefore starts **unloaded**, which is the only way this path can
   * be reached at all.
   */
  it('is not undone by the stored position arriving afterwards', async () => {
    audio.__reset({ ...INITIAL_STATUS, isLoaded: false })
    await mount()
    await act(async () => {
      useResume.getState().set(SONG.id, 120)
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })

    await act(async () => {
      usePlayer.getState().seekTo(10)
    })
    expect(audio.__player.seekTo).toHaveBeenLastCalledWith(10)

    // The track finishes loading, which is when #183's restore runs.
    await act(async () => {
      audio.__emit({ isLoaded: true })
    })

    expect(audio.__player.seekTo).toHaveBeenLastCalledWith(10)
  })
})

/**
 * Crossfade (#201).
 *
 * These prove the *deck management*: that a second player is fed, that both are
 * audible at once, that the lock screen moves with the store, and that with the
 * feature off none of it happens. The curve itself is checked exactly in
 * `crossfade.test.ts`, where it needs no player at all.
 *
 * What they cannot prove is the thing that matters most — that handing the
 * media session between decks does not stop background audio. No mock can see
 * that. It is a locked screen and five minutes (`docs/mobile-testing.md`).
 */
describe('crossfade (#201)', () => {
  // The volume is one of four multipliers on the same `volume` property, and an
  // earlier test in this file leaves the user's at 0.5. Pinned here so these
  // assertions are about the crossfade factor rather than about what ran
  // before them.
  beforeEach(() => {
    usePlayer.setState({ volume: 1, muted: false, crossfadeSeconds: 0 })
  })

  const NEXT: Song = { ...SONG, id: 8, title: 'The Next One' }
  const THIRD: Song = { ...SONG, id: 9, title: 'And Another' }

  async function playTwoTracks(crossfadeSeconds: number) {
    const view = await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG, NEXT], 0, { kind: 'library' })
      usePlayer.setState({ crossfadeSeconds })
    })
    await act(async () => {})
    return view
  }

  /** Push the active deck into the tail of the track and let the async load
   *  settle. 180s long, so 174 is 6 seconds from the end. */
  async function reachTheTail(at = 174) {
    await act(async () => {
      audio.__emit({ currentTime: at, playing: true })
    })
    await act(async () => {})
  }

  it('does none of it when crossfade is off, which is the default', async () => {
    await playTwoTracks(0)
    await reachTheTail()

    // The safety property: at 0 seconds this is the single-deck app it was
    // before #201, and the second deck is never fed.
    expect(audio.__decks[1]?.replace).not.toHaveBeenCalled()
    expect(usePlayer.getState().current?.song.id).toBe(SONG.id)
  })

  it('loads the next track on the other deck and plays both', async () => {
    await playTwoTracks(8)
    // Counted from here, not from zero: the load effect pauses the deck once at
    // mount, before any song exists, and that is not the pause this is about.
    const pausesBefore = audio.__decks[0].pause.mock.calls.length
    await reachTheTail()

    // The outgoing deck is still going — that is what makes it a crossfade
    // rather than a gap.
    expect(audio.__decks[0].pause.mock.calls.length).toBe(pausesBefore)

    expect(audio.__decks[1].replace).toHaveBeenCalled()
    expect(audio.__decks[1].play).toHaveBeenCalled()
  })

  /**
   * A fade the app is minimised half way through (#455 → #470).
   *
   * This used to assert that minimising **finished** the fade on the spot,
   * snapping the incoming deck to full level. That was the right trade while
   * the ramp's only driver was a `setInterval`, which Android stops the moment
   * the activity pauses (`JavaTimerManager`: `onHostPause()` clears the frame
   * callback, `TimerFrameCallback.doFrame` returns without re-posting). The
   * alternative then was both decks stuck at a partial gain forever.
   *
   * The ramp now has a second driver that survives the pause — `expo-audio`'s
   * status heartbeat, emitted from a Kotlin coroutine on `Dispatchers.Main`.
   * Measured on the device before this was relied on, over 135 s backgrounded
   * with audio playing: `ticks=272 over=134582ms expected=269 playing=true`.
   *
   * ## How the freeze is simulated
   *
   * `jest.setSystemTime` moves the wall clock **without firing any timer**,
   * which is exactly what Android does to a paused activity. So the fade below
   * completes with the interval never running once — the heartbeat is provably
   * the only thing driving it, which is the whole claim of #470.
   */
  it('keeps a backgrounded fade running on the heartbeat alone (#470)', async () => {
    const handlers: ((state: string) => void)[] = []
    const listen = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((event: string, handler: unknown) => {
        if (event === 'change') handlers.push(handler as (state: string) => void)
        return { remove: () => {} } as never
      })
    jest.useFakeTimers()

    try {
      await playTwoTracks(8)
      const pausesBefore = audio.__decks[0].pause.mock.calls.length
      await reachTheTail()
      // Mid-fade: both decks audible, nothing paused yet. Without this the test
      // could pass on a fade that had already ended by itself.
      expect(audio.__decks[0].pause.mock.calls.length).toBe(pausesBefore)
      expect(handlers.length).toBeGreaterThan(0)

      await act(async () => {
        handlers.forEach((handler) => handler('background'))
      })

      // The behaviour change: minimising no longer cuts the fade short. It used
      // to pause the outgoing deck right here.
      expect(audio.__decks[0].pause.mock.calls.length).toBe(pausesBefore)

      // The wall clock passes the whole fade while every timer stays frozen,
      // and one heartbeat arrives — which is all a backgrounded device gets.
      //
      // On the **incoming** deck, because that is where it comes from: the fade
      // has already flipped `activeDeck`, so the status hook is bound to deck 1,
      // and deck 1 is the one playing (at gain 0) for the whole ramp.
      await act(async () => {
        jest.setSystemTime(Date.now() + 9_000)
        audio.__emitOn(1, { currentTime: 5, playing: true })
      })
      await act(async () => {})

      expect(audio.__decks[1].volume).toBeCloseTo(1, 5)
      expect(audio.__decks[0].pause.mock.calls.length).toBe(pausesBefore + 1)

      /*
       * And the driver lets go at the end.
       *
       * The heartbeat keeps arriving for as long as the track plays — it is the
       * ordinary status tick — so a step left registered would be called about
       * twice a second forever, re-running `finishFade` each time: pausing the
       * outgoing deck again, re-logging `queue.fade`, and resetting the gain and
       * deck bookkeeping that the *next* fade depends on.
       *
       * Found by mutation: nulling `fadeStep` was the one change to this file
       * that no test noticed.
       */
      await act(async () => {
        jest.setSystemTime(Date.now() + 1_000)
        audio.__emitOn(1, { currentTime: 6, playing: true })
      })
      await act(async () => {})

      expect(audio.__decks[0].pause.mock.calls.length).toBe(pausesBefore + 1)
    } finally {
      jest.useRealTimers()
      listen.mockRestore()
    }
  })

  it('leaves a running fade alone while the app stays in front', async () => {
    const handlers: ((state: string) => void)[] = []
    const listen = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((event: string, handler: unknown) => {
        if (event === 'change') handlers.push(handler as (state: string) => void)
        return { remove: () => {} } as never
      })

    try {
      await playTwoTracks(8)
      const pausesBefore = audio.__decks[0].pause.mock.calls.length
      await reachTheTail()

      await act(async () => {
        handlers.forEach((handler) => handler('active'))
      })

      // The other edge (#392): a guard proved only in the direction that acts
      // is satisfied just as well by one that always acts.
      expect(audio.__decks[0].pause.mock.calls.length).toBe(pausesBefore)
      expect(audio.__decks[1].volume).toBeLessThan(1)
    } finally {
      listen.mockRestore()
    }
  })

  /**
   * The handover has **no** release half (#428, #466, #468).
   *
   * #466 added one, on the reading that `setActiveForLockScreen` is per player
   * so the code "only ever did the acquire half". The device disproved it: the
   * media player went blank at a track change *sometimes*, and had to be nudged
   * from inside the app to come back.
   *
   * `AudioControlsService` is single-player. `setActivePlayerInternal` (line
   * 338) already clears the previous player at line 349, hides the old
   * notification and builds the new session — the acquire *is* the handover.
   * Releasing on top of it runs `clearSessionInternal` (line 413), which checks
   * nothing about which player asked and does `mediaSession?.release()` plus
   * `stopForeground(STOP_FOREGROUND_REMOVE)`: it tears down the session the
   * incoming deck just created.
   */
  it('never unregisters the outgoing deck at a handover (#468)', async () => {
    await playTwoTracks(8)
    await reachTheTail()

    await waitFor(() =>
      expect(audio.__decks[1].setActiveForLockScreen).toHaveBeenCalledWith(
        true,
        expect.anything(),
        expect.anything(),
      ),
    )

    /*
     * The assertion that matters, and it is an absence. `false` anywhere here
     * is `clearSessionInternal` taking down the notification the line above
     * just put up — a blank media player on a real phone, arriving only
     * sometimes because the acquire applies asynchronously while the service
     * is still binding.
     */
    for (const deck of audio.__decks) {
      const released = deck.setActiveForLockScreen.mock.calls.filter(
        ([active]: [boolean]) => active === false,
      )
      expect(released).toHaveLength(0)
    }
  })

  /**
   * Whether the ramp actually ran (#467).
   *
   * I has reported hearing no crossfade across three device passes while
   * every other reading said the transition worked. Those are different claims,
   * and nothing in the app could separate them: a ramp that ran 240 times over
   * twelve seconds and one that ran twice produce the same track change and the
   * same logs. `steps` is what tells them apart.
   */
  it('counts the steps the ramp actually ran (#467)', async () => {
    const { useDiagnostics } = jest.requireActual('../src/diagnostics/log')
    useDiagnostics.setState({ entries: [] })
    // Fake timers, because the ramp is a `setInterval` and real ones would
    // make this a nine-second test that still measured nothing.
    jest.useFakeTimers()
    try {
      const view = await mount()
      await act(async () => {
        usePlayer.getState().playFromContext([SONG, NEXT, THIRD], 0, { kind: 'library' })
        usePlayer.setState({ crossfadeSeconds: 8 })
      })
      await act(async () => {})
      await act(async () => {
        audio.__emit({ currentTime: 174, playing: true })
      })
      await act(async () => {})
      await act(async () => {
        jest.advanceTimersByTime(9_000)
      })
      view.unmount()
    } finally {
      jest.useRealTimers()
    }

    const entry = useDiagnostics
      .getState()
      .entries.find((e: { event: string }) => e.event === 'queue.fade')
    expect(entry?.detail ?? '').toMatch(/steps=\d+ over=\d+ms planned=\d+ms/)
    // A ramp that ran must report more than a couple of steps, or the number is
    // decoration rather than a measurement.
    const steps = Number(/steps=(\d+)/.exec(entry?.detail ?? '')?.[1] ?? 0)
    expect(steps).toBeGreaterThan(5)
  })

  it('brings the incoming track in from silence', async () => {
    await playTwoTracks(8)
    await reachTheTail()

    // Started at zero and ramping up. A deck that arrived at full volume would
    // be a cut, and the loudest possible moment of the transition.
    expect(audio.__decks[1].volume).toBeLessThan(0.2)
  })

  it('moves the lock screen and the store to the incoming track together', async () => {
    await playTwoTracks(8)
    await reachTheTail()

    // Both, because either alone is a lie: a lock screen naming a track that is
    // fading away, or a "next" press mid-fade skipping to the wrong place.
    expect(audio.__decks[1].setActiveForLockScreen).toHaveBeenCalled()
    expect(usePlayer.getState().current?.song.id).toBe(NEXT.id)
  })

  it('runs the ramp to the end, stops the outgoing deck and frees it for the next fade', async () => {
    // The one that caught a real bug. The trigger effect flips `activeDeck`,
    // which is one of its own dependencies, so it tears itself down the instant
    // a fade begins — and while the ramp lived inside it, clearing the interval
    // on cleanup killed every fade on its first tick. The incoming deck stayed
    // silent and the outgoing one never stopped.
    jest.useFakeTimers()
    try {
      const view = await mount()
      await act(async () => {
        usePlayer.getState().playFromContext([SONG, NEXT, THIRD], 0, { kind: 'library' })
        usePlayer.setState({ crossfadeSeconds: 8 })
      })
      await act(async () => {})

      await act(async () => {
        audio.__emit({ currentTime: 174, playing: true })
      })
      await act(async () => {})

      const pausesBefore = audio.__decks[0].pause.mock.calls.length
      await act(async () => {
        jest.advanceTimersByTime(9_000)
      })

      // Ended on the incoming track at full level and the outgoing one stopped.
      expect(audio.__decks[1].volume).toBeCloseTo(1, 2)
      expect(audio.__decks[0].pause.mock.calls.length).toBe(pausesBefore + 1)

      // And the machinery is free again: without resetting `transitioning` the
      // first crossfade would be the only one the app ever performed.
      await act(async () => {
        audio.__emitOn(1, { currentTime: 174, playing: true, duration: 180 })
      })
      await act(async () => {})
      expect(audio.__decks[0].replace.mock.calls.length).toBeGreaterThan(1)

      view.unmount()
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not fade the last track of a queue into silence', async () => {
    await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
      usePlayer.setState({ crossfadeSeconds: 8 })
    })
    await act(async () => {})
    await reachTheTail()

    expect(audio.__decks[1]?.replace).not.toHaveBeenCalled()
  })

  it('does not start the next track while paused', async () => {
    await playTwoTracks(8)
    await act(async () => {
      usePlayer.setState({ isPlaying: false })
    })
    await act(async () => {
      audio.__emit({ currentTime: 174, playing: false })
    })
    await act(async () => {})

    expect(audio.__decks[1]?.replace).not.toHaveBeenCalled()
  })

  /**
   * #304, and the test the issue asked for by name.
   *
   * The trigger set `transitioning` and then did async work — a device-library
   * lookup and the audio-session promise. The effect re-runs on **every** status
   * tick, twice a second, and React runs the previous cleanup first, so a tick
   * landing inside that window cancelled the run at `if (cancelled) return`
   * *without giving the latch back*. `shouldStartCrossfade` then answered false
   * for the rest of the app session and crossfade was dead, silently, after one
   * race that was easy to lose.
   *
   * So this fires a tick inside the window on purpose and asserts a later fade
   * still starts.
   */
  it('survives a status tick landing inside the load, and still fades later', async () => {
    const view = await mount()
    await act(async () => {
      usePlayer.getState().playFromContext([SONG, NEXT, THIRD], 0, { kind: 'library' })
      usePlayer.setState({ crossfadeSeconds: 8 })
    })
    await act(async () => {})

    // Hold the library lookup open, so the next tick is guaranteed to land
    // inside the async window rather than by luck of timing.
    let finishLookup: () => void = () => {}
    mockLocalSong.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLookup = () => resolve(null)
        }),
    )

    // The tail: a fade begins and stalls on the lookup.
    await act(async () => {
      audio.__emit({ currentTime: 174, playing: true })
    })
    // Half a second later, another tick — the race.
    await act(async () => {
      audio.__emit({ currentTime: 174.5, playing: true })
    })
    // The lookup finally answers, into a run that has been cancelled.
    await act(async () => {
      finishLookup()
    })
    await act(async () => {})

    expect(audio.__decks[1].replace).not.toHaveBeenCalled()

    // And now the machinery must still work. Before the fix this tick — and
    // every tick after it, for as long as the app stayed open — did nothing.
    await act(async () => {
      audio.__emit({ currentTime: 175, playing: true })
    })
    await act(async () => {})

    expect(audio.__decks[1].replace).toHaveBeenCalled()
    expect(audio.__decks[1].play).toHaveBeenCalled()

    view.unmount()
  })

  /**
   * Pausing while two tracks are audible, from device testing.
   *
   * "When 2 tracks are crossfading and I hit pause, it should pause both; now
   * it only pauses the track that's currently playing." Three separate things
   * were wrong, and they fed each other:
   *
   * - the play/pause intent was applied to the **active deck only**, which is
   *   the same thing as "both" except during exactly this;
   * - the ramp ran off the wall clock and did not care whether anything was
   *   playing, so a fade paused half way through came back finished;
   * - and the status reflector believed the incoming deck's first
   *   `playing: false`, so the store went to paused *by itself* mid-fade —
   *   which is a pause nobody asked for, applied to one deck.
   */
  describe('pausing in the middle of a fade', () => {
    /** Start a fade and stop half way along an eight-second one. */
    async function halfWayThroughAFade() {
      const view = await mount()
      await act(async () => {
        usePlayer.getState().playFromContext([SONG, NEXT, THIRD], 0, { kind: 'library' })
        usePlayer.setState({ crossfadeSeconds: 8 })
      })
      await act(async () => {})
      await act(async () => {
        audio.__emit({ currentTime: 174, playing: true })
      })
      await act(async () => {})
      await act(async () => {
        jest.advanceTimersByTime(4_000)
      })
      return view
    }

    it('stops both decks, not just the one the store calls current', async () => {
      jest.useFakeTimers()
      try {
        const view = await halfWayThroughAFade()
        const pauses = [
          audio.__decks[0].pause.mock.calls.length,
          audio.__decks[1].pause.mock.calls.length,
        ]

        await act(async () => {
          usePlayer.getState().setPlaying(false)
        })

        expect(audio.__decks[0].pause.mock.calls.length).toBe(pauses[0] + 1)
        expect(audio.__decks[1].pause.mock.calls.length).toBe(pauses[1] + 1)
        view.unmount()
      } finally {
        jest.useRealTimers()
      }
    })

    it('holds the fade where it is, rather than finishing it in silence', async () => {
      jest.useFakeTimers()
      try {
        const view = await halfWayThroughAFade()
        await act(async () => {
          usePlayer.getState().setPlaying(false)
        })
        const held = [audio.__decks[0].volume, audio.__decks[1].volume]
        expect(held[0]).toBeGreaterThan(0)

        // Long enough to have run the whole fade twice over.
        await act(async () => {
          jest.advanceTimersByTime(20_000)
        })

        expect(audio.__decks[0].volume).toBeCloseTo(held[0], 5)
        expect(audio.__decks[1].volume).toBeCloseTo(held[1], 5)
        view.unmount()
      } finally {
        jest.useRealTimers()
      }
    })

    it('picks the fade up where it left off when play is pressed again', async () => {
      jest.useFakeTimers()
      try {
        const view = await halfWayThroughAFade()
        await act(async () => {
          usePlayer.getState().setPlaying(false)
        })
        const held = audio.__decks[0].volume

        await act(async () => {
          jest.advanceTimersByTime(20_000)
        })
        await act(async () => {
          usePlayer.getState().setPlaying(true)
        })
        expect(audio.__decks[0].play).toHaveBeenCalled()
        expect(audio.__decks[1].play).toHaveBeenCalled()

        // One second of the *fade* has passed since resuming, not twenty-one.
        await act(async () => {
          jest.advanceTimersByTime(1_000)
        })
        expect(audio.__decks[0].volume).toBeLessThan(held)
        expect(audio.__decks[0].volume).toBeGreaterThan(0)
        view.unmount()
      } finally {
        jest.useRealTimers()
      }
    })

    it('does not decide it has been paused just because the decks changed over', async () => {
      jest.useFakeTimers()
      try {
        const view = await halfWayThroughAFade()

        // The incoming deck reports `playing: false` until it has actually
        // started, and the status the host reads is now that deck's. Believing
        // it is a pause nobody asked for, in the middle of a transition.
        expect(usePlayer.getState().isPlaying).toBe(true)
        view.unmount()
      } finally {
        jest.useRealTimers()
      }
    })
  })

  it('does not reload the incoming track when the store catches up', async () => {
    await playTwoTracks(8)
    await reachTheTail()

    // `trackEnded()` makes the incoming song `current`, which is exactly what
    // the load effect watches. It must recognise the deck as already holding
    // it, or the track restarts from zero the instant it becomes current.
    expect(audio.__decks[1].replace).toHaveBeenCalledTimes(1)
  })
})
