/**
 * Reading title, artist and duration out of an audio file's own bytes (#325).
 *
 * A track added from phone storage arrives as a file and nothing else. There is
 * no extractor to ask, because nothing was extracted — the user picked a file
 * that has been on their device for years. So the metadata has to come from the
 * container, and this is the only thing in the app that reads one.
 *
 * ## Why this is written by hand rather than taken from npm
 *
 * The obvious package is `music-metadata`, and it does not fit: it is written
 * for Node, reaches for `Buffer` and stream APIs Hermes does not have, and
 * would be a large dependency for three fields. What is actually needed is the
 * *front* of three container formats, which is a bounded amount of parsing.
 *
 * ## Pure, and that is the point
 *
 * Everything here takes bytes and returns values. No filesystem, no native
 * module, no clock. That is what lets the tests use real fixture bytes and
 * assert on real answers — the parser is the part that can be wrong in
 * interesting ways, so it is the part kept testable.
 *
 * ## No TextDecoder
 *
 * The decoders below are hand-rolled, and deliberately. `TextDecoder` exists in
 * jest and is **not** dependable in Hermes, which is the exact shape of mistake
 * this project has already paid for twice (`docs/lessons.md`: a mock made
 * `playbackRate` writable and shipped a crash; jest has `crypto` and Hermes does
 * not). A test environment that supplies an API the runtime lacks proves
 * nothing, so nothing here uses one.
 *
 * ## What is covered, and what falls back
 *
 * | Format | Title / artist | Duration |
 * |---|---|---|
 * | MP3 | ID3v2.2/2.3/2.4 | `TLEN`, else Xing/Info, else CBR from the bitrate |
 * | FLAC | Vorbis comment | STREAMINFO, which states it exactly |
 * | MP4 / M4A | `©nam` / `©ART` | `mvhd`, which states it exactly |
 * | anything else | the filename | none |
 *
 * Ogg Vorbis is **not** covered: its comments live inside the Ogg page
 * framing rather than at a fixed offset, which is a whole second parser for a
 * format that is rare on a phone. It falls back to the filename like any other
 * unknown container, which is a degraded answer rather than a failure.
 */

export interface AudioTags {
  title: string | null
  artist: string | null
  /** Seconds. Null when the container does not say and cannot be measured. */
  duration: number | null
}

export interface TagSource {
  /** The front of the file. See `TAG_PREFIX_BYTES` for how much is enough. */
  head: Uint8Array
  /** The file's name, including its extension — the fallback when tags are absent. */
  fileName: string
  /** The whole file's length, which the CBR duration estimate needs. */
  fileSize: number
  /**
   * The *end* of the file, when it was worth reading.
   *
   * Only MP4 needs this: `moov` is allowed at either end of the file, and an
   * encoder that writes it last puts every tag out of reach of the prefix.
   * Null means "not read", not "empty".
   */
  tail?: Uint8Array | null
}

/**
 * How much of the front of a file to read before parsing.
 *
 * One mebibyte, and the figure is set by embedded cover art rather than by the
 * text: an ID3v2 tag carrying a photograph routinely runs to several hundred
 * kilobytes, and the frames we want may sit *after* it. Reading less would
 * parse the beginning of a tag and miss its end, which fails silently — the
 * worst available outcome.
 */
export const TAG_PREFIX_BYTES = 1024 * 1024

/** How much of the end to read when the front had no `moov`. */
export const TAG_SUFFIX_BYTES = 512 * 1024

/**
 * Everything the app can learn about a file from the file.
 *
 * Never throws. A container this does not understand, or one that is truncated
 * or malformed, degrades to the filename — a wrong guess about a title is a
 * cosmetic problem the user can see and fix, while a thrown error would cost
 * them the track.
 */
export function readTags(source: TagSource): AudioTags {
  const parsed = parseContainer(source)
  const fromName = tagsFromFileName(source.fileName)

  return {
    // The container wins where it spoke. A filename is a guess about metadata;
    // a tag is metadata.
    title: parsed.title ?? fromName.title,
    artist: parsed.artist ?? fromName.artist,
    duration: parsed.duration,
  }
}

/** Dispatch on what the bytes actually are, never on the extension.
 *
 *  A file named `.mp3` that is really an MP4 is common enough — phones rename
 *  things — and the magic bytes are the fact. */
