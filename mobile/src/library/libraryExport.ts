import { Directory, File, Paths } from 'expo-file-system'

import { listPlaylistItems, listPlaylists } from './playlists'
import { listLocalSongs, type LocalSong } from './songs'
import type { LocalPlaylist, LocalPlaylistItem } from './playlists'

/**
 * Copy a library to another phone, as a file (#729).
 *
 * ## What this is, and what it deliberately is not
 *
 * ⚠️ **It is a copy, not a sync**, and the naming is load-bearing rather than
 * cosmetic. Nothing propagates: delete a song here tomorrow and the other phone
 * keeps it. That cannot be fixed without cloud storage, which MiO does not have
 * and is not getting (#615 is deferred), so the feature is named for what it
 * does — a one-time copy sets no expectation to violate, which handles the flaw
 * better than a warning does (#656's shape, where a string outlived its
 * subject).
 *
 * ⭐ **It is also the backup MiO has never had.** Today a lost or wiped phone
 * loses the library, playlists and favourites with no mitigation at all.
 *
 * ## Why a file, and not a transfer
 *
 * ADR-021 designed a relay through the droplet, then was amended the same day:
 * there is no web client, so no *audio* moves, so there is nothing for a server
 * or a pairing primitive to do. What crosses is a list of source URLs.
 *
 * ⛔ **The receiving phone downloads its own audio**, exactly as #246 already
 * has every other import do. So this transfers no recordings and the project's ground rules
 * is not engaged at all.
 *
 * `expo-file-system` was already installed and has both halves —
 * `Directory.pickDirectoryAsync` here and `File.pickFileAsync` for the import —
 * so this needs no new dependency and no native build, and ships over the air.
 *
 * ## ⛔ Local files cannot come, and the count is reported
 *
 * `add/local.tsx` keys a picked file on `local:<md5>` because a content hash is
 * the only identity that survives a rename (#325). That is an identity, not an
 * address: no other device can fetch it. Their metadata would arrive and their
 * audio never would, so they are left out and counted — a silent omission is
 * how a "complete" backup turns out not to be.
 */

/** Names the shape, so an unrelated `.json` is refused rather than half-read. */
export const LIBRARY_EXPORT_FORMAT = 'mio.library'

/**
 * Bumped when the shape changes in a way an older importer cannot read.
 *
 * ⚠️ The importer must check it. A file from a newer MiO is not a file to
 * attempt and partially apply.
 */
export const LIBRARY_EXPORT_VERSION = 1

/** A song, reduced to what another device needs to find it again. */
export interface ExportedSong {
  /** ⭐ The join key everywhere in this format. Local ids are per-device. */
  source_url: string
  source_platform: string
  title: string
  artist: string
  album: string | null
  duration: number | null
}

export interface ExportedPlaylist {
  name: string
  /** `favourites` is a playlist row like any other, so it needs no special case. */
  kind: string
  /** `source_url`s, in the order the playlist holds them. */
  songs: string[]
}

export interface LibraryExport {
  format: typeof LIBRARY_EXPORT_FORMAT
  version: number
  exported_at: string
  songs: ExportedSong[]
  playlists: ExportedPlaylist[]
  /** How many `local:` songs were left out, so the UI can say so. */
  skipped_local: number
}

/** A playlist together with its items, in position order. */
export interface PlaylistWithItems {
  playlist: LocalPlaylist
  items: readonly LocalPlaylistItem[]
}

/** Songs the receiving device has no way to fetch. */
export function isUnfetchable(sourceUrl: string): boolean {
  return sourceUrl.startsWith('local:')
}

/**
 * The export document, as a pure function of the library.
 *
 * Pure so it can be tested without a database or a filesystem — the same reason
 * the player store holds no `<audio>` element.
 */
