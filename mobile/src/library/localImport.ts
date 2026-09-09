import { File } from 'expo-file-system'

import { describeError, logInfo, logWarn } from '../diagnostics/log'
import i18n from '../i18n'
import { readTags, TAG_PREFIX_BYTES, TAG_SUFFIX_BYTES, type AudioTags } from './audioTags'
import { localAudioFileFor } from './files'
import {
  copyAudioIntoLibrary,
  removeSongIfEmpty,
  saveDeviceSongMetadata,
  sourcesWithAudio,
} from './songs'

/**
 * Adding tracks the user already has, from the phone's own storage (#325).
 *
 * *"a new feature allow user to add tracks from their local storage, we
 * bring up user storage screen and allow user to find the tracks (allow multi
 * selection), and add that to our library."*
 *
 * The fourth door onto the Add tab, and the first one that involves no network
 * at all. Which makes it the purest statement of what #159 is for: the music is
 * already on the device, and MiO's job is to know about it.
 *
 * ## It needs no native build, and #325 said it would
 *
 * The issue assumed a document picker meant a new native dependency, and
 * batched this into the S8 build for that reason. It does not:
 * `expo-file-system` has shipped `File.pickFileAsync` since well before the
 * version this app already builds against, with multi-select handled natively.
 * The premise was out of date rather than wrong at the time.
 *
 * ## `local:<md5>` is the source url
 *
 * `songs.source_url` is `NOT NULL` and, since schema v6, `UNIQUE` — it is what
 * the whole library de-duplicates on. A file has no URL, so it needs an
 * identity, and #105 proposed this one long before there was a phone to run it
 * on.
 *
 * The alternatives were considered and are worse:
 *
 * - **The file's URI.** Android hands out a `content://` grant, not an address;
 *   it is not stable across picks, so re-picking the same file would make a
 *   second row. Identity that changes is not identity.
 * - **Name plus size.** Cheap, and wrong in both directions: the same track
 *   under two filenames becomes two rows, and two unrelated files that happen
 *   to share a name and a byte count become one.
 * - **Making `source_url` nullable.** SQLite cannot drop `NOT NULL` without
 *   rebuilding the table — the migration class that ends with a device unable
 *   to open its own library — and it would leave local files with no
 *   de-duplication at all.
 *
 * A content hash costs a read of the file, and buys the only answer that is
 * actually true: *this is the same audio*, whatever it is called and wherever
 * it was moved to. `file.md5` streams it natively in 64 KiB chunks, so the
 * bytes never reach JavaScript.
 *
 * ## Two known gaps, both deliberate
 *
 * **No loudness.** The server measured it with `ebur128` (G4) and the device
 * path gets YouTube's own figure (#246); a file off the user's SD card has
 * neither, so it plays uncorrected. Measuring it would need ffmpeg, which is
 * not on the phone.
 *
 * **No cover art.** Embedded artwork means decoding an ID3 `APIC` frame or an
 * MP4 `covr` atom and writing the image out, which is a second feature. A song
 * with no cover is an ordinary state everywhere in this app (#218).
 *
 * Both are recorded rather than hidden, because "it works" and "it works as
 * well as the other three doors" are different claims.
 */

/** What happened to one file. */
export type LocalImportStatus = 'added' | 'duplicate' | 'failed'

export interface LocalImportOutcome {
  /** The file's own name — the only thing a user can match against what they
   *  picked, since nothing else about it is theirs. */
  fileName: string
  status: LocalImportStatus
  /** This device's id for the song. Null when nothing was written. */
  localId: string | null
  title: string | null
  /** Why it failed, for the screen. Null unless `status` is `failed`. */
  error: string | null
}

export interface LocalImportProgress {
  /** 1-based, and counted over files rather than bytes: hashing and copying are
   *  each one indivisible native call, so there is no sub-file progress to
   *  report that would not be invented. */
  current: number
  total: number
  fileName: string
}

/**
 * Open the system picker and return what was chosen.
 *
 * An empty array means the user backed out, which is not an error and is not
 * reported as one. Note that `File.pickFileAsync` converts *every* failure into
 * a cancellation, not just an actual cancel — so there is nothing here to
 * distinguish, and nothing worth telling the user about a picker that declined
 * to open.
 */
export async function pickLocalAudioFiles(): Promise<File[]> {
  const result = await File.pickFileAsync({
    multipleFiles: true,
    /*
     * `audio/*` alone hides too much. Android's document providers type files
     * from their extension, and a `.flac` or `.m4a` routinely arrives as
     * `application/octet-stream` — with the wildcard alone those files are
     * greyed out and the user is told, wrongly, that they have no music. The
     * explicit types below are the ones that get mistyped most.
     */
    mimeTypes: ['audio/*', 'application/ogg', 'application/octet-stream'],
  })

  if (result.canceled) return []
  return result.result
}

/**
 * Import every picked file, in order, reporting as it goes.
 *
 * One file's failure never stops the run — picking twenty tracks and getting
 * nineteen is a good outcome, and the twentieth is named in the result. This is
 * the same judgement the playlist importer makes about a track it could not
 * match: partial success is success, and visible.
 */