function parseContainer(source: TagSource): AudioTags {
  const { head } = source
  const empty: AudioTags = { title: null, artist: null, duration: null }

  try {
    if (ascii(head, 0, 4) === 'fLaC') return parseFlac(head)
    // An MP4 begins with a sized box, and `ftyp` is at offset 4 rather than 0.
    if (ascii(head, 4, 4) === 'ftyp') return parseMp4(source)
    // ID3 is a prefix, not a container: it is almost always MP3, so the frame
    // parser below still gets a chance at the duration.
    if (ascii(head, 0, 3) === 'ID3' || hasFrameSyncAt(head, 0)) return parseMp3(source)
  } catch {
    // A malformed file is not an error the user can act on, and every read
    // below is bounds-checked anyway. Falling through to the filename is the
    // graceful answer.
    return empty
  }

  return empty
}

/* ------------------------------------------------------------------ *
 * Filename
 * ------------------------------------------------------------------ */

/**
 * The last resort: what the file is called.
 *
 * `Artist - Title.mp3` is the near-universal convention for a downloaded track
 * and is worth honouring. Anything else becomes the title alone, because
 * inventing an artist out of a filename that does not contain one would be
 * writing a fact the app does not have.
 *
 * Split on the **first** separator, not the last: `Queen - Bohemian Rhapsody -
 * Remastered` is one artist and a title containing a dash, and the other
 * reading puts most of the artist's name into the title.
 */
export function tagsFromFileName(fileName: string): { title: string; artist: string | null } {
  const withoutExtension = fileName.replace(/\.[^./\\]+$/, '')
  // Leading track numbers — `03 - Song`, `03. Song`, `03 Song` — are shelf
  // ordering rather than part of the name, and they sort the library wrongly
  // when kept.
  const stripped = withoutExtension.replace(/^\s*\d{1,3}\s*[-._)]?\s+/, '').trim()
  const name = stripped.length > 0 ? stripped : withoutExtension.trim()

  const separator = name.indexOf(' - ')
  if (separator > 0) {
    const artist = name.slice(0, separator).trim()
    const title = name.slice(separator + 3).trim()
    if (artist.length > 0 && title.length > 0) return { title, artist }
  }

  return { title: name.length > 0 ? name : fileName, artist: null }
}

/* ------------------------------------------------------------------ *
 * Byte helpers
 * ------------------------------------------------------------------ */

/** ASCII at a fixed offset, or `''` past the end. Used for magic numbers and
 *  four-character tags, never for text a human wrote. */
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return ''
  let out = ''
  for (let index = 0; index < length; index++) out += String.fromCharCode(bytes[offset + index])
  return out
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function u24be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]
}

/** Unsigned, hence `>>> 0`: a size with the top bit set is a large number, not
 *  a negative one, and `|` would make it the latter. */
function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  )
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset + 3] << 24) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 1] << 8) |
      bytes[offset]) >>>
    0
  )
}

/**
 * ID3's "synchsafe" integer: seven bits per byte, top bit always clear.
 *
 * The format exists so a tag's length can never contain `0xFF 0xEx`, which a
 * decoder would mistake for the start of audio. Reading one as an ordinary
 * big-endian integer gives a plausible, wrong, larger number — so this is a
 * distinction that fails quietly if missed.
 */
function syncsafe32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  )
}

/** UTF-8 by hand. See the module docblock: `TextDecoder` is a jest-only
 *  guarantee. Malformed sequences become U+FFFD rather than throwing. */
function decodeUtf8(bytes: Uint8Array, start: number, end: number): string {
  let out = ''
  let index = start
  while (index < end) {
    const byte = bytes[index]
    let codePoint: number
    let length: number

    if (byte < 0x80) {
      codePoint = byte
      length = 1
    } else if ((byte & 0xe0) === 0xc0) {
      codePoint = byte & 0x1f
      length = 2
    } else if ((byte & 0xf0) === 0xe0) {
      codePoint = byte & 0x0f
      length = 3
    } else if ((byte & 0xf8) === 0xf0) {
      codePoint = byte & 0x07
      length = 4
    } else {
      out += '�'
      index += 1
      continue
    }

    if (index + length > end) {
      out += '�'
      break
    }
    for (let extra = 1; extra < length; extra++) {
      codePoint = (codePoint << 6) | (bytes[index + extra] & 0x3f)
    }
    out += fromCodePoint(codePoint)
    index += length
  }
  return out
}

