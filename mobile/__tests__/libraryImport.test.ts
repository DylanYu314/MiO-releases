import { File } from 'expo-file-system'

import { LIBRARY_EXPORT_FORMAT, LIBRARY_EXPORT_VERSION } from '../src/library/libraryExport'
import {
  LibraryImportError,
  parseLibraryExport,
  pickLibraryFile,
  planPlaylistRestore,
  summarise,
  urlsToFetch,
} from '../src/library/libraryImport'

/**
 * Reading a library file written by another phone (#729).
 *
 * ⛔ The stakes are why these are thorough: the step after this one downloads
 * hundreds of tracks, so a parser that trusts its input turns a wrong file into
 * an hour of downloading and a corrupted library.
 */

const file = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: LIBRARY_EXPORT_FORMAT,
    version: LIBRARY_EXPORT_VERSION,
    exported_at: '2026-09-08T12:00:00.000Z',
    songs: [
      {
        source_url: 'https://youtu.be/a',
        source_platform: 'youtube',
        title: 'A',
        artist: 'Band',
        album: null,
        duration: 100,
      },
    ],
    playlists: [],
    skipped_local: 0,
    ...over,
  })

const rejection = (text: string) => {
  try {
    parseLibraryExport(text)
  } catch (error) {
    if (error instanceof LibraryImportError) return error.rejection
    throw error
  }
  throw new Error('expected the file to be rejected, and it was accepted')
}

describe('reading a library file', () => {
  it('accepts one this app wrote', () => {
    const document = parseLibraryExport(file())

    expect(document.songs).toHaveLength(1)
    expect(document.songs[0].source_url).toBe('https://youtu.be/a')
    expect(document.exported_at).toBe('2026-09-08T12:00:00.000Z')
  })

  it('refuses something that is not JSON at all', () => {
    expect(rejection('not json {{{')).toEqual({ reason: 'not-json' })
  })

  it('refuses valid JSON that is not a library', () => {
    // ⚠️ The likeliest wrong file by far: some other `.json` on the phone. The
    // extension carries no information, so the body has to.
    expect(rejection(JSON.stringify({ hello: 'world' }))).toEqual({ reason: 'not-a-library' })
    expect(rejection(JSON.stringify([1, 2, 3]))).toEqual({ reason: 'not-a-library' })
  })

  it('refuses a file from a newer MiO rather than half-reading it', () => {
    /*
     * ⛔ This is the version field's whole purpose. It is bumped only when an
     * older reader cannot read the file, so attempting one anyway is exactly
     * the mistake it exists to prevent.
     */
    expect(rejection(file({ version: LIBRARY_EXPORT_VERSION + 1 }))).toEqual({
      reason: 'too-new',
      version: LIBRARY_EXPORT_VERSION + 1,
    })
  })

  it('accepts unknown extra fields, so adding one is not a breaking change', () => {
    const document = parseLibraryExport(file({ somethingNew: { nested: true } }))

    expect(document.songs).toHaveLength(1)
  })

  it('refuses a file with no usable songs', () => {
    expect(rejection(file({ songs: [] }))).toEqual({ reason: 'empty' })
    expect(rejection(file({ songs: [{ title: 'no url' }, 'nonsense', null] }))).toEqual({
      reason: 'empty',
    })
  })

  it('drops local files, which this device cannot fetch either', () => {
    // The exporter filters them, so one here means a hand-edited or future
    // file. Importing it would put a permanently broken song in the library.
    const document = parseLibraryExport(
      file({
        songs: [{ source_url: 'https://youtu.be/a' }, { source_url: 'local:d41d8cd98f00b204' }],
      }),
    )

    expect(urlsToFetch(document)).toEqual(['https://youtu.be/a'])
  })

  it('drops duplicate urls, which the schema would refuse mid-run', () => {
    // `source_url` is UNIQUE since v6, so a duplicate is not merely wasteful —
    // it fails partway through, after some tracks have already downloaded.
    const document = parseLibraryExport(
      file({
        songs: [
          { source_url: 'https://youtu.be/a' },
          { source_url: 'https://youtu.be/a' },
          { source_url: 'https://youtu.be/b' },
        ],
      }),
    )

    expect(urlsToFetch(document)).toEqual(['https://youtu.be/a', 'https://youtu.be/b'])
  })

  it('fills in what a song is missing rather than losing the track', () => {
    // Titles are cosmetic: the download re-reads real metadata from the source,
    // so a missing one costs a placeholder, not the song.
    const document = parseLibraryExport(file({ songs: [{ source_url: 'https://youtu.be/a' }] }))

    expect(document.songs[0]).toEqual({
      source_url: 'https://youtu.be/a',
      source_platform: 'unknown',
      title: '',
      artist: '',
      album: null,
      duration: null,
    })
  })

  it('keeps the file order, because a resumed run depends on it', () => {
    const document = parseLibraryExport(
      file({
        songs: [
          { source_url: 'https://youtu.be/c' },
          { source_url: 'https://youtu.be/a' },
          { source_url: 'https://youtu.be/b' },
        ],
      }),
    )

    expect(urlsToFetch(document)).toEqual([
      'https://youtu.be/c',
      'https://youtu.be/a',
      'https://youtu.be/b',
    ])
  })
})

