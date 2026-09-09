import { sourcesWithAudioIn } from '../src/api/localLibrary'
import type { LocalSong } from '../src/library/songs'

/**
 * Which sources the library actually holds (#376).
 *
 * The search page asks this to decide whether a result reads "Add" or "Added".
 * Kept a pure function over the rows rather than a query of its own, because
 * every path that adds a song already invalidates the library read — a second
 * cache key would be a second thing each of them had to remember.
 */

function song(overrides: Partial<LocalSong>): LocalSong {
  return {
    id: 'l1',
    source_url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    title: 'A song',
    artist: 'Someone',
    file_uri: 'file:///music/l1.opus',
    ...overrides,
  } as LocalSong
}

describe('sourcesWithAudioIn', () => {
  it('holds a source whose audio is on disk', () => {
    const sources = sourcesWithAudioIn([song({ source_url: 'https://x/1' })])

    expect(sources.has('https://x/1')).toBe(true)
  })

  it('leaves out a row whose download never finished', () => {
    // The same test `sourcesWithAudio` applies in SQL and `isPlayable` means: a
    // row with no file is a promise the library cannot keep (#309), and calling
    // it added would leave the song that needs retrying the one that cannot be.
    const sources = sourcesWithAudioIn([song({ source_url: 'https://x/1', file_uri: null })])

    expect(sources.has('https://x/1')).toBe(false)
    expect(sources.size).toBe(0)
  })

  it('holds each source once, however many rows there are', () => {
    const sources = sourcesWithAudioIn([
      song({ id: 'a', source_url: 'https://x/1' }),
      song({ id: 'b', source_url: 'https://x/2' }),
    ])

    expect(sources.size).toBe(2)
  })

  it('is empty for an empty library rather than throwing', () => {
    expect(sourcesWithAudioIn([]).size).toBe(0)
  })
})
