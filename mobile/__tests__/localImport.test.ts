import { importLocalFile, importLocalFiles, pickLocalAudioFiles } from '../src/library/localImport'

/**
 * Adding tracks from the phone's own storage (#325).
 *
 * The bytes-to-metadata half is `audioTags.test.ts`, which runs the real parser
 * over real container bytes. This is the other half: the decisions made around
 * it — what identifies a local file, when one is a duplicate, and what happens
 * to a row whose copy fails.
 *
 * `expo-file-system` is native, so the picked files are fakes. What they fake
 * is deliberately narrow: a `md5` property, a readable handle and a `copy`,
 * because those are the three native behaviours this code depends on and the
 * only three it is allowed to assume.
 */

const mockSaveMetadata = jest.fn()
const mockCopy = jest.fn()
const mockRemoveIfEmpty = jest.fn()
const mockSourcesWithAudio = jest.fn()
const mockPickFile = jest.fn()

jest.mock('../src/library/songs', () => ({
  saveDeviceSongMetadata: (...args: unknown[]) => mockSaveMetadata(...args),
  copyAudioIntoLibrary: (...args: unknown[]) => mockCopy(...args),
  removeSongIfEmpty: (...args: unknown[]) => mockRemoveIfEmpty(...args),
  sourcesWithAudio: (...args: unknown[]) => mockSourcesWithAudio(...args),
}))

jest.mock('expo-file-system', () => ({
  File: class {
    static pickFileAsync: (...args: unknown[]) => unknown = (...args: unknown[]) =>
      mockPickFile(...args)
  },
  Directory: class {},
  Paths: { document: { uri: 'file:///data/app' } },
}))

/** A picked file: a name, some bytes, and a hash of them. */
function fakeFile(options: { name: string; md5?: string | null; head?: number[] }) {
  const head = options.head ?? [...'ID3'].map((c) => c.charCodeAt(0))
  const file = {
    name: options.name,
    uri: `content://downloads/${options.name}`,
    size: head.length,
    md5: options.md5 === undefined ? `hash-of-${options.name}` : options.md5,
    open: () => ({
      size: head.length,
      offset: 0,
      readBytes: (length: number) => Uint8Array.from(head.slice(0, length)),
      close: closeSpy,
    }),
    copy: jest.fn(),
  }
  return file as unknown as import('expo-file-system').File
}

const closeSpy = jest.fn()

beforeEach(() => {
  mockSaveMetadata.mockReset().mockResolvedValue('local-1')
  mockCopy.mockReset().mockResolvedValue({ uri: 'file:///data/app/library/local-1.mp3' })
  mockRemoveIfEmpty.mockReset().mockResolvedValue(undefined)
  mockSourcesWithAudio.mockReset().mockResolvedValue(new Set())
  mockPickFile.mockReset()
  closeSpy.mockReset()
})

describe('what identifies a file from local storage', () => {
  it('keys the song on a hash of its contents', async () => {
    // #105's decision, and the reason is de-duplication: `source_url` is UNIQUE
    // since schema v6, and a file has no URL to put there.
    await importLocalFile(fakeFile({ name: 'song.mp3', md5: 'abc123' }))

    expect(mockSaveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ source_url: 'local:abc123', source_platform: 'local' }),
    )
  })

  it('gives the same file the same identity under a different name', async () => {
    /*
     * The whole argument for hashing rather than using the name or the URI: a
     * user who renamed a track, or picked it from a different folder, must not
     * get a second copy of it.
     */
    await importLocalFile(fakeFile({ name: 'song.mp3', md5: 'same' }))
    await importLocalFile(fakeFile({ name: 'renamed copy.mp3', md5: 'same' }))

    const urls = mockSaveMetadata.mock.calls.map(([song]) => song.source_url)
    expect(urls).toEqual(['local:same', 'local:same'])
  })

  it('fails the file rather than writing a row with no identity', async () => {
    // `md5` is null when the file cannot be read. A row keyed on `local:null`
    // would collide with every other unreadable file.
    const outcome = await importLocalFile(fakeFile({ name: 'song.mp3', md5: null }))

    expect(outcome.status).toBe('failed')
    expect(mockSaveMetadata).not.toHaveBeenCalled()
  })
})

describe('a file that is already in the library', () => {
  it('is skipped without copying it again', async () => {
    mockSourcesWithAudio.mockResolvedValue(new Set(['local:abc123']))

    const outcome = await importLocalFile(fakeFile({ name: 'song.mp3', md5: 'abc123' }))

    expect(outcome.status).toBe('duplicate')
    expect(mockCopy).not.toHaveBeenCalled()
    expect(mockSaveMetadata).not.toHaveBeenCalled()
  })

  it('is re-imported when the row exists but its audio never arrived', async () => {
    /*
     * `sourcesWithAudio` answers on `file_uri IS NOT NULL`, not on the row
     * existing — and the difference is the whole point. Treating a row with no
     * file as a duplicate would make a failed import permanent: the user
     * re-picks the file and is told every time that they already have a track
     * they cannot play.
     */
    mockSourcesWithAudio.mockResolvedValue(new Set())

    const outcome = await importLocalFile(fakeFile({ name: 'song.mp3', md5: 'abc123' }))

    expect(outcome.status).toBe('added')
    expect(mockCopy).toHaveBeenCalled()
  })
})