/** Latin-1, which ID3v2 calls ISO-8859-1 and uses as its default encoding. */
function decodeLatin1(bytes: Uint8Array, start: number, end: number): string {
  let out = ''
  for (let index = start; index < end; index++) out += String.fromCharCode(bytes[index])
  return out
}

/**
 * UTF-16, with or without a byte-order mark.
 *
 * ID3v2 has two UTF-16 encodings: one that carries a BOM and one defined as
 * big-endian. `bigEndian` is the default for the second; a BOM overrides it.
 */
function decodeUtf16(bytes: Uint8Array, start: number, end: number, bigEndian: boolean): string {
  let index = start
  let big = bigEndian

  if (end - index >= 2) {
    const mark = u16be(bytes, index)
    if (mark === 0xfeff) {
      big = true
      index += 2
    } else if (mark === 0xfffe) {
      big = false
      index += 2
    }
  }

  let out = ''
  for (; index + 1 < end; index += 2) {
    const unit = big
      ? (bytes[index] << 8) | bytes[index + 1]
      : (bytes[index + 1] << 8) | bytes[index]
    out += String.fromCharCode(unit)
  }
  return out
}

/** `String.fromCodePoint` without assuming it exists, and surrogate-safe. */
function fromCodePoint(codePoint: number): string {
  if (codePoint <= 0xffff) return String.fromCharCode(codePoint)
  const offset = codePoint - 0x10000
  return String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff))
}

/** Trim, drop trailing NULs, and treat an empty result as absent.
 *
 *  Taggers pad text with NULs and with whitespace, and a title of `"  "` is not
 *  a title — returning it would put a blank row in the library that looks like
 *  a bug in the list rather than in the file. */
function clean(text: string): string | null {
  const trimmed = text.replace(/\0+$/, '').trim()
  return trimmed.length > 0 ? trimmed : null
}

/* ------------------------------------------------------------------ *
 * ID3v2 / MP3
 * ------------------------------------------------------------------ */

/** Where the audio starts, i.e. past any ID3v2 tag. */
function id3TagLength(head: Uint8Array): number {
  if (ascii(head, 0, 3) !== 'ID3' || head.length < 10) return 0
  // Bit 4 of the flags is a footer, which is a further ten bytes past the body.
  const footer = (head[5] & 0x10) !== 0 ? 10 : 0
  return 10 + syncsafe32(head, 6) + footer
}

interface Id3Text {
  title: string | null
  artist: string | null
  /** Milliseconds, from `TLEN`. Rare, but exact when present. */
  lengthMs: number | null
}

function parseId3(head: Uint8Array): Id3Text {
  const none: Id3Text = { title: null, artist: null, lengthMs: null }
  if (ascii(head, 0, 3) !== 'ID3' || head.length < 10) return none

  const majorVersion = head[3]
  const tagEnd = Math.min(head.length, 10 + syncsafe32(head, 6))

  // v2.2 uses three-character frame ids and three-byte sizes; v2.3 and v2.4 use
  // four of each. Nothing else about the walk differs.
  const short = majorVersion <= 2
  const idLength = short ? 3 : 4
  const headerLength = short ? 6 : 10

  const titleId = short ? 'TT2' : 'TIT2'
  const artistId = short ? 'TP1' : 'TPE1'
  const lengthId = short ? 'TLE' : 'TLEN'

  let title: string | null = null
  let artist: string | null = null
  let lengthMs: number | null = null

  let offset = 10
  while (offset + headerLength <= tagEnd) {
    const frameId = ascii(head, offset, idLength)
    // Padding: the tag is allowed to end in zero bytes before `tagEnd`.
    if (frameId.charCodeAt(0) === 0 || frameId === '') break

    /*
     * v2.4 sizes are synchsafe and v2.3's are not — and getting this wrong is
     * the classic ID3 bug, because it *usually works*. Any frame shorter than
     * 128 bytes reads identically under both, so a wrong choice survives every
     * small tag and then walks off the rails on the first large one.
     */
    const size = short
      ? u24be(head, offset + 3)
      : majorVersion >= 4
        ? syncsafe32(head, offset + 4)
        : u32be(head, offset + 4)

    if (size <= 0) break
    const body = offset + headerLength
    const bodyEnd = Math.min(body + size, tagEnd)
    if (body >= bodyEnd) break

    if (frameId === titleId) title = decodeTextFrame(head, body, bodyEnd)
    else if (frameId === artistId) artist = decodeTextFrame(head, body, bodyEnd)
    else if (frameId === lengthId) {
      const text = decodeTextFrame(head, body, bodyEnd)
      const parsed = text ? Number.parseInt(text, 10) : Number.NaN
      if (Number.isFinite(parsed) && parsed > 0) lengthMs = parsed
    }

    offset = body + size
    if (title && artist && lengthMs) break
  }

  return { title, artist, lengthMs }
}

