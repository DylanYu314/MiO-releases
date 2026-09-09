import { act, render, waitFor } from '@testing-library/react-native'
import * as expoModule from 'expo'

import { useConnection } from '../src/api/connection'
import type { Song } from '../src/api/types'
import { PlayerHost } from '../src/player/PlayerHost'
import { usePlaybackStatus } from '../src/player/playbackStatus'
import { usePlayer } from '../src/player/store'
import '../src/i18n'

/**
 * The lock screen when the app owns its own session (#395, #396, #397).
 *
 * `playerHost.test.tsx` is the **fallback** path — a binary built before this
 * module, where `expo-audio`'s per-deck session is still what runs. This file is
 * the other side: the module is present, so the host must drive ours and leave
 * `setActiveForLockScreen` completely alone. Two files rather than one because
 * "which native modules exist" is a property of the module registry, and that is
 * exactly what distinguishes the two paths.
 *
 * ## Why this is one long test rather than eight short ones
 *
 * Not a style choice. Under this harness a second `render(<PlayerHost />)`
 * reconciles into the same React root as an **update**, so every
 * `useEffect(…, [])` — including the one that starts the session and subscribes
 * to lock-screen presses — runs once for the whole file. Written as eight tests,
 * the first passed and the other seven asserted against a component that had
 * never re-run its setup. An explicit `cleanup()` did not change it.
 *
 * So: one mount, and the journey asserted in order, each step labelled.
 *
 * What no test here can prove is the thing slice 3 exists for — whether Android
 * picks **our** session over the ones expo-audio builds per player. That needs a
 * phone and a locked screen (`docs/mobile-testing.md`).
 */

jest.mock('../src/library/songs', () => ({
  getLocalSongByServerId: jest.fn(async () => null),
  getLocalSong: jest.fn(async () => null),
}))

/**
 * The media session's native side, present — and answering **by name**.
 *
 * The equaliser is deliberately absent. A mock that ignores its argument is what
 * broke five tests in the sibling file the moment a second optional module
 * existed, and repeating that shape here would hide the same class of bug in
 * the other direction.
 */
jest.mock('expo', () => {
  const handlers: ((event: unknown) => void)[] = []
  const session = {
    isSupported: true,
    start: jest.fn(() => 'ok'),
    update: jest.fn(() => true),
    isRunning: jest.fn(() => true),
    stop: jest.fn(() => true),
    addListener: jest.fn((_event: string, handler: (event: unknown) => void) => {
      handlers.push(handler)
      return { remove: jest.fn() }
    }),
  }
  return {
    requireOptionalNativeModule: (name: string) => (name === 'MioMediaSession' ? session : null),
    __session: session,
    __press: (event: unknown) => {
      handlers.forEach((handler) => handler(event))
    },
  }
})

jest.mock('expo-audio', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')
  const players: Record<string, unknown>[] = []

  const status = {
    isLoaded: true,
    isBuffering: false,
    playing: false,
    currentTime: 0,
    duration: 180,
    didJustFinish: false,
    error: null,
  }

  const makePlayer = () => ({
    play: jest.fn(),
    pause: jest.fn(),
    replace: jest.fn(),
    setActiveForLockScreen: jest.fn(),
    updateLockScreenMetadata: jest.fn(),
    clearLockScreenControls: jest.fn(),
    seekTo: jest.fn(async () => {}),
    volume: 1,
    setPlaybackRate: jest.fn(),
    get playbackRate() {
      return 1
    },
    get currentTime() {
      return 0
    },
    get playing() {
      return false
    },
  })

  return {
    useAudioPlayer: () => {
      const ref = React.useRef(null)
      if (!ref.current) {
        ref.current = makePlayer()
        players.push(ref.current)
      }
      return ref.current
    },
    useAudioPlayerStatus: () => status,
    setAudioModeAsync: jest.fn(async () => {}),
    __decks: players,
  }
})

const audio = jest.requireMock('expo-audio') as { __decks: Record<string, jest.Mock>[] }
const expoMocks = expoModule as unknown as {
  __session: { start: jest.Mock; update: jest.Mock; stop: jest.Mock; addListener: jest.Mock }
  __press: (event: { action: string; positionMs: number }) => void
}

function song(id: number, title: string): Song {
  return {
    id,
    title,
    artist: 'An Artist',
    album: null,
    duration: 180,
    source_url: `https://youtu.be/track${id}`,
    source_platform: 'Youtube',
    cover_url: null,
    loudness_lufs: null,
    peak_dbfs: null,
    created_at: '2026-08-09T00:00:00Z',
  } as unknown as Song
}

const FIRST = song(1, 'First Track')
const SECOND = song(2, 'Second Track')

/** The last thing the session was told. */
function lastUpdate(): Record<string, unknown> {
  const calls = expoMocks.__session.update.mock.calls
  return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>
}

/** No deck ever claims a session of its own. Asserted repeatedly, because the
 *  bug was one appearing at a *handover* rather than at the start. */
function noDeckClaimedTheLockScreen(): void {
  for (const deck of audio.__decks) {
    expect(deck.setActiveForLockScreen).not.toHaveBeenCalled()
  }
}

