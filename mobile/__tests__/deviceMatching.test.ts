import type { DatabaseSync } from 'node:sqlite'

import { __resetLibraryTransactions } from '../src/library/db'
import { supplyCandidates } from '../src/library/deviceMatching'
import {
  addTracks,
  createImport,
  getImport,
  listMatches,
  setMatchStatus,
  updateImport,
  type TrackToMatch,
} from '../src/library/playlistImports'
import { useSearchSource } from '../src/library/searchSource'
import { freshLibraryDb } from '../src/test/localDb'

/**
 * Finding each track on YouTube, from the phone (#353), and **scoring it here**
 * (#609/#611).
 *
 * ## What changed
 *
 * This used to cover a seam: the phone searched and posted, the server scored.
 * Since #608 there is no server in the product, so `matching.ts` scores and
 * these rows are written straight to the library. Three of the old tests were
 * about the shape of a POST that no longer happens and are gone; what replaced
 * them is what the POST used to buy — that a refusal keeps the work already
 * done, and that an unsearchable track settles rather than staying pending.
 *
 * ⚠️ The scorer itself is **not** covered here. `matchingGolden.test.ts` pins it
 * against `shared/matching-golden.json` in both languages; duplicating that
 * would be a second, weaker opinion about the same numbers.
 */

// `mock`-prefixed so the hoisted `jest.mock` factory may reference it.
let mockDb: DatabaseSync
jest.mock('../src/library/db', () => {
  const actual = jest.requireActual('../src/library/db')
  // ⚠️ `requireActual` inside the factory: it may not reference an out-of-scope
  // binding, and only `mock`-prefixed names are exempt.
  const { sqliteAdapter } = jest.requireActual('../src/test/localDb')
  return { ...actual, openLibraryDb: async () => sqliteAdapter(() => mockDb) }
})

const mockSearch = jest.fn()
jest.mock('../src/library/deviceSearch', () => ({
  searchOnDeviceQuietly: (...args: unknown[]) => mockSearch(...args),
}))

/** An import at `matching` with the given tracks, as a fetcher would leave it. */
async function seedImport(tracks: TrackToMatch[]): Promise<string> {
  const id = await createImport({
    service: 'spotify',
    externalPlaylistId: 'p1',
    name: 'A playlist',
  })
  await addTracks(id, tracks)
  await updateImport(id, { status: 'matching' })
  return id
}

function track(title: string, artist = 'New Order'): TrackToMatch {
  return { title, artist, duration_s: 200 }
}

/** A candidate that will score well against `track(title)` above. */
function goodResult(title: string, artist = 'New Order') {
  return {
    url: `https://y/${title}`,
    title: `${artist} - ${title}`,
    uploader: artist,
    duration: 200,
  }
}

beforeEach(() => {
  __resetLibraryTransactions()
  mockDb = freshLibraryDb()
  mockSearch.mockReset().mockResolvedValue([goodResult('Ceremony')])
  useSearchSource.setState({ source: 'youtube' })
})

describe('the candidate source (#551)', () => {
  it('stamps every stored candidate with the source it was found on', async () => {
    // The half that is easy to leave out and impossible to see: without it a
    // Bilibili candidate collects the +0.05 Topic bonus only a YouTube uploader
    // can earn (ADR-013 decision 4). Nothing on screen would say so — the
    // matches would just be a bit wrong.
    useSearchSource.setState({ source: 'bilibili' })
    const id = await seedImport([track('Ceremony')])

    await supplyCandidates(id)

    const [match] = await listMatches(id)
    expect(match.candidates.map((candidate) => candidate.source)).toEqual(['bilibili'])
  })

  it('reads the source once per run, not once per track', async () => {
    // A user flipping the toggle during a hundred-track import must not produce
    // a run whose candidates disagree about where they came from.
    const id = await seedImport([track('Ceremony'), track('Temptation')])
    mockSearch.mockImplementation(async () => {
      useSearchSource.setState({ source: 'bilibili' })
      return [goodResult('Ceremony')]
    })

    await supplyCandidates(id)

    const matches = await listMatches(id)
    expect(matches.flatMap((m) => m.candidates.map((c) => c.source))).toEqual([
      'youtube',
      'youtube',
    ])
  })

  it('passes the source down to the search itself', async () => {
    useSearchSource.setState({ source: 'bilibili' })
    const id = await seedImport([track('Ceremony')])

    await supplyCandidates(id)

    expect(mockSearch).toHaveBeenCalledWith('New Order Ceremony', 5, 'bilibili')
  })
})