describe('metadata', () => {
  it('uses the filename when the file carries no tags', async () => {
    const outcome = await importLocalFile(
      fakeFile({ name: 'New Order - Ceremony.mp3', head: [0, 0, 0, 0] }),
    )

    expect(mockSaveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Ceremony', artist: 'New Order' }),
    )
    expect(outcome.title).toBe('Ceremony')
  })

  it('names an unknown artist rather than storing a blank one', async () => {
    // `artist` is NOT NULL, and a blank column reads as a bug in the list
    // rather than as a file with no tags.
    await importLocalFile(fakeFile({ name: 'mystery.mp3', head: [0, 0, 0, 0] }))

    expect(mockSaveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'mystery', artist: 'Unknown artist' }),
    )
  })

  it('records no loudness, because nothing on the phone can measure it', async () => {
    // An accepted gap, not an oversight: the server used ffmpeg and the device
    // path gets YouTube's figure. A file off an SD card has neither.
    await importLocalFile(fakeFile({ name: 'song.mp3' }))

    expect(mockSaveMetadata).toHaveBeenCalledWith(expect.objectContaining({ loudness_lufs: null }))
  })

  it('closes the file handle it opened', async () => {
    // A leaked descriptor is invisible until an unrelated import fails.
    await importLocalFile(fakeFile({ name: 'song.mp3' }))

    expect(closeSpy).toHaveBeenCalled()
  })
})

describe('when the copy fails', () => {
  it('removes the row it had already written', async () => {
    // The rule from #309: the library means *music I have*, so a row whose
    // bytes never landed does not survive.
    mockCopy.mockRejectedValue(new Error('No space left on device'))

    const outcome = await importLocalFile(fakeFile({ name: 'song.mp3' }))

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toBe('No space left on device')
    expect(mockRemoveIfEmpty).toHaveBeenCalledWith('local-1')
  })
})

describe('a batch', () => {
  it('keeps going after one file fails, and names the one that did', async () => {
    // Picking twenty tracks and getting nineteen is a good outcome. Stopping at
    // the first failure would throw away eighteen successful copies.
    mockCopy
      .mockResolvedValueOnce({ uri: 'a' })
      .mockRejectedValueOnce(new Error('unreadable'))
      .mockResolvedValueOnce({ uri: 'c' })

    const outcomes = await importLocalFiles([
      fakeFile({ name: 'a.mp3', md5: 'a' }),
      fakeFile({ name: 'b.mp3', md5: 'b' }),
      fakeFile({ name: 'c.mp3', md5: 'c' }),
    ])

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['added', 'failed', 'added'])
    expect(outcomes[1].fileName).toBe('b.mp3')
    expect(outcomes[1].error).toBe('unreadable')
  })

  it('reports progress before each file, not after it', async () => {
    /*
     * Hashing is a blocking native call, so a progress line published *after*
     * the work would only ever say "3 of 3" once everything was over. The
     * report has to name the file that is about to be read.
     */
    const progress: string[] = []
    await importLocalFiles(
      [fakeFile({ name: 'a.mp3', md5: 'a' }), fakeFile({ name: 'b.mp3', md5: 'b' })],
      {
        onProgress: (update) =>
          progress.push(`${update.current}/${update.total} ${update.fileName}`),
      },
    )

    expect(progress).toEqual(['1/2 a.mp3', '2/2 b.mp3'])
  })

  it('counts duplicates separately from failures', async () => {
    mockSourcesWithAudio.mockImplementation(async (urls: string[]) =>
      urls.includes('local:b') ? new Set(['local:b']) : new Set(),
    )

    const outcomes = await importLocalFiles([
      fakeFile({ name: 'a.mp3', md5: 'a' }),
      fakeFile({ name: 'b.mp3', md5: 'b' }),
    ])

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['added', 'duplicate'])
  })
})

describe('the picker', () => {
  it('asks for multiple files, since picking one at a time was the complaint', async () => {
    mockPickFile.mockResolvedValue({ canceled: true, result: null })

    await pickLocalAudioFiles()

    expect(mockPickFile).toHaveBeenCalledWith(expect.objectContaining({ multipleFiles: true }))
  })

  it('offers more than audio/*, because Android mistypes music as octet-stream', async () => {
    // With the wildcard alone a .flac or .m4a is greyed out and the user is
    // told, wrongly, that they have no music.
    mockPickFile.mockResolvedValue({ canceled: true, result: null })

    await pickLocalAudioFiles()

    const { mimeTypes } = mockPickFile.mock.calls[0][0]
    expect(mimeTypes).toContain('audio/*')
    expect(mimeTypes).toContain('application/octet-stream')
  })

  it('returns nothing when the user backs out', async () => {
    mockPickFile.mockResolvedValue({ canceled: true, result: null })

    expect(await pickLocalAudioFiles()).toEqual([])
  })
})