describe('playlists in a library file', () => {
  it('keeps only entries whose song the file actually carries', () => {
    // ⚠️ An entry naming a song that is not in `songs` becomes a position
    // pointing at nothing — a hole no later step reports.
    const document = parseLibraryExport(
      file({
        songs: [{ source_url: 'https://youtu.be/a' }],
        playlists: [
          { name: 'Mixed', kind: 'user', songs: ['https://youtu.be/a', 'https://youtu.be/gone'] },
        ],
      }),
    )

    expect(document.playlists[0].songs).toEqual(['https://youtu.be/a'])
  })

  it('drops a playlist with no name, and keeps the rest', () => {
    const document = parseLibraryExport(
      file({
        playlists: [{ kind: 'user', songs: [] }, { name: 'Real', kind: 'user', songs: [] }, 7],
      }),
    )

    expect(document.playlists.map((p) => p.name)).toEqual(['Real'])
  })

  it('survives playlists being absent entirely', () => {
    const document = parseLibraryExport(file({ playlists: undefined }))

    expect(document.playlists).toEqual([])
  })
})

describe('summarise', () => {
  it('does not count favourites as a playlist about to appear', () => {
    // It is a playlist row, and it already exists on this device — restored
    // into, never created. Counting it would overstate what the user will see.
    const document = parseLibraryExport(
      file({
        playlists: [
          { name: 'Favourites', kind: 'favourites', songs: [] },
          { name: 'Mine', kind: 'user', songs: [] },
        ],
      }),
    )

    expect(summarise(document)).toEqual({
      songCount: 1,
      playlistCount: 1,
      exportedAt: '2026-09-08T12:00:00.000Z',
    })
  })
})

describe('planning a playlist restore', () => {
  const ids = new Map([
    ['https://youtu.be/a', 'id-a'],
    ['https://youtu.be/b', 'id-b'],
  ])

  it('keeps the file order, not the order the songs downloaded in', () => {
    const [plan] = planPlaylistRestore(
      [{ name: 'Mine', kind: 'user', songs: ['https://youtu.be/b', 'https://youtu.be/a'] }],
      ids,
    )

    expect(plan.songIds).toEqual(['id-b', 'id-a'])
  })

  it('builds the playlist from what arrived, rather than abandoning it', () => {
    /*
     * ⚠️ A restore that refused to rebuild a 200-track playlist because two
     * tracks were region-locked would be worse than one with 198 in it — the
     * same reasoning as "a track's failure is a track's failure" (#369).
     */
    const [plan] = planPlaylistRestore(
      [
        {
          name: 'Mine',
          kind: 'user',
          songs: ['https://youtu.be/a', 'https://youtu.be/missing', 'https://youtu.be/b'],
        },
      ],
      ids,
    )

    expect(plan.songIds).toEqual(['id-a', 'id-b'])
  })

  it('marks favourites as restored into, never created', () => {
    const plans = planPlaylistRestore(
      [
        { name: 'Favourites', kind: 'favourites', songs: ['https://youtu.be/a'] },
        { name: 'Mine', kind: 'user', songs: ['https://youtu.be/b'] },
      ],
      ids,
    )

    expect(plans.map((p) => p.intoFavourites)).toEqual([true, false])
  })

  it('skips a playlist nothing arrived for', () => {
    // An empty playlist would leave the user tidying up after a restore that
    // looked like it worked.
    const plans = planPlaylistRestore(
      [{ name: 'All gone', kind: 'user', songs: ['https://youtu.be/missing'] }],
      ids,
    )

    expect(plans).toEqual([])
  })
})

describe('picking a library file', () => {
  afterEach(() => jest.restoreAllMocks())

  const pickReturning = (value: unknown) =>
    jest.spyOn(File, 'pickFileAsync').mockResolvedValue(value as never)

  it("reads the file out of the picker's result object", async () => {
    /*
     * ⛔ The regression this exists for. `pickFileAsync` resolves to
     * `{ result, canceled }`, **not** to a `File`. Treating the return value as
     * the file itself made `.text()` not a function, and the TypeError was
     * swallowed by a catch that assumed any non-LibraryImportError was a
     * cancelled picker — so choosing a file did visibly nothing.
     *
     * Asserted against the shape the dependency documents, so a wrong
     * assumption about it fails here rather than on a device.
     */
    pickReturning({ canceled: false, result: { text: async () => file() } })

    const document = await pickLibraryFile()

    expect(document?.songs).toHaveLength(1)
  })

  it('returns null when the picker was cancelled, which is not a failure', async () => {
    // The caller reports anything else out loud, so a cancel has to be
    // distinguishable — that is what stopped the bug above being visible.
    pickReturning({ canceled: true, result: null })

    expect(await pickLibraryFile()).toBeNull()
  })

  it('still rejects a wrong file picked successfully', async () => {
    pickReturning({ canceled: false, result: { text: async () => '{"hello":"world"}' } })

    await expect(pickLibraryFile()).rejects.toBeInstanceOf(LibraryImportError)
  })
})
