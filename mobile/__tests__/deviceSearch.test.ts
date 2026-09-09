import { SearchRefused } from '../src/library/bilibiliSearch'
import { searchOnDevice, searchOnDeviceQuietly } from '../src/library/deviceSearch'

/**
 * Searching YouTube from the phone (#353).
 *
 * The node shapes below are **not invented**. They were taken from a live
 * Innertube search run in Node before any of this was written — an English
 * query, a CJK query, a hyphenated "Artist - Title" query and a nonsense one —
 * which is where the facts that `duration` is `{ text, seconds }` and `title`
 * is an object rather than a string came from. Fixtures made up from the type
 * definitions would have asserted the wrong thing confidently.
 */

const mockSearch = jest.fn()

jest.mock('../src/library/extract', () => ({
  youtubeClient: async () => ({ search: (...args: unknown[]) => mockSearch(...args) }),
  CLIENT_CHAIN: ['ANDROID_VR'],
}))

/** A `Video` node as the live API actually returns one. */
function videoNode(overrides: Record<string, unknown> = {}) {
  return {
    type: 'Video',
    video_id: 'kkASIx9Xk6s',
    title: { text: 'Ceremony' },
    author: { name: 'New Order' },
    duration: { text: '4:24', seconds: 264 },
    thumbnails: [{ url: 'https://i.ytimg.com/vi/kkASIx9Xk6s/hq720.jpg', width: 720, height: 404 }],
    ...overrides,
  }
}

beforeEach(() => {
  mockSearch.mockReset().mockResolvedValue({ videos: [videoNode()] })
})

describe('reading a search result', () => {
  it('reads the fields off the shapes the live API returns', async () => {
    const [result] = await searchOnDevice('ceremony')

    expect(result).toEqual({
      url: 'https://www.youtube.com/watch?v=kkASIx9Xk6s',
      title: 'Ceremony',
      uploader: 'New Order',
      duration: 264,
      thumbnail: 'https://i.ytimg.com/vi/kkASIx9Xk6s/hq720.jpg',
    })
  })

  it('builds the canonical watch URL rather than trusting a node for it', async () => {
    /*
     * This has to match what `extract.ts` and `saveDeviceSongMetadata` write as
     * `source_url`, or the same video added from search and from a pasted link
     * becomes two library rows — which is exactly the duplicate class schema v6
     * had to clean up.
     */
    const [result] = await searchOnDevice('x')
    expect(result.url).toBe('https://www.youtube.com/watch?v=kkASIx9Xk6s')
  })

  it('takes the duration from the object, not the object itself', async () => {
    // `{ text: '4:24', seconds: 264 }`. Storing the object would put an
    // unreadable duration on the row and score every match as a mismatch.
    const [result] = await searchOnDevice('x')
    expect(result.duration).toBe(264)
  })

  it.each([
    ['as an object', { seconds: 0 }],
    ['as a bare number', 0],
  ])(
    'treats a zero duration %s as unknown, which is what a live stream reports',
    async (_shape, duration) => {
      /*
       * Not zero-length audio: null is neutral in the matcher's duration score,
       * and 0 would read as a four-minute discrepancy against every candidate.
       *
       * Both forms, because a mutation survived the first version of this test:
       * it only exercised the object branch, so deleting the guard on the numeric
       * one changed nothing that any test could see.
       */
      mockSearch.mockResolvedValue({ videos: [videoNode({ duration })] })

      const [result] = await searchOnDevice('x')
      expect(result.duration).toBeNull()
    },
  )

  it('accepts plain strings and numbers too', async () => {
    // A response shape is not a promise anyone made us.
    mockSearch.mockResolvedValue({
      videos: [videoNode({ title: 'Plain', author: 'Someone', duration: 100 })],
    })

    const [result] = await searchOnDevice('x')
    expect(result).toMatchObject({ title: 'Plain', uploader: 'Someone', duration: 100 })
  })

  it('skips a node with no id or no title instead of failing the search', async () => {
    // One unusable entry must not cost the user the other results — the same
    // rule the server's search followed (#124).
    mockSearch.mockResolvedValue({
      videos: [
        videoNode({ video_id: undefined, id: undefined }),
        videoNode({ title: undefined }),
        videoNode({ video_id: 'good', title: { text: 'Good' } }),
      ],
    })

    const results = await searchOnDevice('x')
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Good')
  })
})