/** An ID3 text frame: one encoding byte, then the text in that encoding. */
function decodeTextFrame(bytes: Uint8Array, start: number, end: number): string | null {
  const encoding = bytes[start]
  const from = start + 1
  if (from >= end) return null

  switch (encoding) {
    case 0:
      return clean(decodeLatin1(bytes, from, end))
    case 1:
      return clean(decodeUtf16(bytes, from, end, false))
    case 2:
      return clean(decodeUtf16(bytes, from, end, true))
    case 3:
      return clean(decodeUtf8(bytes, from, end))
    default:
      // An encoding byte this does not know is more likely a frame that is not
      // really text than a new standard, so it is read as Latin-1 from the
      // start rather than skipped.
      return clean(decodeLatin1(bytes, start, end))
  }
}

/* MPEG audio frame header ------------------------------------------- */

/** kbit/s by bitrate index, for Layer III. Index 0 is "free" and 15 is invalid;
 *  both are represented as 0 and rejected by the caller. */
const LAYER3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const LAYER3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const SAMPLE_RATES_V1 = [44100, 48000, 32000, 0]
const SAMPLE_RATES_V2 = [22050, 24000, 16000, 0]
const SAMPLE_RATES_V25 = [11025, 12000, 8000, 0]

interface FrameHeader {
  /** MPEG 1, 2 or 2.5 — 2.5 is an unofficial extension and is represented as 0. */
  version: 1 | 2 | 0
  sampleRate: number
  bitrateKbps: number
  channels: 1 | 2
  samplesPerFrame: number
}

function hasFrameSyncAt(bytes: Uint8Array, offset: number): boolean {
  return offset + 1 < bytes.length && bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0
}

/** Decode a Layer III frame header, or null if it is not one. */
function parseFrameHeader(bytes: Uint8Array, offset: number): FrameHeader | null {
  if (offset + 4 > bytes.length || !hasFrameSyncAt(bytes, offset)) return null

  const versionBits = (bytes[offset + 1] >> 3) & 0x03
  const layerBits = (bytes[offset + 1] >> 1) & 0x03
  // 01 is Layer III. Layers I and II exist but are not what a phone holds, and
  // guessing at their frame sizes would be worse than declining.
  if (layerBits !== 0x01 || versionBits === 0x01) return null

  const version = versionBits === 0x03 ? 1 : versionBits === 0x02 ? 2 : 0
  const rates = version === 1 ? SAMPLE_RATES_V1 : version === 2 ? SAMPLE_RATES_V2 : SAMPLE_RATES_V25
  const sampleRate = rates[(bytes[offset + 2] >> 2) & 0x03]
  const bitrateKbps = (version === 1 ? LAYER3_BITRATES_V1 : LAYER3_BITRATES_V2)[
    (bytes[offset + 2] >> 4) & 0x0f
  ]
  if (sampleRate === 0 || bitrateKbps === 0) return null

  // Mode 11 is single channel; everything else carries two.
  const channels = ((bytes[offset + 3] >> 6) & 0x03) === 0x03 ? 1 : 2
  // MPEG 2 and 2.5 halve the samples in a Layer III frame. Using MPEG 1's 1152
  // for all of them doubles every reported duration for a 22 kHz file.
  const samplesPerFrame = version === 1 ? 1152 : 576

  return { version, sampleRate, bitrateKbps, channels, samplesPerFrame }
}

/**
 * Duration of an MP3, by the best method the file supports.
 *
 * Three of them, in descending order of trust:
 *
 * 1. **`TLEN`**, which the tagger wrote and is exact — handled by the caller.
 * 2. **Xing/Info**, a header a VBR encoder writes into the first frame stating
 *    how many frames the file has. Exact, and the only correct answer for VBR.
 * 3. **Bitrate × size**, which assumes every frame is the size of the first.
 *    Right for CBR and *wrong for VBR* — which is why it is last, and why the
 *    Xing check is not skipped as an optimisation.
 */