it('owns the lock screen from the first track to the last press (#395, #396, #397)', async () => {
  useConnection.setState({ serverUrl: 'https://mio.test/api', accessKey: null, loaded: true })
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
  })

  render(<PlayerHost />)

  // ── The notification permission is settled first (#472) ───────────────────
  // Not a detail of ordering for its own sake: a `notify()` made without the
  // permission is dropped in silence and nothing retries it, so the session
  // must not exist to post one until the answer is in. If `startMediaSession`
  // ever moves above that await, this is the line that notices.
  expect(expoMocks.__session.start).not.toHaveBeenCalled()

  await act(async () => {})

  // ── The session comes up with the host, not with a track ──────────────────
  // One session for the life of the app is the whole repair: the old code
  // activated the incoming deck's session at every handover and never released
  // the outgoing one.
  //
  // Awaited rather than asserted outright since #472: the notification
  // permission is settled *before* the session starts, so `start` is now one
  // resolved promise later than the mount.
  await waitFor(() => expect(expoMocks.__session.start).toHaveBeenCalledTimes(1))
  expect(expoMocks.__session.addListener).toHaveBeenCalledWith('onCommand', expect.any(Function))

  // ── Starting a track tells our session, and never expo-audio's ────────────
  await act(async () => {
    usePlayer.getState().playFromContext([FIRST, SECOND], 0, { kind: 'library' })
  })
  await waitFor(() => expect(expoMocks.__session.update).toHaveBeenCalled())

  expect(lastUpdate()).toMatchObject({
    title: 'First Track',
    artist: 'An Artist',
    // Milliseconds, because that is what media3 wants. The store keeps seconds,
    // and getting the unit wrong is a banner claiming a three-minute song runs
    // for three milliseconds.
    durationMs: 180_000,
    newTrack: true,
  })
  noDeckClaimedTheLockScreen()

  // ── A track change updates that same session; nothing is torn down ────────
  // 2026-08-09: the banner lost artwork, title, artist and buttons **at
  // a track change**, audio carried on for another half hour, and reopening the
  // app did not bring them back.
  expoMocks.__session.stop.mockClear()
  await act(async () => {
    usePlayer.getState().next()
  })
  await waitFor(() => expect(lastUpdate()).toMatchObject({ title: 'Second Track' }))

  expect(lastUpdate()).toMatchObject({ newTrack: true })
  expect(expoMocks.__session.stop).not.toHaveBeenCalled()
  noDeckClaimedTheLockScreen()

  // ── Pausing is not a track change ─────────────────────────────────────────
  // `SimpleBasePlayer` diffs its playlist by item uid, so claiming a new track
  // on every pause would rebuild the notification's artwork each time.
  await act(async () => {
    usePlayer.getState().setPlaying(false)
  })
  expect(lastUpdate()).toMatchObject({ playing: false, newTrack: false })

  // ── The banner's play and pause reach the store ───────────────────────────
  await act(async () => {
    expoMocks.__press({ action: 'play', positionMs: 0 })
  })
  expect(usePlayer.getState().isPlaying).toBe(true)

  await act(async () => {
    expoMocks.__press({ action: 'pause', positionMs: 0 })
  })
  expect(usePlayer.getState().isPlaying).toBe(false)

  // ── Previous and next change track, rather than seeking ───────────────────
  // The bug this module exists for: expo-audio's session *removes* next and
  // previous, so the lock screen jumped ±15 s where the user had asked for a
  // different song (#395).
  await act(async () => {
    expoMocks.__press({ action: 'previous', positionMs: 0 })
  })
  expect(usePlayer.getState().current?.song.id).toBe(FIRST.id)

  await act(async () => {
    expoMocks.__press({ action: 'next', positionMs: 0 })
  })
  expect(usePlayer.getState().current?.song.id).toBe(SECOND.id)

  // ── Seeking converts the unit ─────────────────────────────────────────────
  // media3 speaks milliseconds and the store keeps seconds. A missing division
  // is a scrub to the end of the track on every drag.
  //
  // Asserted on the **deck**, not on `seekRequest`: the host applies a request
  // and calls `clearSeekRequest()` in the same tick, so the store field is
  // correctly already empty by the time this runs. Reading it would have been a
  // test asserting on a value whose whole job is to be short-lived.
  await act(async () => {
    expoMocks.__press({ action: 'seek', positionMs: 42_000 })
  })
  expect(audio.__decks.some((deck) => deck.seekTo.mock.calls.some(([s]) => s === 42))).toBe(true)

  // ── …and the session is told where we landed (#475) ───────────────────────
  // The audio always jumped correctly; the session was told `positionMs: 0` at
  // the start of the track and never told anything again, so `getState()`
  // answered every seek with "we are at the beginning" and the bar restarted.
  //
  // 2026-08-12: *"the audio actually jumped, but the progress bar
  // restart from 0."* Watching rather than listening, that is indistinguishable
  // from the track replaying.
  expect(lastUpdate()).toMatchObject({ positionMs: 42_000, newTrack: false })

  // ── A pause carries the position with it ──────────────────────────────────
  // The same lie by a second route: the play/pause effect re-sent the object
  // the track was born with, so pausing also sent the bar to zero.
  //
  // Played first, deliberately: the effect is keyed on `isPlaying`, so pausing
  // something already paused runs nothing and this would assert against the
  // seek's update instead — passing without exercising the path it names.
  //
  // The status store is set by hand because this harness has no audio: on a
  // device the deck reports where it is about twice a second, and a pause
  // publishes *that*, not the position the track was seeked to. Leaving it at
  // the mock's standing 0 would assert the opposite of the fix.
  await act(async () => {
    usePlaybackStatus.setState({ position: 55 })
    usePlayer.getState().setPlaying(true)
  })
  await act(async () => {
    usePlayer.getState().setPlaying(false)
  })
  expect(lastUpdate()).toMatchObject({ positionMs: 55_000, playing: false, newTrack: false })
})
