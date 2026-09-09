import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react-native'
import { Profiler, type ReactNode } from 'react'

import { MiniPlayer } from '../src/components/MiniPlayer'
import { resetPlaybackStatus, usePlaybackStatus } from '../src/player/playbackStatus'
import { usePlayer } from '../src/player/store'
import type { Song } from '../src/api/types'
import '../src/i18n'

/**
 * What a progress tick actually costs, in commits (#342 / #368).
 *
 * ## Why this is a test and not a note
 *
 * #342 is filed as *investigate, do not fix from a hypothesis*, and lists
 * "twice-a-second publishing" among its leads. A lead is not a finding. This
 * turns it into a number that a change can be measured against — the issue's
 * own "done when" asks for a before/after, not for "it feels better".
 *
 * **What this measures is React commits, not dropped frames.** Only a device
 * can say whether the user feels this (#368). A commit count is still worth
 * pinning, because it is the half that can regress silently: nothing else in
 * the suite would notice a new subscriber waking the bar on every tick.
 *
 * ## Why the mini player specifically
 *
 * It is mounted by the tab navigator, so it is on screen for **every** tab —
 * library, playlists, add, settings — for the whole time anything is playing.
 * Whatever it costs per tick, it costs everywhere, forever. The playing panel
 * has the same subscription and is one screen the user is looking at
 * deliberately; this one is ambient.
 */

jest.mock('expo-router', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn() }),
}))

const mockFavouriteIds = jest.fn()
jest.mock('../src/api/localPlaylists', () => ({
  useLocalFavouriteIds: () => mockFavouriteIds(),
  useSetLocalFavourite: () => ({ mutate: jest.fn() }),
}))

const SONG: Song = {
  id: 7,
  title: 'Keeps Playing',
  artist: 'The Testers',
  album: 'Across Navigation',
  duration: 180,
  source_url: 'https://example.com/7',
  source_platform: 'youtube',
  added_at: '2026-07-25T00:00:00Z',
  loudness_lufs: null,
  peak_dbfs: null,
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(async () => {
  jest.clearAllMocks()
  mockFavouriteIds.mockReturnValue({ data: new Set<string>() })
  await act(async () => {
    resetPlaybackStatus()
    usePlayer.setState({
      current: { source: 'context', song: SONG },
      contextQueue: [SONG],
      contextOrder: [0],
      contextIndex: 0,
      history: [],
      userQueue: [],
      isPlaying: true,
    })
  })
})

/**
 * Render the bar under a Profiler and return a live commit count.
 *
 * The baseline is taken **after a settling tick**, not straight after `render`.
 * Mounting commits again on its own — the favourites query resolves a
 * microtask later — and counting from before that made every number one too
 * high. The first version of this test asserted the wrong figures and the code
 * was right, which is the ordinary way a measurement lies.
 */
async function mountCounting() {
  let commits = 0
  await act(async () => {
    render(
      <Profiler id="bar" onRender={() => (commits += 1)}>
        <MiniPlayer />
      </Profiler>,
      { wrapper },
    )
  })
  // Put the bar at a known position and let everything settle.
  await act(async () => {
    usePlaybackStatus.getState().setStatus(status({ position: 1 }))
  })
  const initial = commits
  return { since: () => commits - initial }
}

/** One status tick, as `PlayerHost` publishes them. */
async function tick(position: number, overrides: Partial<Parameters<typeof status>[0]> = {}) {
  await act(async () => {
    usePlaybackStatus.getState().setStatus(status({ position, ...overrides }))
  })
}

const status = (
  overrides: Partial<{
    position: number
    duration: number
    isBuffering: boolean
    error: string | null
  }>,
) => ({
  position: 0,
  duration: 180,
  isBuffering: false,
  error: null,
  ...overrides,
})

describe('what a progress tick costs the mini player', () => {
  it('commits once per tick while playing', async () => {
    const counter = await mountCounting()

    // Ten ticks is five seconds of playback at the status rate.
    for (let i = 1; i <= 10; i++) await tick(i * 0.5)

    /*
     * The number this pins, and why it is not zero.
     *
     * The bar draws a progress line, so it genuinely has to repaint as the
     * position moves — one commit per tick is the honest floor for a component
     * that shows progress at all. What is worth watching is that it stays *one*:
     * a second subscription added carelessly, or a selector returning a fresh
     * object, would make it two or three and nothing would say so.
     */
    expect(counter.since()).toBe(10)
  })

  it('costs nothing while paused', async () => {
    const counter = await mountCounting()

    // A paused player still ticks; the position simply does not move. The
    // baseline already sat at 1, so every one of these is a no-op — the first
    // version of this test moved the position on its first tick and then
    // asserted the result was free, which it should not have been.
    for (let i = 0; i < 10; i++) await tick(1)

    /*
     * Zero, not "cheap" — and **not for the reason the store's docblock gives**.
     *
     * `setStatus` returns the previous state when nothing moved, and that reads
     * like the mechanism protecting this. It is not: deleting that check
     * entirely leaves this number at zero, because Zustand bails out **per
     * selector** with `Object.is`, and each selector here returns an unchanged
     * primitive. The store-level check only matters to a subscriber that selects
     * the whole object — see the test below, which is what actually covers it.
     *
     * Found by mutating the store and watching this test not care. A surviving
     * mutation usually means the scenario is wrong; here it meant the *credit*
     * was wrong, which is the same fault one level up.
     */
    expect(counter.since()).toBe(0)
  })

  it('does not wake on a field it does not use changing', async () => {
    const counter = await mountCounting()
    await tick(5)
    expect(counter.since()).toBe(1)

    // Same position, same everything the bar reads. Nothing should follow.
    await tick(5)

    expect(counter.since()).toBe(1)
  })
})

/**
 * The store's own bail-out, tested where it lives.
 *
 * `setStatus` returning the previous state on a no-op tick is a real guard, and
 * the mini player cannot demonstrate it — per-selector equality already covers
 * that case, so the check could be deleted without the bar noticing. What it
 * protects is any subscriber selecting the **whole object**, which gets a new
 * identity on every tick otherwise and re-renders twice a second forever.
 *
 * Nothing selects the whole object today. This keeps the guard honest anyway,
 * because the next person to write `usePlaybackStatus((s) => s)` will not read
 * the docblock first.
 */
describe('the status store itself', () => {
  it('returns the very same state when a tick moved nothing', () => {
    usePlaybackStatus.getState().setStatus(status({ position: 4 }))
    const before = usePlaybackStatus.getState()

    usePlaybackStatus.getState().setStatus(status({ position: 4 }))

    // Reference equality, not deep equality: identity is the whole point — it
    // is what a whole-object selector compares.
    expect(usePlaybackStatus.getState()).toBe(before)
  })

  it('publishes a new state when the position moves', () => {
    usePlaybackStatus.getState().setStatus(status({ position: 4 }))
    const before = usePlaybackStatus.getState()

    usePlaybackStatus.getState().setStatus(status({ position: 5 }))

    expect(usePlaybackStatus.getState()).not.toBe(before)
  })

  it('publishes when only buffering changed, which no position check would catch', () => {
    usePlaybackStatus.getState().setStatus(status({ position: 4 }))
    const before = usePlaybackStatus.getState()

    usePlaybackStatus.getState().setStatus(status({ position: 4, isBuffering: true }))

    expect(usePlaybackStatus.getState()).not.toBe(before)
  })
})
