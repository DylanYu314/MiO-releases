import { Directory, File, Paths } from 'expo-file-system'

/**
 * Where the audio lives on the device (#159).
 *
 * The metadata half is `db.ts`; this is the bytes.
 *
 * ## Why `Paths.document` and not `Paths.cache`
 *
 * A cache directory is one the OS may empty whenever it wants space. That is
 * correct for things which can be fetched again and completely wrong for a music
 * library — the whole point of #159 is that the audio is the user's, kept on
 * their device, and does not depend on a server still being there. Android
 * reclaiming it silently would be the same failure as the server going away.
 *
 * ## Naming
 *
 * Files are named by song id, not by title. Titles contain slashes, colons and
 * emoji, they change when metadata is edited, and two songs can share one. An id
 * is stable, unique and needs no escaping — and the database is what turns it
 * back into something a human reads.
 */

/** One folder, so the library can be measured, cleared or backed up as a unit. */
const LIBRARY_FOLDER = 'library'

export function libraryDirectory(): Directory {
  return new Directory(Paths.document, LIBRARY_FOLDER)
}

/**
 * Create the library folder if it is not there.
 *
 * Idempotent: called before any write rather than once at startup, because
 * "startup already did it" stops being true the moment something else clears
 * app storage.
 */
export function ensureLibraryDirectory(): Directory {
  const directory = libraryDirectory()
  if (!directory.exists) directory.create({ intermediates: true })
  return directory
}

/** Where song `id`'s audio belongs. Opus, as everything in this library is.
 *
 *  The id is the *local* one since #246 — a minted string, not the server's
 *  integer. Rows that predate that migration still have files named by the old
 *  id, which is why deletion prefers the recorded `file_uri` below. */
export function audioFileFor(songId: string): File {
  return new File(libraryDirectory(), `${songId}.opus`)
}

/** Whether the audio is actually on this device — the difference between a row
 *  the user can play and one they only know about. */
export function hasAudio(songId: string): boolean {
  return audioFileFor(songId).exists
}

/**
 * The only extensions a copied-in file is allowed to keep.
 *
 * An allowlist rather than a sanitiser, because the extension becomes part of a
 * path this app writes: a picked file is named by whoever made it, and
 * `../../evil` is a filename. Nothing outside this set can reach the filesystem.
 */
const KEPT_EXTENSIONS = ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma', 'mp4', 'oga']

/**
 * Where a track copied in from the user's own storage belongs (#325).
 *
 * Separate from {@link audioFileFor} for one reason: that function hardcodes
 * `.opus`, which is true of everything the app *downloads* — the server
 * transcoded it, and since #246 YouTube's own audio stream is Opus too. A file
 * the user already had is whatever they already had, and re-encoding it on the
 * phone is not an option because there is no ffmpeg here.
 *
 * So the extension is kept, from an allowlist. An unrecognised one is dropped
 * rather than guessed at: Android's extractor sniffs the actual container and
 * ignores the name, so a missing extension costs nothing, while a wrong one is
 * a lie stored in a path.
 *
 * The **id** still names the file, exactly as above — a picked file's own name
 * has every problem this module's docblock lists, and two of them at once.
 */
export function localAudioFileFor(songId: string, fileName: string): File {
  const extension = keptExtension(fileName)
  return new File(libraryDirectory(), extension ? `${songId}.${extension}` : songId)
}

/** The allowlisted extension of `fileName`, lowercased, or null. */
export function keptExtension(fileName: string): string | null {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(fileName)
  if (!match) return null
  const extension = match[1].toLowerCase()
  return KEPT_EXTENSIONS.includes(extension) ? extension : null
}

/**
 * Where song `id`'s cover art belongs (#218).
 *
 * `.jpg` unconditionally, and the extension is a label rather than a claim:
 * nothing here decodes the bytes, and both the `<Image>` component and Android's
 * lock screen sniff the actual format. Naming it by content type would mean
 * either trusting a `Content-Type` header or probing magic bytes, and getting
 * either wrong would orphan the file — the path could no longer be recomputed
 * from the id, which is exactly what `deleteCover` needs to do.
 *
 * Sits beside the audio in the same folder, so "the library" is still one
 * directory to measure, clear or back up.
 */
export function coverFileFor(songId: string): File {
  return new File(libraryDirectory(), `${songId}.jpg`)
}

/**
 * Remove a song's audio, if it is there.
 *
 * Deliberately quiet about a file that does not exist. Deleting is used both by
 * the user removing a song and by cleanup after a failed download, and the
 * second case is *expected* to find nothing.
 */
export function deleteAudio(songId: string, recordedUri?: string | null): void {
  // The recorded location wins when there is one. Songs imported before #246
  // were named by the server's id, so recomputing the path from the local id
  // would silently miss their file and leak it forever.
  const file = recordedUri ? new File(recordedUri) : audioFileFor(songId)
  if (file.exists) file.delete()
}

/**
 * Remove a song's cover, if it is there.
 *
 * Same contract as `deleteAudio`, including the silence about a missing file —
 * a song is allowed to have no cover, so "nothing to delete" is the ordinary
 * case here rather than an edge one.
 */
export function deleteCover(songId: string, recordedUri?: string | null): void {
  const file = recordedUri ? new File(recordedUri) : coverFileFor(songId)
  if (file.exists) file.delete()
}

/** Total bytes the library occupies, for a "MiO is using N MB" line.
 *
 *  Reads sizes from the filesystem rather than summing the `file_size` column:
 *  the column is what the app believes, and this is what is actually there. When
 *  they disagree, the disk is right. */
export function libraryBytes(): number {
  const directory = libraryDirectory()
  if (!directory.exists) return 0
  return directory
    .list()
    .filter((entry): entry is File => entry instanceof File)
    .reduce((total, file) => total + (file.size ?? 0), 0)
}