describe('the search query', () => {
  /**
   * ⚠️ This used to assert a local `searchQueryFor`, and it passed against the
   * bug (#618): the fixture had no comma in it, so it could not tell the
   * server's builder (which drops everything after the first comma) from the
   * device's copy (which did not). The artist below is the whole point.
   */
  it('is trimmed to the primary artist', async () => {
    const id = await seedImport([track('Levitating', 'Dua Lipa, DaBaby')])

    await supplyCandidates(id)

    expect(mockSearch).toHaveBeenCalledWith('Dua Lipa Levitating', 5, 'youtube')
  })
})

describe('supplying candidates', () => {
  it('searches each pending track and stores what it found', async () => {
    const id = await seedImport([track('Ceremony'), track('Temptation')])

    await supplyCandidates(id)

    expect(mockSearch).toHaveBeenCalledWith('New Order Ceremony', 5, 'youtube')
    expect(mockSearch).toHaveBeenCalledWith('New Order Temptation', 5, 'youtube')
    const matches = await listMatches(id)
    expect(matches.every((m) => m.candidates.length === 1)).toBe(true)
  })

  /**
   * ⚠️ The scoring is what #609 moved here, and this is the wiring test for it.
   *
   * A candidate that is the same song scores over `AUTO_THRESHOLD` and is
   * pre-chosen; one that is nothing like it falls under `REVIEW_THRESHOLD` and
   * settles as `no_match`. If `classify` were never called, both would stay
   * `pending` and the import would never reach review.
   */
  it('scores on the device and settles each row accordingly', async () => {
    const id = await seedImport([track('Ceremony'), track('Temptation')])
    mockSearch.mockResolvedValueOnce([goodResult('Ceremony')]).mockResolvedValueOnce([
      {
        url: 'https://y/x',
        title: 'Entirely Unrelated Upload',
        uploader: 'Nobody',
        duration: 12,
      },
    ])

    await supplyCandidates(id)

    const [first, second] = await listMatches(id)
    expect(first.status).toBe('auto_matched')
    expect(first.chosen_url).toBe('https://y/Ceremony')
    expect(first.confidence).toBeGreaterThan(0.8)
    expect(second.status).toBe('no_match')
    expect(second.chosen_url).toBeNull()
  })

  it('reads what is pending from the library rather than remembering', async () => {
    // What makes an interrupted run resumable: after the app is killed the
    // phone's idea of what is left is gone, and the rows are the truth.
    const id = await seedImport([track('Ceremony'), track('Temptation')])
    const [already] = await listMatches(id)
    await setMatchStatus(already.id, 'accepted')

    await supplyCandidates(id)

    expect(mockSearch).toHaveBeenCalledTimes(1)
    expect(mockSearch).toHaveBeenCalledWith('New Order Temptation', 5, 'youtube')
  })

  it('settles a track it could not search rather than leaving it pending', async () => {
    // An empty list is meaningful — it is what marks the row `no_match`.
    // Leaving it pending would mean the import never reaches review.
    mockSearch.mockResolvedValue([])
    const id = await seedImport([track('Ceremony')])

    await supplyCandidates(id)

    const [match] = await listMatches(id)
    expect(match.status).toBe('no_match')
    expect(match.candidates).toEqual([])
  })

  it('reports progress per track', async () => {
    const seen: string[] = []
    const id = await seedImport([track('A'), track('B'), track('C')])

    await supplyCandidates(id, {
      onProgress: (progress) => seen.push(`${progress.current}/${progress.total}`),
    })

    expect(seen).toEqual(['1/3', '2/3', '3/3'])
  })

  it('moves the import to review once nothing is pending', async () => {
    const id = await seedImport([track('Ceremony')])

    const result = await supplyCandidates(id)

    expect(result).toMatchObject({ status: 'review' })
    expect((await getImport(id))?.status).toBe('review')
  })

  /**
   * ⚠️ Regression, found by `youtubeImport.test.tsx` (#611).
   *
   * "Nothing is pending" is trivially true of an import with **no rows at
   * all** — one whose fetch has not written them yet. Advancing on that alone
   * flipped a fetching import straight to `review`, and writing the counter
   * from an empty table reset `matched_count` to 0, so a screen showing
   * "12 of 40" dropped to "0 of 40".
   */
  it('leaves an import with no tracks alone rather than declaring it reviewable', async () => {
    const id = await createImport({
      service: 'youtube',
      externalPlaylistId: 'https://youtube.com/playlist?list=PL1',
      name: 'Still fetching',
    })
    await updateImport(id, { status: 'matching', track_count: 40, matched_count: 12 })

    await supplyCandidates(id)

    const after = await getImport(id)
    expect(after?.status).toBe('matching')
    expect(after?.matched_count).toBe(12)
  })

  it('searches nothing when nothing is pending', async () => {
    const id = await seedImport([])

    await supplyCandidates(id)

    expect(mockSearch).not.toHaveBeenCalled()
  })

  it('handles a playlist longer than any old batch size', async () => {
    // The batching this replaced ran ten at a time; nothing should now depend
    // on that number, and a run must not stop at it.
    const id = await seedImport(Array.from({ length: 25 }, (_, i) => track(`Song ${i}`)))

    await supplyCandidates(id)

    expect(mockSearch).toHaveBeenCalledTimes(25)
  })
})