export async function importLocalFiles(
  files: readonly File[],
  { onProgress }: { onProgress?: (progress: LocalImportProgress) => void } = {},
): Promise<LocalImportOutcome[]> {
  const outcomes: LocalImportOutcome[] = []
  // Counts only. What the user has on their phone is not the log's business
  // (#354), and a filename is as much theirs as a song title is.
  logInfo('localAdd.started', `${files.length} file(s)`)

  for (let index = 0; index < files.length; index++) {
    const file = files[index]
    onProgress?.({ current: index + 1, total: files.length, fileName: nameOf(file) })
    /*
     * Yield to the UI between files.
     *
     * `file.md5` is a synchronous native property that reads the whole file, so
     * it blocks the JS thread for as long as that takes. That is tolerable per
     * file and is not tolerable twenty times in a row: without this the
     * progress line would be painted once, at the end, having reported nothing
     * during the only part that takes time. #342 is about exactly this class of
     * fault, so it is not a thing to introduce while it is open.
     */
    await yieldToUi()
    outcomes.push(await importLocalFile(file))
  }

  const added = outcomes.filter((outcome) => outcome.status === 'added').length
  const duplicates = outcomes.filter((outcome) => outcome.status === 'duplicate').length
  const failed = outcomes.filter((outcome) => outcome.status === 'failed').length
  logInfo('localAdd.finished', `${added} added, ${duplicates} duplicate, ${failed} failed`)

  return outcomes
}

/**
 * Import one file.
 *
 * Never throws: the outcome is the return value, because a batch has to keep
 * going and the caller has to be able to say which of twenty files was the
 * problem.
 */
export async function importLocalFile(file: File): Promise<LocalImportOutcome> {
  const fileName = nameOf(file)

  try {
    const hash = file.md5
    if (!hash) throw new Error('Could not read the file')
    const sourceUrl = `local:${hash}`

    /*
     * Already here, with its audio — nothing to do.
     *
     * Checked on `file_uri IS NOT NULL` rather than on the row existing, which
     * is what `sourcesWithAudio` means. A row with no file is the retryable
     * state the schema models, and treating it as a duplicate would make a
     * failed import permanent: the user would re-pick the file and be told,
     * every time, that they already have a track they cannot play.
     */
    if ((await sourcesWithAudio([sourceUrl])).has(sourceUrl)) {
      return { fileName, status: 'duplicate', localId: null, title: null, error: null }
    }

    const tags = readFileTags(file, fileName)

    const localId = await saveDeviceSongMetadata({
      title: tags.title ?? fileName,
      // Frozen at the language the app was in when the file was added, which is
      // the honest trade: the column is text the user can see and edit, not a
      // key, and re-translating stored rows on a language switch would rewrite
      // an artist the user may have typed themselves.
      artist: tags.artist ?? i18n.t('localAdd.unknownArtist'),
      duration: tags.duration,
      source_url: sourceUrl,
      // Lower case, and distinct from the `Youtube` the other paths write. It
      // is what tells every other screen this track has no source to go back to.
      source_platform: 'local',
      // See the module docblock: nothing on the phone can measure this.
      loudness_lufs: null,
    })

    try {
      await copyAudioIntoLibrary(localId, file, localAudioFileFor(localId, fileName))
    } catch (error) {
      // The same rule as the device import (#309): the library means *music I
      // have*, so a row whose bytes never landed does not survive. Guarded, so
      // a retry over a track that is already here cannot delete it.
      await removeSongIfEmpty(localId)
      throw error
    }

    logInfo('localAdd.added', 'ok')
    return { fileName, status: 'added', localId, title: tags.title ?? fileName, error: null }
  } catch (error) {
    // The shape of the failure, never the file's name — see #354. A filename is
    // a fact about the user's taste in exactly the way a song title is.
    logWarn('localAdd.failed', describeError(error))
    return {
      fileName,
      status: 'failed',
      localId: null,
      title: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Read enough of the file to parse its tags.
 *
 * A bounded read through a file handle rather than `file.bytes()`, and the
 * difference matters on a phone: `bytes()` pulls the entire track into
 * JavaScript, so importing a 90-minute FLAC would allocate several hundred
 * megabytes to find out its title.
 *
 * Never throws — a file that cannot be read for metadata can still be copied,
 * and a track named after its filename is a far better outcome than a failed
 * import.
 */
function readFileTags(file: File, fileName: string): AudioTags {
  let handle: ReturnType<File['open']> | null = null
  try {
    handle = file.open()
    const fileSize = handle.size ?? file.size ?? 0
    const head = handle.readBytes(Math.min(TAG_PREFIX_BYTES, fileSize || TAG_PREFIX_BYTES))

    /*
     * The tail, only when it can hold something the head did not.
     *
     * MP4 is allowed to put `moov` — and therefore every tag — at either end of
     * the file, and encoders genuinely do both. Reading the end unconditionally
     * would be a second whole-file seek on every mp3 for nothing, so it is
     * gated on the file actually being longer than what was already read.
     */
    let tail: Uint8Array | null = null
    if (fileSize > head.length) {
      const from = Math.max(head.length, fileSize - TAG_SUFFIX_BYTES)
      handle.offset = from
      tail = handle.readBytes(fileSize - from)
    }

    return readTags({ head, fileName, fileSize, tail })
  } catch (error) {
    logWarn('localAdd.tagsUnreadable', describeError(error))
    return { title: null, artist: null, duration: null }
  } finally {
    // A leaked file descriptor is invisible until the twentieth import fails
    // for a reason that has nothing to do with the twentieth file.
    handle?.close()
  }
}

/** The picked file's name, falling back to the last path segment of its URI.
 *
 *  `File.name` is normally right, but a `content://` document URI does not have
 *  to carry one, and a blank title in the library is worse than an ugly one. */
function nameOf(file: File): string {
  const name = file.name?.trim()
  if (name) return name
  const segments = decodeURIComponent(file.uri).split('/')
  return segments[segments.length - 1] || file.uri
}

/** Hand the frame back to React so progress is drawn while work is happening. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