function mp3Duration(head: Uint8Array, fileSize: number, audioStart: number): number | null {
  const frameOffset = findFrameSync(head, audioStart)
  if (frameOffset === null) return null
  const header = parseFrameHeader(head, frameOffset)
  if (!header) return null

  const xingFrames = readXingFrameCount(head, frameOffset, header)
  if (xingFrames !== null && xingFrames > 0) {
    return (xingFrames * header.samplesPerFrame) / header.sampleRate
  }

  const audioBytes = fileSize - audioStart
  if (audioBytes <= 0) return null
  return audioBytes / ((header.bitrateKbps * 1000) / 8)
}

/**
 * The first real frame at or after `from`.
 *
 * Bounded: a scan that found nothing in 64 KiB has not found a stray sync
 * pattern, it has found that this is not an MP3, and continuing through a
 * megabyte of a file that is something else is wasted work on every import.
 */
function findFrameSync(bytes: Uint8Array, from: number): number | null {
  const limit = Math.min(bytes.length - 4, from + 64 * 1024)
  for (let offset = Math.max(0, from); offset <= limit; offset++) {
    if (parseFrameHeader(bytes, offset)) return offset
  }
  return null
}

/**
 * The frame count from a Xing or Info header, if the first frame carries one.
 *
 * Its position is not fixed: it sits after the frame's side information, whose
 * length depends on the MPEG version and the channel count. Those four cases
 * are the whole reason `parseFrameHeader` bothers to report `channels`.
 */
function readXingFrameCount(
  bytes: Uint8Array,
  frameOffset: number,
  header: FrameHeader,
): number | null {
  const sideInfo =
    header.version === 1 ? (header.channels === 1 ? 17 : 32) : header.channels === 1 ? 9 : 17

  const tagOffset = frameOffset + 4 + sideInfo
  const tag = ascii(bytes, tagOffset, 4)
  // `Info` is the same header written by a CBR encoder. Both state the count.
  if (tag !== 'Xing' && tag !== 'Info') return null

  const flags = u32be(bytes, tagOffset + 4)
  // Bit 0 says a frame count follows. Without it the header carries only a
  // seek table, which says nothing about length.
  if ((flags & 0x01) === 0) return null
  return u32be(bytes, tagOffset + 8)
}

function parseMp3(source: TagSource): AudioTags {
  const { head, fileSize } = source
  const id3 = parseId3(head)
  const audioStart = id3TagLength(head)

  const duration =
    id3.lengthMs !== null ? id3.lengthMs / 1000 : mp3Duration(head, fileSize, audioStart)

  return {
    title: id3.title,
    artist: id3.artist,
    duration: sane(duration),
  }
}

/* ------------------------------------------------------------------ *
 * FLAC
 * ------------------------------------------------------------------ */

/**
 * FLAC states everything exactly, which makes it the easy case.
 *
 * After `fLaC` the file is a list of metadata blocks, each with a four-byte
 * header: one flag bit saying whether it is the last, seven bits of type, and a
 * 24-bit length. STREAMINFO (type 0) holds the sample rate and the total sample
 * count, so the duration is arithmetic rather than estimation.
 */
function parseFlac(head: Uint8Array): AudioTags {
  let offset = 4
  let title: string | null = null
  let artist: string | null = null
  let duration: number | null = null

  while (offset + 4 <= head.length) {
    const last = (head[offset] & 0x80) !== 0
    const type = head[offset] & 0x7f
    const length = u24be(head, offset + 1)
    const body = offset + 4
    if (body + length > head.length) break

    if (type === 0 && length >= 18) duration = flacDuration(head, body)
    else if (type === 4) {
      const comments = parseVorbisComment(head, body, body + length)
      title = comments.title
      artist = comments.artist
    }

    if (last) break
    offset = body + length
  }

  return { title, artist, duration: sane(duration) }
}

/**
 * STREAMINFO's sample rate and total sample count, both bit-packed.
 *
 * The sample rate is 20 bits starting at byte 10, then 3 bits of channel count,
 * 5 of bit depth, and 36 bits of total samples — so neither field is
 * byte-aligned and neither can be read with `u32be`.
 */
function flacDuration(bytes: Uint8Array, start: number): number | null {
  const sampleRate = (bytes[start + 10] << 12) | (bytes[start + 11] << 4) | (bytes[start + 12] >> 4)
  // The top four bits of the 36-bit count share a byte with the bit depth.
  // `* 2 ** 32` rather than a shift: `<<` is 32-bit and would discard them.
  const high = bytes[start + 13] & 0x0f
  const low = u32be(bytes, start + 14)
  const totalSamples = high * 2 ** 32 + low

  if (sampleRate === 0 || totalSamples === 0) return null
  return totalSamples / sampleRate
}