describe('thumbnails', () => {
  it('takes the largest within the ceiling the server also applies', async () => {
    mockSearch.mockResolvedValue({
      videos: [
        videoNode({
          thumbnails: [
            { url: 'small', width: 120 },
            { url: 'just-right', width: 480 },
            { url: 'too-big', width: 1280 },
          ],
        }),
      ],
    })

    const [result] = await searchOnDevice('x')
    expect(result.thumbnail).toBe('just-right')
  })

  it('falls back to the smallest when every option is oversized', async () => {
    // A too-large thumbnail still draws; no thumbnail is the worse answer.
    mockSearch.mockResolvedValue({
      videos: [
        videoNode({
          thumbnails: [
            { url: 'huge', width: 1920 },
            { url: 'big', width: 1280 },
          ],
        }),
      ],
    })

    const [result] = await searchOnDevice('x')
    expect(result.thumbnail).toBe('big')
  })

  it('is null when there are none', async () => {
    mockSearch.mockResolvedValue({ videos: [videoNode({ thumbnails: [] })] })

    const [result] = await searchOnDevice('x')
    expect(result.thumbnail).toBeNull()
  })
})

describe('the search itself', () => {
  it('asks for videos, not channels or playlists', async () => {
    await searchOnDevice('ceremony')

    expect(mockSearch).toHaveBeenCalledWith('ceremony', { type: 'video' })
  })

  it('trims the query and never asks for an empty one', async () => {
    expect(await searchOnDevice('   ')).toEqual([])
    expect(mockSearch).not.toHaveBeenCalled()

    await searchOnDevice('  ceremony  ')
    expect(mockSearch).toHaveBeenCalledWith('ceremony', { type: 'video' })
  })

  it('honours the limit', async () => {
    mockSearch.mockResolvedValue({
      videos: Array.from({ length: 20 }, (_, index) => videoNode({ video_id: `v${index}` })),
    })

    expect(await searchOnDevice('x', 3)).toHaveLength(3)
  })

  it('returns nothing for a query that matches nothing', async () => {
    // Measured: the live API answers with an empty list rather than throwing.
    mockSearch.mockResolvedValue({ videos: [] })

    expect(await searchOnDevice('zzzqqqxxx')).toEqual([])
  })

  it('lets a failure reach the caller, because the screen renders one', async () => {
    mockSearch.mockRejectedValue(new Error('network down'))

    await expect(searchOnDevice('x')).rejects.toThrow('network down')
  })

  it('swallows it in the quiet form, which the matcher uses', async () => {
    // One track nobody can search for degrades that row, never the run.
    mockSearch.mockRejectedValue(new Error('network down'))

    expect(await searchOnDeviceQuietly('x')).toEqual([])
  })

  it('does not swallow a refusal of the whole source (#586)', async () => {
    /*
     * The distinction the quiet form used to miss. A 412 is not a fact about
     * this track — it is a fact about the **address**, so the next track gets
     * one too. Swallowing it returned `[]`, which marks the row `no_match`, so
     * a rate limit became a playlist of "no candidate found" at one a second.
     *
     * My log for 2026-08-17 has it: two bursts, ~1/s, a 412 every time.
     */
    mockSearch.mockRejectedValue(new SearchRefused('Bilibili search refused: HTTP 412', 412))

    await expect(searchOnDeviceQuietly('x')).rejects.toThrow(/412/)
  })

  it('still swallows an ordinary failure alongside it', async () => {
    // The pair, in one file, because the value is the *difference*: a change
    // that propagated everything would pass the test above on its own.
    mockSearch.mockRejectedValue(new Error('timed out'))

    expect(await searchOnDeviceQuietly('x')).toEqual([])
  })
})
