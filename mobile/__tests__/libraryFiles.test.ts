import {
  audioFileFor,
  deleteAudio,
  ensureLibraryDirectory,
  hasAudio,
  keptExtension,
  libraryBytes,
  localAudioFileFor,
} from '../src/library/files'

/**
 * Where the audio lives on the device (#159).
 *
 * expo-file-system is native, so this drives an in-memory fake. What is worth
 * testing is not the filesystem — it is the naming, the location, and the fact
 * that deleting something absent is not an error.
 *
 * The fake classes are built **inside** the `jest.mock` factory. That is not
 * style: the factory is hoisted above every declaration in this file and may not
 * reference an outer binding, except one whose name begins with `mock`. Building
 * them inside also keeps `list()` returning instances of the very class
 * `files.ts` imports, which is what makes its `instanceof File` filter work.
 */

/** The fake disk: uri -> size in bytes. `mock`-prefixed so the factory may see it. */
const mockDisk = new Map<string, number>()
const mockDirs = new Set<string>()

jest.mock('expo-file-system', () => {
  const join = (parts: (string | { uri: string })[]) =>
    parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/')

  class File {
    uri: string
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(parts)
    }
    get exists() {
      return mockDisk.has(this.uri)
    }
    get size() {
      return mockDisk.get(this.uri) ?? null
    }
    delete() {
      mockDisk.delete(this.uri)
    }
  }

  class Directory {
    uri: string
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(parts)
    }
    get exists() {
      return mockDirs.has(this.uri)
    }
    create() {
      mockDirs.add(this.uri)
    }
    list() {
      return [...mockDisk.keys()]
        .filter((uri) => uri.startsWith(`${this.uri}/`))
        .map((uri) => new File(uri))
    }
  }

  return { File, Directory, Paths: { document: { uri: 'file:///data/app' } } }
})

beforeEach(() => {
  mockDisk.clear()
  mockDirs.clear()
})

describe('the on-device audio folder (#159)', () => {
  it('names files by song id, not by title', () => {
    // Titles contain slashes, colons and emoji, they change when metadata is
    // edited, and two songs can share one. An id needs no escaping.
    expect(audioFileFor('42').uri).toContain('42.opus')
  })

  it('keeps the library in document storage, not cache', () => {
    // A cache directory is one Android may empty for space. Correct for things
    // that can be refetched; wrong for someone's music.
    expect(audioFileFor('1').uri).toContain('/data/app')
    expect(audioFileFor('1').uri).not.toContain('cache')
  })

  it('creates the folder only when it is missing', () => {
    ensureLibraryDirectory()
    expect(mockDirs.size).toBe(1)

    // Called before every write rather than once at startup, so it has to be
    // safe to call repeatedly.
    ensureLibraryDirectory()
    expect(mockDirs.size).toBe(1)
  })

  it('reports whether a song is actually downloaded', () => {
    expect(hasAudio('7')).toBe(false)
    mockDisk.set(audioFileFor('7').uri, 1234)
    expect(hasAudio('7')).toBe(true)
  })

  it('deleting audio that is not there is not an error', () => {
    // Cleanup after a failed download is *expected* to find nothing.
    expect(() => deleteAudio('99')).not.toThrow()
  })

  it('deletes the audio when it is there', () => {
    mockDisk.set(audioFileFor('7').uri, 1234)
    deleteAudio('7')
    expect(hasAudio('7')).toBe(false)
  })

  it('measures the library from the disk, not from what we believe', () => {
    ensureLibraryDirectory()
    mockDisk.set(audioFileFor('1').uri, 1000)
    mockDisk.set(audioFileFor('2').uri, 2500)

    expect(libraryBytes()).toBe(3500)
  })

  it('is zero bytes before anything is downloaded', () => {
    expect(libraryBytes()).toBe(0)
  })
})

describe('naming a file copied in from the phone (#325)', () => {
  it('keeps the original extension, because there is no ffmpeg to convert it', () => {
    // Everything downloaded is `.opus`; a file the user already had is whatever
    // they already had, and re-encoding it on the phone is not an option.
    expect(localAudioFileFor('abc', 'Ceremony.flac').uri).toContain('abc.flac')
    expect(localAudioFileFor('abc', 'Ceremony.M4A').uri).toContain('abc.m4a')
  })

  it('still names the file by the song id, never by the picked name', () => {
    const uri = localAudioFileFor('abc', 'Ceremony.mp3').uri
    expect(uri).toContain('abc.mp3')
    expect(uri).not.toContain('Ceremony')
  })

  it('drops an extension that is not on the allowlist', () => {
    // Android's extractor sniffs the container and ignores the name, so no
    // extension costs nothing while a wrong one is a lie stored in a path.
    expect(localAudioFileFor('abc', 'Ceremony.exe').uri).toMatch(/\/abc$/)
    expect(localAudioFileFor('abc', 'Ceremony').uri).toMatch(/\/abc$/)
  })

  it('cannot be talked out of the library directory by a hostile filename', () => {
    /*
     * The extension becomes part of a path this app writes, and a picked file
     * is named by whoever made it. An allowlist rather than a sanitiser is what
     * makes this a fact about the code rather than a hope about the input.
     */
    for (const name of ['song.../../etc/passwd', 'song.mp3/../..', 'song. .', 'song.%2e%2e']) {
      expect(localAudioFileFor('abc', name).uri).toMatch(/\/abc(\.[a-z0-9]+)?$/)
    }
  })

  it('recognises the extensions a phone actually holds', () => {
    for (const extension of ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav']) {
      expect(keptExtension(`track.${extension}`)).toBe(extension)
    }
    expect(keptExtension('track.txt')).toBeNull()
    expect(keptExtension('track')).toBeNull()
  })
})