/**
 * Vorbis comments: little-endian lengths, and `FIELD=value` in UTF-8.
 *
 * Little-endian is the trap — every other length in every other format here is
 * big-endian, and reading one the wrong way round gives an enormous number that
 * simply ends the loop, so the failure is a missing title rather than a crash.
 */
function parseVorbisComment(
  bytes: Uint8Array,
  start: number,
  end: number,
): { title: string | null; artist: string | null } {
  let title: string | null = null
  let artist: string | null = null

  let offset = start
  if (offset + 4 > end) return { title, artist }
  // The vendor string, which is of no interest but has to be stepped over.
  offset += 4 + u32le(bytes, offset)
  if (offset + 4 > end) return { title, artist }

  const count = u32le(bytes, offset)
  offset += 4

  // Bounded by the stated count *and* by the block, so a corrupt count cannot
  // spin: a file claiming four billion comments stops at the block's end.
  for (let index = 0; index < count && offset + 4 <= end; index++) {
    const length = u32le(bytes, offset)
    offset += 4
    if (length <= 0 || offset + length > end) break

    const text = decodeUtf8(bytes, offset, offset + length)
    offset += length

    const equals = text.indexOf('=')
    if (equals <= 0) continue
    // Field names are case-insensitive by the specification, and taggers
    // genuinely disagree: `TITLE`, `Title` and `title` all occur.
    const field = text.slice(0, equals).toUpperCase()
    const value = clean(text.slice(equals + 1))
    if (field === 'TITLE' && !title) title = value
    else if (field === 'ARTIST' && !artist) artist = value
  }

  return { title, artist }
}

/* ------------------------------------------------------------------ *
 * MP4 / M4A
 * ------------------------------------------------------------------ */

/**
 * MP4 is a tree of boxes: a four-byte size, a four-character type, then either
 * children or data.
 *
 * The two things wanted are in different branches — `moov/mvhd` for the
 * duration and `moov/udta/meta/ilst` for the text — so the walk descends into
 * `moov` once and handles both.
 */
function parseMp4(source: TagSource): AudioTags {
  const found = findMoov(source)
  if (!found) return { title: null, artist: null, duration: null }

  const { bytes, start, end } = found
  let title: string | null = null
  let artist: string | null = null
  let duration: number | null = null

  walkBoxes(bytes, start, end, (type, bodyStart, bodyEnd) => {
    if (type === 'mvhd') duration = mvhdDuration(bytes, bodyStart, bodyEnd)
    else if (type === 'udta') {
      walkBoxes(bytes, bodyStart, bodyEnd, (udtaType, metaStart, metaEnd) => {
        if (udtaType !== 'meta') return
        /*
         * `meta` is a *full* box: four bytes of version and flags sit between
         * its header and its children. Descending without stepping over them
         * reads the version word as the next box's size and finds nothing —
         * quietly, which is why this line has a comment and the others do not.
         */
        walkBoxes(bytes, metaStart + 4, metaEnd, (metaType, ilstStart, ilstEnd) => {
          if (metaType !== 'ilst') return
          const text = parseIlst(bytes, ilstStart, ilstEnd)
          title = text.title
          artist = text.artist
        })
      })
    }
  })

  return { title, artist, duration: sane(duration) }
}

/** `moov` from the front of the file, or from the back if an encoder put it
 *  there. Both are legal and both occur. */
function findMoov(source: TagSource): { bytes: Uint8Array; start: number; end: number } | null {
  const fromHead = locateBox(source.head, 0, source.head.length, 'moov')
  if (fromHead) return { bytes: source.head, ...fromHead }

  const { tail } = source
  if (!tail || tail.length === 0) return null
  /*
   * The tail is a window into the middle of the file, so it does not begin on a
   * box boundary and `walkBoxes` cannot start from zero. Scanning for the
   * four-character type and stepping back to its size word is the only way in
   * — and it is why the size is sanity-checked before being trusted.
   */
  for (let offset = 4; offset + 8 <= tail.length; offset++) {
    if (ascii(tail, offset, 4) !== 'moov') continue
    const size = u32be(tail, offset - 4)
    if (size < 8) continue
    return { bytes: tail, start: offset + 4, end: Math.min(tail.length, offset - 4 + size) }
  }
  return null
}