export function buildLibraryExport(
  songs: readonly LocalSong[],
  playlists: readonly PlaylistWithItems[],
  exportedAt: string,
): LibraryExport {
  const exportable = songs.filter((song) => !isUnfetchable(song.source_url))

  return {
    format: LIBRARY_EXPORT_FORMAT,
    version: LIBRARY_EXPORT_VERSION,
    exported_at: exportedAt,
    songs: exportable.map((song) => ({
      source_url: song.source_url,
      source_platform: song.source_platform,
      title: song.title,
      artist: song.artist,
      album: song.album ?? null,
      duration: song.duration ?? null,
    })),
    playlists: playlists.map(({ playlist, items }) => ({
      name: playlist.name,
      kind: playlist.kind,
      // Filtered here too, not only in `songs`: a playlist entry pointing at a
      // song the file does not carry would import as a hole.
      songs: items
        .map((item) => item.song.source_url)
        .filter((sourceUrl) => !isUnfetchable(sourceUrl)),
    })),
    skipped_local: songs.length - exportable.length,
  }
}

/**
 * A filename that sorts by date and cannot collide within a day.
 *
 * ⚠️ Colons are legal in a `source_url` and illegal in a filename on the
 * storage a user is likely to pick, so the timestamp is flattened rather than
 * pasted in as an ISO string.
 */
export function exportFileName(exportedAt: string): string {
  const stamp = exportedAt.replace(/[:.]/g, '-').replace(/Z$/, '')
  return `mio-library-${stamp}.json`
}

export interface LibraryExportResult {
  uri: string
  songCount: number
  playlistCount: number
  skippedLocal: number
}

/**
 * Read the library, ask the user where to put it, and write it there.
 *
 * ⚠️ **The user picks the directory**, rather than the file landing somewhere
 * MiO chose. An app-private path is unreachable from the share sheet and from a
 * cable, which would make an export that exists and cannot be moved.
 */
export async function exportLibrary(): Promise<LibraryExportResult> {
  const [songs, playlists] = await Promise.all([listLocalSongs(), listPlaylists()])

  const withItems: PlaylistWithItems[] = await Promise.all(
    playlists.map(async (playlist) => ({
      playlist,
      items: await listPlaylistItems(playlist.id),
    })),
  )

  const document = buildLibraryExport(songs, withItems, new Date().toISOString())

  // Asked for after the reading, not before: a user who cancels the picker
  // should not have been made to wait for the database first.
  const directory = await Directory.pickDirectoryAsync()

  /*
   * ⛔ **Write to app storage first, then copy into the chosen folder.**
   *
   * The obvious version — `new File(pickedDirectory, name).create()` — fails on
   * a device, and the reason is in the dependency rather than in us. A folder
   * chosen through Android's picker is a **Storage Access Framework tree**
   * (`content://…/tree/…`), and `Directory`'s constructor joins path segments
   * as strings, which its own documentation describes in terms of `file:///`
   * URIs. A SAF document cannot be addressed by appending a filename to a tree:
   * the provider creates the document and decides its URI. So `create()` threw
   * "the containing folder doesn't exist", exactly as its docblock warns, and
   * the user saw only "could not save the copy".
   *
   * `copy()` takes a destination directory and is the documented way across, so
   * the file is built somewhere we certainly own and handed over afterwards.
   */
  const staged = new File(Paths.cache, exportFileName(document.exported_at))
  // Overwrite rather than fail: a cancelled export a second earlier may have
  // left one behind, and the cache is ours.
  staged.create({ overwrite: true })
  staged.write(JSON.stringify(document, null, 2))

  try {
    await staged.copy(directory)
  } finally {
    // The staged copy is not the deliverable and the cache is not a library.
    // Cleared whether or not the copy worked, so a failure leaves nothing.
    try {
      staged.delete()
    } catch {
      // A cache file we could not delete is not worth failing the export for.
    }
  }

  return {
    uri: directory.uri,
    songCount: document.songs.length,
    playlistCount: document.playlists.length,
    skippedLocal: document.skipped_local,
  }
}
