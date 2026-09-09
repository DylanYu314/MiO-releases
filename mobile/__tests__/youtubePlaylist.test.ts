import fixture from './fixtures/youtubePlaylistItems.json'

import { ExternalPlaylistTruncated, ExternalSourceRefused } from '../src/library/externalPlaylist'
import {
  NotAYouTubePlaylist,
  claimedTotalFrom,
  durationFrom,
  fetchYouTubePlaylist,
  parsePlaylistItem,
  playlistIdFrom,
} from '../src/library/youtubePlaylist'

/**
 * Listing a YouTube playlist on the device (#622).
 *
 * ⚠️ **The item fixture is real, captured from the live API on 2026-08-19**, and
 * that is load-bearing rather than thorough. YouTube has replaced the classic
 * `playlistVideoRenderer` with `lockupViewModel` — measured across five clients
 * — so a hand-written fixture in the documented shape would have made this
 * suite pass against a parser that finds nothing on a real playlist. That is
 * the #493 trap: a fixture chosen to exercise the interesting path can miss the
 * one that actually runs.
 */

const mockGetPlaylist = jest.fn()
jest.mock('../src/library/extract', () => ({
  youtubeClient: async () => ({ getPlaylist: (...args: unknown[]) => mockGetPlaylist(...args) }),
}))
jest.mock('../src/diagnostics/log', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
  describeError: (error: Error) => error.message,
}))

/** One page of results, in the shape `youtubei.js` returns. */
function page(items: unknown[], info: Record<string, unknown> = {}, continuation?: unknown) {
  return {
    info: {
      title: 'Top Trending Videos of the Week',
      total_items: `${items.length} videos`,
      ...info,
    },
    items,
    has_continuation: continuation !== undefined,
    getContinuation: async () => continuation,
  }
}

beforeEach(() => mockGetPlaylist.mockReset())

describe('reading a playlist link', () => {
  it('takes the id out of a URL', () => {
    expect(playlistIdFrom('https://www.youtube.com/playlist?list=PLabc-123')).toBe('PLabc-123')
    expect(playlistIdFrom('https://m.youtube.com/watch?v=x&list=OLAK5uy_abc')).toBe('OLAK5uy_abc')
  })

  it('takes a bare id, which is what a user copies (#564)', () => {
    expect(playlistIdFrom('PLOzDu-MXXLliO9fBNZOQTBDddoA3FzZUo')).toBe(
      'PLOzDu-MXXLliO9fBNZOQTBDddoA3FzZUo',
    )
    // A channel's uploads and an album are playlists too.
    expect(playlistIdFrom('UU0fiLCwTmAukotCXYnqfj0A')).toBe('UU0fiLCwTmAukotCXYnqfj0A')
  })

  it('refuses something that is not one', () => {
    expect(() => playlistIdFrom('https://example.com/nope')).toThrow(NotAYouTubePlaylist)
    expect(() => playlistIdFrom('   ')).toThrow(NotAYouTubePlaylist)
    // A bare *video* id is not a playlist, and quietly treating it as one would
    // send the user to an empty import.
    expect(() => playlistIdFrom('dQw4w9WgXcQ')).toThrow(NotAYouTubePlaylist)
  })
})

describe('the numbers YouTube reports as prose', () => {
  it('reads a total written as text', () => {
    // ⚠️ `total_items` is `"960 videos"`, not `960`. Measured.
    expect(claimedTotalFrom('960 videos')).toBe(960)
    expect(claimedTotalFrom('1,024 videos')).toBe(1024)
    expect(claimedTotalFrom(12)).toBe(12)
    expect(claimedTotalFrom(undefined)).toBeNull()
    expect(claimedTotalFrom('no idea')).toBeNull()
  })

  it('reads a duration', () => {
    expect(durationFrom('3:15')).toBe(195)
    expect(durationFrom('1:02:03')).toBe(3723)
    expect(durationFrom('0:07')).toBe(7)
    expect(durationFrom('LIVE')).toBeNull()
    expect(durationFrom(undefined)).toBeNull()
  })
})