function locateBox(
  bytes: Uint8Array,
  start: number,
  end: number,
  wanted: string,
): { start: number; end: number } | null {
  let found: { start: number; end: number } | null = null
  walkBoxes(bytes, start, end, (type, bodyStart, bodyEnd) => {
    if (type === wanted && !found) found = { start: bodyStart, end: bodyEnd }
  })
  return found
}

/**
 * Step through sibling boxes, calling back with each one's body.
 *
 * Size 1 means the real 64-bit size follows the type; size 0 means "to the end
 * of the file". Both are rare in the boxes read here, and both are handled
 * because the alternative to handling them is an infinite loop.
 */
function walkBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  visit: (type: string, bodyStart: number, bodyEnd: number) => void,
): void {
  let offset = start
  while (offset + 8 <= end) {
    const declared = u32be(bytes, offset)
    const type = ascii(bytes, offset + 4, 4)
    let header = 8
    let size = declared

    if (declared === 1) {
      if (offset + 16 > end) break
      // A 64-bit size, whose high word is zero for anything a phone holds.
      const high = u32be(bytes, offset + 8)
      const low = u32be(bytes, offset + 12)
      size = high * 2 ** 32 + low
      header = 16
    } else if (declared === 0) {
      size = end - offset
    }

    // Any size below the header is malformed, and stepping by it would either
    // loop forever or walk backwards.
    if (size < header) break
    const bodyEnd = Math.min(offset + size, end)
    visit(type, offset + header, bodyEnd)
    offset += size
  }
}

/** `mvhd`'s timescale and duration, whose widths depend on its version byte. */
function mvhdDuration(bytes: Uint8Array, start: number, end: number): number | null {
  const version = bytes[start]
  if (version === 1) {
    if (start + 28 > end) return null
    const timescale = u32be(bytes, start + 20)
    // 64-bit duration; the high word is zero for any real track.
    const duration = u32be(bytes, start + 24) * 2 ** 32 + u32be(bytes, start + 28)
    return timescale > 0 ? duration / timescale : null
  }
  if (start + 20 > end) return null
  const timescale = u32be(bytes, start + 12)
  const duration = u32be(bytes, start + 16)
  return timescale > 0 ? duration / timescale : null
}

/**
 * The metadata list: boxes named `©nam`, `©ART` and so on, each containing a
 * `data` box.
 *
 * The `©` is a real byte — 0xA9 — and not UTF-8, so these names are compared as
 * Latin-1 exactly as `ascii()` reads them.
 */
function parseIlst(
  bytes: Uint8Array,
  start: number,
  end: number,
): { title: string | null; artist: string | null } {
  let title: string | null = null
  let artist: string | null = null
  const copyright = String.fromCharCode(0xa9)

  walkBoxes(bytes, start, end, (type, bodyStart, bodyEnd) => {
    const wantsTitle = type === `${copyright}nam`
    const wantsArtist = type === `${copyright}ART`
    if (!wantsTitle && !wantsArtist) return

    walkBoxes(bytes, bodyStart, bodyEnd, (dataType, dataStart, dataEnd) => {
      if (dataType !== 'data') return
      // Four bytes of type indicator, four of locale, then the text itself.
      const text = clean(decodeUtf8(bytes, dataStart + 8, dataEnd))
      if (wantsTitle && !title) title = text
      if (wantsArtist && !artist) artist = text
    })
  })

  return { title, artist }
}

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

/**
 * Reject a duration that cannot be right.
 *
 * Every method above can produce a number from garbage — a CBR estimate over a
 * file that is not an MP3, a timescale misread by one byte — and a track listed
 * as eleven days long is worse than one listed as unknown, because the second
 * is honestly ignorant and the first is confidently wrong. Twenty-four hours is
 * the ceiling: generous enough for any real recording, tight enough to catch a
 * misparse.
 */
const MAX_PLAUSIBLE_SECONDS = 24 * 60 * 60

function sane(duration: number | null): number | null {
  if (duration === null || !Number.isFinite(duration)) return null
  if (duration <= 0 || duration > MAX_PLAUSIBLE_SECONDS) return null
  // Whole seconds. The sub-second part is real but nothing displays it, and a
  // stored 213.0448979591837 invites a reader to believe it means something.
  return Math.round(duration)
}
