import { readTags, tagsFromFileName, type TagSource } from '../src/library/audioTags'

/**
 * Reading tags out of real container bytes (#325).
 *
 * The parser is pure, so these are not mocked: every fixture below is an actual
 * ID3v2, FLAC or MP4 byte sequence assembled by the builders at the bottom of
 * this file. A test that asserted against a mocked parser would prove that the
 * mock returns what the mock returns.
 *
 * The builders matter as much as the assertions. `id3v23` and `id3v24` differ
 * only in how a frame size is written, which is precisely the distinction the
 * parser has to get right and precisely the one that survives every small tag —
 * so there is a deliberately **large** frame here, because a short one passes
 * under either reading.
 */

/* ------------------------------------------------------------------ *
 * Builders
 * ------------------------------------------------------------------ */

function latin1(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0))
}

function utf8(text: string): number[] {
  const out: number[] = []
  for (const character of text) {
    const code = character.codePointAt(0) as number
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
  }
  return out
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function u24be(value: number): number[] {
  return [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function synchsafe(value: number): number[] {
  return [(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f]
}

interface Frame {
  id: string
  body: number[]
}

/** A text frame: the encoding byte, then the text. Encoding 0 is Latin-1. */
function textFrame(id: string, text: string, encoding = 0): Frame {
  const body =
    encoding === 3 ? [3, ...utf8(text)] : encoding === 0 ? [0, ...latin1(text)] : [encoding]
  return { id, body }
}

/** Append without spreading: one fixture is a 160 KB frame, and
 *  `push(...array)` at that size overflows the call stack. */
function append(target: number[], ...values: number[][]): void {
  for (const chunk of values) for (const value of chunk) target.push(value)
}

function id3Tag(majorVersion: number, frames: Frame[]): number[] {
  const body: number[] = []
  for (const frame of frames) {
    if (majorVersion <= 2) {
      append(body, latin1(frame.id), u24be(frame.body.length), frame.body)
    } else {
      const size = majorVersion >= 4 ? synchsafe(frame.body.length) : u32be(frame.body.length)
      append(body, latin1(frame.id), size, [0, 0], frame.body)
    }
  }
  const tag: number[] = []
  append(tag, latin1('ID3'), [majorVersion, 0, 0], synchsafe(body.length), body)
  return tag
}

/**
 * A valid MPEG-1 Layer III frame header at 128 kbit/s, 44.1 kHz, stereo.
 *
 * `0xFF 0xFB` is sync plus MPEG-1 plus Layer III plus no CRC; `0x90` is bitrate
 * index 9 (128) and sample rate index 0 (44100); `0x00` is stereo.
 */
function mp3FrameHeader(): number[] {
  return [0xff, 0xfb, 0x90, 0x00]
}

/** A Xing header inside the first frame. Stereo MPEG-1 puts it 32 bytes past
 *  the four-byte header. */
function xingFrame(frameCount: number): number[] {
  const sideInfo = new Array(32).fill(0)
  return [...mp3FrameHeader(), ...sideInfo, ...latin1('Xing'), ...u32be(0x01), ...u32be(frameCount)]
}

function flacBlock(type: number, body: number[], last = false): number[] {
  return [(last ? 0x80 : 0) | type, ...u24be(body.length), ...body]
}

/** STREAMINFO, of which only the sample rate and total sample count matter
 *  here. Both are bit-packed, which is the thing worth testing. */
function streamInfo(sampleRate: number, totalSamples: number): number[] {
  const body = new Array(34).fill(0)
  // 20 bits of sample rate starting at byte 10.
  body[10] = (sampleRate >> 12) & 0xff
  body[11] = (sampleRate >> 4) & 0xff
  body[12] = (sampleRate & 0x0f) << 4
  // The top four bits of the 36-bit sample count share byte 13 with the depth.
  body[13] |= Math.floor(totalSamples / 2 ** 32) & 0x0f
  body[14] = (totalSamples >>> 24) & 0xff
  body[15] = (totalSamples >>> 16) & 0xff
  body[16] = (totalSamples >>> 8) & 0xff
  body[17] = totalSamples & 0xff
  return body
}

function vorbisComment(fields: string[]): number[] {
  const vendor = utf8('reference libFLAC')
  const out = [...u32le(vendor.length), ...vendor, ...u32le(fields.length)]
  for (const field of fields) {
    const encoded = utf8(field)
    out.push(...u32le(encoded.length), ...encoded)
  }
  return out
}

function box(type: string, body: number[]): number[] {
  return [...u32be(body.length + 8), ...latin1(type), ...body]
}

function mvhd(timescale: number, duration: number): number[] {
  // Version 0: one version byte, three flag bytes, creation and modification
  // times, then the timescale and duration.
  return box('mvhd', [
    0,
    0,
    0,
    0,
    ...u32be(0),
    ...u32be(0),
    ...u32be(timescale),
    ...u32be(duration),
  ])
}

function ilstText(type: string, text: string): number[] {
  // A `data` box: four bytes of type indicator, four of locale, then the text.
  return box(type, box('data', [...u32be(1), ...u32be(0), ...utf8(text)]))
}

/** An MP4 whose `moov` carries both a duration and a metadata list. */
function mp4(options: { timescale: number; duration: number; title?: string; artist?: string }) {
  const items: number[] = []
  if (options.title) items.push(...ilstText('©nam', options.title))
  if (options.artist) items.push(...ilstText('©ART', options.artist))

  // `meta` is a full box: four bytes of version and flags before its children.
  const meta = box('meta', [0, 0, 0, 0, ...box('ilst', items)])
  const moov = box('moov', [...mvhd(options.timescale, options.duration), ...box('udta', meta)])
  return [...box('ftyp', latin1('M4A isom')), ...moov]
}

function source(head: number[], overrides: Partial<TagSource> = {}): TagSource {
  return {
    head: Uint8Array.from(head),
    fileName: 'track.mp3',
    fileSize: head.length,
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * Filename
 * ------------------------------------------------------------------ */

describe('falling back to the filename', () => {
  it('splits "Artist - Title"', () => {
    expect(tagsFromFileName('Queen - Bohemian Rhapsody.mp3')).toEqual({
      artist: 'Queen',
      title: 'Bohemian Rhapsody',
    })
  })

  it('splits on the first separator, so a dash in the title stays in it', () => {
    // The other reading gives artist "Queen - Bohemian Rhapsody", which puts
    // most of the title into the artist column.
    expect(tagsFromFileName('Queen - Bohemian Rhapsody - Remastered.flac')).toEqual({
      artist: 'Queen',
      title: 'Bohemian Rhapsody - Remastered',
    })
  })

  it('claims no artist when the name does not contain one', () => {
    // Null, not a guess: inventing an artist writes a fact the app lacks.
    expect(tagsFromFileName('some song.m4a')).toEqual({ artist: null, title: 'some song' })
  })

  it('drops a leading track number', () => {
    expect(tagsFromFileName('03 - Ceremony.mp3')).toEqual({ artist: null, title: 'Ceremony' })
    expect(tagsFromFileName('07. Ceremony.mp3')).toEqual({ artist: null, title: 'Ceremony' })
    expect(tagsFromFileName('12 Ceremony.mp3')).toEqual({ artist: null, title: 'Ceremony' })
  })

  it('keeps a name that is only a number, rather than emptying it', () => {
    // Stripping here would leave nothing, and a blank row reads as a bug in the
    // list rather than in the file.
    expect(tagsFromFileName('1979.mp3').title).toBe('1979')
  })

  it('does not mistake a hyphen without spaces for a separator', () => {
    expect(tagsFromFileName('rock-and-roll.mp3')).toEqual({ artist: null, title: 'rock-and-roll' })
  })
})

/* ------------------------------------------------------------------ *
 * ID3 / MP3
 * ------------------------------------------------------------------ */

describe('ID3v2 tags', () => {
  it('reads title and artist from a v2.3 tag', () => {
    const tag = id3Tag(3, [textFrame('TIT2', 'Ceremony'), textFrame('TPE1', 'New Order')])
    const tags = readTags(source([...tag, ...mp3FrameHeader()]))
    expect(tags.title).toBe('Ceremony')
    expect(tags.artist).toBe('New Order')
  })

  it('reads a v2.4 tag, whose frame sizes are synchsafe', () => {
    const tag = id3Tag(4, [textFrame('TIT2', 'Ceremony'), textFrame('TPE1', 'New Order')])
    const tags = readTags(source([...tag, ...mp3FrameHeader()]))
    expect(tags.title).toBe('Ceremony')
    expect(tags.artist).toBe('New Order')
  })

  it('reads the frame after a large one, where v2.3 and v2.4 sizes differ', () => {
    /*
     * The test that earns its place.
     *
     * Any frame under 128 bytes reads identically as a plain integer and as a
     * synchsafe one, so a parser that confuses the two passes every small tag.
     * This puts a 200-byte frame first: read the wrong way its size is 328, and
     * the walk lands in the middle of the next frame and finds no artist.
     */
    const padding = 'x'.repeat(200)
    const tag = id3Tag(4, [
      textFrame('TCOM', padding),
      textFrame('TIT2', 'Ceremony'),
      textFrame('TPE1', 'New Order'),
    ])
    const tags = readTags(source([...tag, ...mp3FrameHeader()]))
    expect(tags.title).toBe('Ceremony')
    expect(tags.artist).toBe('New Order')
  })

  it('reads UTF-8 text, including characters outside Latin-1', () => {
    const tag = id3Tag(4, [textFrame('TIT2', '光年之外', 3), textFrame('TPE1', 'G.E.M.', 3)])
    const tags = readTags(source([...tag, ...mp3FrameHeader()]))
    expect(tags.title).toBe('光年之外')
    expect(tags.artist).toBe('G.E.M.')
  })

  it('reads UTF-16 with a byte-order mark', () => {
    // Encoding 1, little-endian with a BOM — what Windows taggers write.
    const text = [0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]
    const tag = id3Tag(3, [{ id: 'TIT2', body: [1, ...text] }])
    expect(readTags(source([...tag, ...mp3FrameHeader()])).title).toBe('Hi')
  })

  it('reads a v2.2 tag, whose frame ids are three characters', () => {
    const tag = id3Tag(2, [textFrame('TT2', 'Ceremony'), textFrame('TP1', 'New Order')])
    const tags = readTags(source([...tag, ...mp3FrameHeader()]))
    expect(tags.title).toBe('Ceremony')
    expect(tags.artist).toBe('New Order')
  })

  it('prefers the filename over a tag that is only whitespace', () => {
    // A padded, empty title is not a title, and using it would put a blank row
    // in the library.
    const tag = id3Tag(3, [textFrame('TIT2', '   ')])
    const head = [...tag, ...mp3FrameHeader()]
    expect(readTags(source(head, { fileName: 'Real Name.mp3' })).title).toBe('Real Name')
  })

  it('prefers the tag over the filename when both say something', () => {
    const tag = id3Tag(3, [textFrame('TIT2', 'Ceremony'), textFrame('TPE1', 'New Order')])
    const head = [...tag, ...mp3FrameHeader()]
    const tags = readTags(source(head, { fileName: 'Wrong Artist - Wrong Title.mp3' }))
    expect(tags.title).toBe('Ceremony')
    expect(tags.artist).toBe('New Order')
  })
})

describe('MP3 duration', () => {
  it('uses TLEN when the tagger wrote one', () => {
    const tag = id3Tag(3, [textFrame('TLEN', '213000')])
    expect(readTags(source([...tag, ...mp3FrameHeader()])).duration).toBe(213)
  })

  it('uses the Xing frame count for a VBR file', () => {
    // 8000 frames x 1152 samples / 44100 Hz = 208.98s.
    const head = xingFrame(8000)
    expect(readTags(source(head, { fileSize: 3_000_000 })).duration).toBe(209)
  })

  it('prefers Xing over the bitrate estimate, which is wrong for VBR', () => {
    /*
     * The CBR estimate over this file would be 3,000,000 bytes at 128 kbit/s =
     * 187s. The Xing count says 209s. A parser that skipped the Xing check as
     * an optimisation returns the first number and is wrong on every VBR track.
     */
    const head = xingFrame(8000)
    expect(readTags(source(head, { fileSize: 3_000_000 })).duration).toBe(209)
    expect(readTags(source(head, { fileSize: 3_000_000 })).duration).not.toBe(187)
  })

  it('estimates from the bitrate when there is no Xing header', () => {
    // 320,000 bytes at 128 kbit/s (16,000 bytes/s) = 20s.
    const head = [...mp3FrameHeader(), ...new Array(64).fill(0)]
    expect(readTags(source(head, { fileSize: 320_000 })).duration).toBe(20)
  })

  it('subtracts the ID3 tag from the audio length', () => {
    /*
     * A tag with embedded art can be hundreds of kilobytes. Counting it as
     * audio adds its whole size to every duration — here, 160,000 bytes of tag
     * would report 30s instead of 20s.
     */
    const tag = id3Tag(3, [textFrame('TCOM', 'x'.repeat(160_000))])
    const head: number[] = []
    append(head, tag, mp3FrameHeader(), new Array(64).fill(0))
    expect(readTags(source(head, { fileSize: 320_000 + tag.length })).duration).toBe(20)
  })

  it('halves the samples per frame for MPEG-2, rather than doubling the duration', () => {
    // 0xFF 0xF3 is MPEG-2 Layer III; 0x40 is 24 kbit/s at 22.05 kHz.
    const header = [0xff, 0xf3, 0x40, 0x00]
    const sideInfo = new Array(17).fill(0)
    const head = [...header, ...sideInfo, ...latin1('Xing'), ...u32be(0x01), ...u32be(1000)]
    // 1000 x 576 / 22050 = 26.1s. Using MPEG-1's 1152 would say 52s.
    expect(readTags(source(head, { fileSize: 100_000 })).duration).toBe(26)
  })

  it('reports no duration rather than an absurd one', () => {
    // A file claiming to be 400 GB of 128 kbit/s audio is a misparse, and a
    // track listed as a month long is worse than one listed as unknown.
    const head = [...mp3FrameHeader(), ...new Array(64).fill(0)]
    expect(readTags(source(head, { fileSize: 400_000_000_000 })).duration).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * FLAC
 * ------------------------------------------------------------------ */

describe('FLAC', () => {
  const flacFile = (blocks: number[][]) => [...latin1('fLaC'), ...blocks.flat()]

  it('reads title and artist from a Vorbis comment', () => {
    const head = flacFile([
      flacBlock(0, streamInfo(44100, 44100 * 100)),
      flacBlock(4, vorbisComment(['TITLE=Ceremony', 'ARTIST=New Order']), true),
    ])
    const tags = readTags(source(head, { fileName: 'x.flac' }))
    expect(tags.title).toBe('Ceremony')
    expect(tags.artist).toBe('New Order')
  })

  it('matches field names case-insensitively, as the specification says', () => {
    /*
     * Written once with the last-block flag set on STREAMINFO, which ends the
     * walk before the comment is ever reached — so it asserted a duration while
     * claiming to test field names, and passed with the case comparison
     * deleted. Kept as written now: the flag is on the *comment* block, and the
     * assertions are the fields.
     */
    const head = flacFile([
      flacBlock(0, streamInfo(44100, 44100)),
      flacBlock(4, vorbisComment(['Title=Ceremony', 'artist=New Order']), true),
    ])
    const tags = readTags(source(head, { fileName: 'x.flac' }))
    expect(tags.title).toBe('Ceremony')
    expect(tags.artist).toBe('New Order')
  })

  it('reads a comment block that follows other blocks', () => {
    const head = flacFile([
      flacBlock(0, streamInfo(48000, 48000 * 213)),
      flacBlock(1, new Array(64).fill(0)),
      flacBlock(4, vorbisComment(['title=Ceremony', 'ARTIST=New Order']), true),
    ])
    const tags = readTags(source(head, { fileName: 'x.flac' }))
    expect(tags.title).toBe('Ceremony')
    expect(tags.artist).toBe('New Order')
    expect(tags.duration).toBe(213)
  })

  it('states the duration exactly, from the sample count', () => {
    const head = flacFile([flacBlock(0, streamInfo(44100, 44100 * 187 + 22050), true)])
    // 187.5s, rounded.
    expect(readTags(source(head, { fileName: 'x.flac' })).duration).toBe(188)
  })

  it('reads a sample count above 2^32, which a shift would truncate', () => {
    /*
     * The count is 36 bits. A 32-bit shift silently drops the top four, so a
     * long recording reports a small fraction of its length. 2^32 + 44100
     * samples at 44100 Hz is just over 27 hours — beyond the plausibility
     * ceiling, which is the point: the wrong reading gives exactly 1s.
     */
    const head = flacFile([flacBlock(0, streamInfo(44100, 2 ** 32 + 44100), true)])
    const duration = readTags(source(head, { fileName: 'x.flac' })).duration
    expect(duration).not.toBe(1)
    expect(duration).toBeNull()
  })

  it('is not fooled by the little-endian lengths in a comment block', () => {
    // Vorbis is the only little-endian thing here. Reading big-endian gives an
    // enormous length, the loop stops, and the title is silently missing.
    const head = flacFile([
      flacBlock(0, streamInfo(44100, 44100)),
      flacBlock(4, vorbisComment(['TITLE=A']), true),
    ])
    expect(readTags(source(head, { fileName: 'x.flac' })).title).toBe('A')
  })
})

/* ------------------------------------------------------------------ *
 * MP4
 * ------------------------------------------------------------------ */

describe('MP4', () => {
  it('reads title, artist and duration', () => {
    const head = mp4({ timescale: 1000, duration: 213_000, title: 'Ceremony', artist: 'New Order' })
    const tags = readTags(source(head, { fileName: 'x.m4a' }))
    expect(tags.title).toBe('Ceremony')
    expect(tags.artist).toBe('New Order')
    expect(tags.duration).toBe(213)
  })

  it('divides the duration by the timescale', () => {
    // A timescale that is not 1000 is common; ignoring it reports the raw
    // sample count as seconds.
    const head = mp4({ timescale: 44100, duration: 44100 * 213 })
    expect(readTags(source(head, { fileName: 'x.m4a' })).duration).toBe(213)
  })

  it('steps over the version and flags in the meta box', () => {
    // `meta` is a full box. Descending straight into it reads the version word
    // as a box size and finds no `ilst` — quietly.
    const head = mp4({ timescale: 1000, duration: 1000, title: 'Found' })
    expect(readTags(source(head, { fileName: 'x.m4a' })).title).toBe('Found')
  })

  it('finds moov at the end of the file, where some encoders put it', () => {
    const file = mp4({ timescale: 1000, duration: 213_000, title: 'Late', artist: 'Mover' })
    const ftypLength = 16
    const head = file.slice(0, ftypLength)
    const tail = file.slice(ftypLength - 4)
    const tags = readTags({
      head: Uint8Array.from(head),
      tail: Uint8Array.from(tail),
      fileName: 'x.m4a',
      fileSize: file.length,
    })
    expect(tags.title).toBe('Late')
    expect(tags.artist).toBe('Mover')
  })

  it('falls back to the filename when moov is out of reach', () => {
    const file = mp4({ timescale: 1000, duration: 213_000, title: 'Late' })
    const head = file.slice(0, 16)
    const tags = readTags({
      head: Uint8Array.from(head),
      tail: null,
      fileName: 'Mover - Late.m4a',
      fileSize: file.length,
    })
    expect(tags.title).toBe('Late')
    expect(tags.artist).toBe('Mover')
    expect(tags.duration).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Not a container this understands
 * ------------------------------------------------------------------ */

describe('anything else', () => {
  it('falls back to the filename without throwing', () => {
    const tags = readTags(source(latin1('OggS not really'), { fileName: 'Band - Song.ogg' }))
    expect(tags).toEqual({ title: 'Song', artist: 'Band', duration: null })
  })

  it('survives a truncated file', () => {
    // Half an ID3 header. A parser that trusted its length walks off the end.
    const tags = readTags(source([...latin1('ID3'), 3], { fileName: 'Band - Song.mp3' }))
    expect(tags.title).toBe('Song')
    expect(tags.duration).toBeNull()
  })

  it('survives an empty file', () => {
    expect(readTags(source([], { fileName: 'nothing.mp3' }))).toEqual({
      title: 'nothing',
      artist: null,
      duration: null,
    })
  })

  it('dispatches on the bytes, not on the extension', () => {
    // Phones rename things. A FLAC called .mp3 is still a FLAC.
    const head = [
      ...latin1('fLaC'),
      ...flacBlock(0, streamInfo(44100, 44100 * 60)),
      ...flacBlock(4, vorbisComment(['TITLE=Renamed']), true),
    ]
    const tags = readTags(source(head, { fileName: 'mystery.mp3' }))
    expect(tags.title).toBe('Renamed')
    expect(tags.duration).toBe(60)
  })
})