describe('mapping a real entry', () => {
  const items = fixture.items as unknown[]

  it('has real captured data to work with', () => {
    // A control. Every assertion below indexes into the fixture, so an empty or
    // hand-rewritten one would make them vacuous.
    expect(items.length).toBeGreaterThan(0)
    expect(JSON.stringify(items[0])).toContain('LockupView')
  })

  it('reads the video id, title, uploader and duration off a LockupView', () => {
    const track = parsePlaylistItem(items[0])

    expect(track).not.toBeNull()
    expect(track?.videoId).toMatch(/^[\w-]{11}$/)
    expect(track?.title).toBeTruthy()
    expect(track?.uploader).toBeTruthy()
    // Durations are on these rows; a row without one is allowed to be null, so
    // this asserts the *type* rather than demanding a number of every fixture.
    expect(track?.durationSeconds === null || track!.durationSeconds! > 0).toBe(true)
  })

  it('reads the cover art, which nothing else in this path supplies (#635)', () => {
    // A playlist entry is its own candidate (ADR-010), so nothing searches for
    // it — the listing is the only chance to get artwork, and it was not taken.
    // The review row drew an empty square while a Spotify import against the
    // same source had art on every row, because *its* candidates come from
    // search.
    const track = parsePlaylistItem(items[0])

    expect(track?.thumbnail).toMatch(/^https:\/\/i\.ytimg\.com\//)
    // The largest within `MAX_THUMBNAIL_WIDTH`, which is the shared rule and
    // not one of this file's own — the fixture's widest is 336.
    expect(track?.thumbnail).toBe(
      (
        items[0] as { content_image: { image: { url: string; width: number }[] } }
      ).content_image.image
        .filter((entry) => entry.width <= 640)
        .sort((a, b) => a.width - b.width)
        .at(-1)?.url,
    )
  })

  it('applies the shared size rule rather than taking the first image', () => {
    /*
     * ⚠️ The captured fixture lists its widest image **first**, so `image[0]`
     * and "the largest within the ceiling" are the same URL there — a mutation
     * replacing one with the other survived the assertion above. That is the
     * fixture, not the code (this repo's conventions: a surviving mutation is usually the
     * scenario), so this one is ordered the other way and carries an oversized
     * entry, which is the case `thumbnailOf` exists for.
     */
    const track = parsePlaylistItem({
      content_id: 'abcdefghijk',
      metadata: { title: { text: 'Ordered small first' } },
      content_image: {
        image: [
          { url: 'https://i.ytimg.com/small.jpg', width: 168 },
          { url: 'https://i.ytimg.com/right.jpg', width: 336 },
          { url: 'https://i.ytimg.com/huge.jpg', width: 1280 },
        ],
      },
    })

    expect(track?.thumbnail).toBe('https://i.ytimg.com/right.jpg')
  })

  it('is not defeated by an entry with no image', () => {
    // Not every lockup carries one, and a missing thumbnail must cost the row
    // nothing — the same judgement `readVideo` makes in search.
    const track = parsePlaylistItem({
      content_id: 'abcdefghijk',
      metadata: { title: { text: 'No art' } },
    })

    expect(track?.thumbnail).toBeNull()
    expect(track?.title).toBe('No art')
  })

  it('maps every captured entry, not just the first', () => {
    const mapped = items.map(parsePlaylistItem)
    expect(mapped.every((track) => track !== null)).toBe(true)
    // Distinct ids: a mapper reading a fixed path could return the same row
    // three times and every other assertion here would still pass.
    expect(new Set(mapped.map((track) => track!.videoId)).size).toBe(items.length)
  })

  it('drops an entry with no id rather than inventing one', () => {
    expect(parsePlaylistItem({ metadata: { title: { text: 'Deleted video' } } })).toBeNull()
    expect(parsePlaylistItem({ content_id: '', metadata: { title: { text: 'x' } } })).toBeNull()
    expect(parsePlaylistItem(null)).toBeNull()
  })

  it('drops an entry that is not a video', () => {
    // A playlist can contain a nested playlist; importing it as a track would
    // download the wrong thing.
    expect(
      parsePlaylistItem({
        content_id: 'PLsomething',
        content_type: 'PLAYLIST',
        metadata: { title: { text: 'A nested playlist' } },
      }),
    ).toBeNull()
  })

  it('drops an entry with no title, which nothing could name in the library', () => {
    expect(parsePlaylistItem({ content_id: 'abcdefghijk', metadata: {} })).toBeNull()
  })
})

describe('reading the whole playlist', () => {
  it('returns the tracks and the playlist name', async () => {
    mockGetPlaylist.mockResolvedValue(page(fixture.items as unknown[]))

    const listing = await fetchYouTubePlaylist(
      'https://www.youtube.com/playlist?list=PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb',
    )

    expect(listing.name).toBe('Top Trending Videos of the Week')
    expect(listing.playlistId).toBe('PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb')
    expect(listing.tracks).toHaveLength((fixture.items as unknown[]).length)
  })

  it('follows continuations, because a page is a hundred entries', async () => {
    const items = fixture.items as unknown[]
    const second = page(items, { total_items: `${items.length * 2} videos` })
    mockGetPlaylist.mockResolvedValue(
      page(items, { total_items: `${items.length * 2} videos` }, second),
    )

    const listing = await fetchYouTubePlaylist('PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb')

    expect(listing.tracks).toHaveLength(items.length * 2)
  })

  /**
   * ⚠️ #585's shape. A fetch that quietly dropped entries recorded the survivors
   * as the playlist's size, and an eighteen-track import reported "4/4 done".
   */
  it('fails loudly when it read fewer than the playlist claims', async () => {
    mockGetPlaylist.mockResolvedValue(
      page(fixture.items as unknown[], { total_items: '18 videos' }),
    )

    await expect(fetchYouTubePlaylist('PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb')).rejects.toThrow(
      ExternalPlaylistTruncated,
    )
  })

  it('counts an unreadable entry towards the total rather than reporting a short read', async () => {
    // The distinction that matters: three readable plus one deleted *is* the
    // whole playlist, and refusing it would block an import over a dead row.
    const items = [...(fixture.items as unknown[]), { metadata: {} }]
    mockGetPlaylist.mockResolvedValue(page(items, { total_items: `${items.length} videos` }))

    const listing = await fetchYouTubePlaylist('PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb')

    expect(listing.tracks).toHaveLength(items.length - 1)
  })

  it('says a refusal is a refusal', async () => {
    // "This playlist is private" and "your connection dropped" ask for opposite
    // actions, so the caller has to be able to tell them apart.
    mockGetPlaylist.mockRejectedValue(new Error('playlist is private'))

    await expect(fetchYouTubePlaylist('PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb')).rejects.toThrow(
      ExternalSourceRefused,
    )
  })
})