describe('when the source refuses this address (#586)', () => {
  /*
   * From my server-side log, 2026-08-17: two bursts of
   * `search.failed: Bilibili search refused: HTTP 412`, one a second, every
   * request refused, for at least 35 seconds.
   *
   * The pacing was working. What was missing was a response to the refusal:
   * `searchOnDeviceQuietly` swallowed it, the loop filed the track as having no
   * candidate, and moved on a second later into the same wall — consuming a
   * whole playlist as failures that had nothing to do with the tracks.
   */
  const refusal = () => {
    const error = new Error('Bilibili search refused: HTTP 412')
    error.name = 'SearchRefused'
    return error
  }

  it('stops instead of spending the rest of the playlist on it', async () => {
    const id = await seedImport([track('A'), track('B'), track('C')])
    mockSearch.mockResolvedValueOnce([]).mockRejectedValue(refusal())

    await expect(supplyCandidates(id)).rejects.toThrow(/412/)

    // Track 1 searched, track 2 refused, track 3 never attempted. Without this
    // the loop asked for all three and filed two of them as `no_match`.
    expect(mockSearch).toHaveBeenCalledTimes(2)
  })

  it('keeps what it already searched rather than redoing it after the wait', async () => {
    /*
     * The refusal lasts about fifteen minutes and each search costs a second,
     * so throwing away part-finished work is not free.
     *
     * ⚠️ This is the one thing the local version does strictly better than the
     * batched POST it replaced: rows settle one at a time as they are scored,
     * so there is no half-batch to lose.
     */
    const id = await seedImport([track('A'), track('B'), track('C')])
    mockSearch.mockResolvedValueOnce([goodResult('A', 'New Order')]).mockRejectedValue(refusal())

    await expect(supplyCandidates(id)).rejects.toThrow()

    const matches = await listMatches(id)
    expect(matches[0].status).not.toBe('pending')
    expect(matches[1].status).toBe('pending')
    expect(matches[2].status).toBe('pending')
  })

  it('leaves the import at matching so the resumed run picks it up', async () => {
    // Moving it to `review` would offer a review of a half-searched playlist,
    // and nothing would ever search the rest.
    const id = await seedImport([track('A'), track('B')])
    mockSearch.mockRejectedValue(refusal())

    await expect(supplyCandidates(id)).rejects.toThrow()

    expect((await getImport(id))?.status).toBe('matching')
  })

  it('settles nothing when the very first track is refused', async () => {
    const id = await seedImport([track('A'), track('B')])
    mockSearch.mockRejectedValue(refusal())

    await expect(supplyCandidates(id)).rejects.toThrow()

    const matches = await listMatches(id)
    expect(matches.every((m) => m.status === 'pending')).toBe(true)
  })

  it('leaves an ordinary search failure alone', async () => {
    // The contract that must survive: one track nobody can find is `no_match`,
    // and the run carries on. Only a refusal of the *source* stops it.
    const id = await seedImport([track('A'), track('B')])
    mockSearch.mockResolvedValue([])

    await expect(supplyCandidates(id)).resolves.toBeDefined()

    expect(mockSearch).toHaveBeenCalledTimes(2)
    expect((await getImport(id))?.status).toBe('review')
  })
})
