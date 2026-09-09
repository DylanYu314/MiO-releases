import {
  LIBRARY_EXPORT_FORMAT,
  LIBRARY_EXPORT_VERSION,
  buildLibraryExport,
  exportFileName,
  isUnfetchable,
  type PlaylistWithItems,
} from '../src/library/libraryExport'
import type { LocalSong } from '../src/library/songs'
import type { LocalPlaylistItem } from '../src/library/playlists'

/**
 * The library export document (#729).
 *
 * ⚠️ The builder is pure so these need no database and no filesystem, which is
 * what keeps them able to assert the *shape* rather than that something was
 * written.
 */

const song = (source_url: string, over: Partial<LocalSong> = {}): LocalSong =>
  ({
    id: `id-${source_url}`,
    server_song_id: null,
    title: 'A title',
    artist: 'An artist',
    album: null,
    duration: 200,
    source_url,
    source_platform: 'youtube',
    added_at: '2026-01-01T00:00:00.000Z',
    file_uri: null,
    file_size: null,
    cover_uri: null,
    ...over,
  }) as LocalSong

const playlist = (name: string, kind: string, urls: string[]): PlaylistWithItems => ({
  playlist: {
    id: `p-${name}`,
    name,
    kind,
    created_at: '',
    updated_at: '',
    item_count: urls.length,
  },
  items: urls.map((url, position) => ({
    id: `i-${url}`,
    position,
    song: song(url),
  })) as LocalPlaylistItem[],
})

const AT = '2026-09-08T12:34:56.789Z'

describe('building a library export', () => {
  it('carries what another device needs to find each song again', () => {
    const document = buildLibraryExport(
      [song('https://youtu.be/abc', { title: 'Real', artist: 'Band', album: 'LP', duration: 61 })],
      [],
      AT,
    )

    expect(document.format).toBe(LIBRARY_EXPORT_FORMAT)
    expect(document.version).toBe(LIBRARY_EXPORT_VERSION)
    expect(document.exported_at).toBe(AT)
    expect(document.songs).toEqual([
      {
        source_url: 'https://youtu.be/abc',
        source_platform: 'youtube',
        title: 'Real',
        artist: 'Band',
        album: 'LP',
        duration: 61,
      },
    ])
  })

  it('identifies songs by source_url, never by the local id', () => {
    /*
     * ⭐ The local id is minted per device (`mintLocalSongId` is random), so it
     * means nothing on the receiving phone. `source_url` is NOT NULL and UNIQUE
     * since schema v6, which is what makes it the join key.
     */
    const document = buildLibraryExport([song('https://youtu.be/abc')], [], AT)

    expect(JSON.stringify(document)).not.toContain('id-https://youtu.be/abc')
  })

  it('leaves out local files, which no other device can fetch', () => {
    const document = buildLibraryExport(
      [
        song('https://youtu.be/abc'),
        song('local:d41d8cd98f00b204'),
        song('local:0cc175b9c0f1b6a8'),
      ],
      [],
      AT,
    )

    expect(document.songs.map((s) => s.source_url)).toEqual(['https://youtu.be/abc'])
    expect(document.skipped_local).toBe(2)
  })

  it('leaves them out of playlists too, so no entry points at a missing song', () => {
    // A playlist entry naming a song the file does not carry would import as a
    // hole — worse than an honest omission, because nothing would report it.
    const document = buildLibraryExport(
      [song('https://youtu.be/abc'), song('local:d41d8cd98f00b204')],
      [playlist('Mixed', 'user', ['https://youtu.be/abc', 'local:d41d8cd98f00b204'])],
      AT,
    )

    expect(document.playlists[0].songs).toEqual(['https://youtu.be/abc'])
  })

  it('keeps playlist order, which is the only thing position means', () => {
    const document = buildLibraryExport(
      [song('https://youtu.be/a'), song('https://youtu.be/b'), song('https://youtu.be/c')],
      [
        playlist('Ordered', 'user', [
          'https://youtu.be/c',
          'https://youtu.be/a',
          'https://youtu.be/b',
        ]),
      ],
      AT,
    )

    expect(document.playlists[0].songs).toEqual([
      'https://youtu.be/c',
      'https://youtu.be/a',
      'https://youtu.be/b',
    ])
  })

  it('carries favourites without a special case, because it is a playlist row', () => {
    const document = buildLibraryExport(
      [song('https://youtu.be/abc')],
      [playlist('Favourites', 'favourites', ['https://youtu.be/abc'])],
      AT,
    )

    expect(document.playlists).toEqual([
      { name: 'Favourites', kind: 'favourites', songs: ['https://youtu.be/abc'] },
    ])
  })

  it('reports nothing skipped when nothing was skipped', () => {
    // The control: `skipped_local` must be able to be 0, or a UI that reports it
    // would always have something to say and would stop being read.
    const document = buildLibraryExport([song('https://youtu.be/abc')], [], AT)

    expect(document.skipped_local).toBe(0)
  })

  it('survives an empty library rather than producing a broken document', () => {
    const document = buildLibraryExport([], [], AT)

    expect(document.songs).toEqual([])
    expect(document.playlists).toEqual([])
    expect(document.format).toBe(LIBRARY_EXPORT_FORMAT)
  })
})

describe('isUnfetchable', () => {
  it('is true for a local file and false for every real source', () => {
    expect(isUnfetchable('local:d41d8cd98f00b204')).toBe(true)
    for (const url of [
      'https://youtu.be/abc',
      'https://www.bilibili.com/video/BV1',
      'https://music.163.com/song?id=1',
    ]) {
      expect(isUnfetchable(url)).toBe(false)
    }
  })
})

describe('exportFileName', () => {
  it('has no characters a filesystem will refuse', () => {
    // ⚠️ An ISO timestamp carries colons, which are legal in a `source_url` and
    // illegal on the storage a user is likely to pick.
    const name = exportFileName(AT)

    expect(name).toBe('mio-library-2026-09-08T12-34-56-789.json')
    expect(name).not.toContain(':')
  })

  it('sorts by date, so a folder of backups reads in order', () => {
    const names = ['2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z'].map(exportFileName)

    expect([...names].sort()).toEqual([names[1], names[0]])
  })
})
