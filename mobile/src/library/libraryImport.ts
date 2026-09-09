import { File } from 'expo-file-system'

import { useListImportProgress } from '../api/listImportProgress'
import {
  LIBRARY_EXPORT_FORMAT,
  LIBRARY_EXPORT_VERSION,
  isUnfetchable,
  type ExportedPlaylist,
  type ExportedSong,
  type LibraryExport,
} from './libraryExport'
import { runListImport, type ListImportResult } from './listImport'
import { addSongsToPlaylist, createPlaylist, deletePlaylist, favouritesPlaylist } from './playlists'
import { localIdsForSources } from './songs'

/**
 * Read a library file written by another phone (#729).
 *
 * ## ⛔ Why this validates every field instead of casting
 *
 * The file comes off a user's storage. It may be a copy of something else with
 * a `.json` name, a file from a newer MiO, or a truncated transfer — and the
 * consequence of half-reading one is worse here than usual, because the next
 * step downloads hundreds of tracks. A parser that trusts its input turns a
 * wrong file into an hour of downloading and a corrupted library.
 *
 * ⚠️ **The shape of the body is the only trustworthy signal**, which is the same
 * reading `latestVersion.ts` had to make: a plausible-looking `.json` is easy to
 * produce by accident, and neither the filename nor the extension carries any
 * information about what is inside.
 *
 * ## What is deliberately tolerant
 *
 * Unknown **extra** fields are ignored rather than refused. A file from a newer
 * MiO with the same `version` is one that added something optional, and refusing
 * it would make every future addition a breaking change.
 *
 * ⛔ A newer `version` is refused outright. That is the field's whole purpose:
 * it is bumped only when an older reader *cannot* read the file, so attempting
 * one is the mistake it exists to prevent.
 */

/** Why a file could not be read, in a form the UI can turn into a sentence. */
export type LibraryImportRejection =
  | { reason: 'not-json' }
  | { reason: 'not-a-library' }
  | { reason: 'too-new'; version: number }
  | { reason: 'empty' }

export class LibraryImportError extends Error {
  readonly rejection: LibraryImportRejection

  constructor(rejection: LibraryImportRejection) {
    super(`library import rejected: ${rejection.reason}`)
    this.name = 'LibraryImportError'
    this.rejection = rejection
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A song row, or null when it carries nothing usable. */
function readSong(value: unknown): ExportedSong | null {
  if (!isRecord(value)) return null

  const { source_url: sourceUrl, source_platform: platform, title, artist } = value
  if (typeof sourceUrl !== 'string' || sourceUrl === '') return null

  /*
   * ⛔ A `local:` entry cannot be fetched by this device any more than it could
   * by the one that wrote the file, so it is dropped here as well as there.
   *
   * The exporter already filters them, so reaching this means a hand-edited
   * file or one from a future version — either way, importing a row whose audio
   * can never arrive would put a permanently broken song in the library.
   */
  if (isUnfetchable(sourceUrl)) return null

  return {
    source_url: sourceUrl,
    source_platform: typeof platform === 'string' && platform !== '' ? platform : 'unknown',
    // Titles are cosmetic here: the download re-reads the real metadata from
    // the source, so a missing one costs a placeholder rather than the track.
    title: typeof title === 'string' ? title : '',
    artist: typeof artist === 'string' ? artist : '',
    album: typeof value.album === 'string' ? value.album : null,
    duration: typeof value.duration === 'number' ? value.duration : null,
  }
}

function readPlaylist(value: unknown, known: ReadonlySet<string>): ExportedPlaylist | null {
  if (!isRecord(value)) return null
  const { name, kind, songs } = value
  if (typeof name !== 'string' || name === '') return null

  return {
    name,
    kind: typeof kind === 'string' && kind !== '' ? kind : 'user',
    /*
     * ⚠️ Filtered against the songs this file actually carries.
     *
     * An entry naming a song that is not in `songs` would become a playlist
     * position pointing at nothing — a hole that no later step reports, which
     * is the failure mode the exporter avoids on its side too.
     */
    songs: Array.isArray(songs)
      ? songs.filter((url): url is string => typeof url === 'string' && known.has(url))
      : [],
  }
}

/**
 * Parse and validate a library file.
 *
 * @throws {LibraryImportError} with a reason the UI can explain.
 */
export function parseLibraryExport(text: string): LibraryExport {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new LibraryImportError({ reason: 'not-json' })
  }

  if (!isRecord(raw) || raw.format !== LIBRARY_EXPORT_FORMAT) {
    throw new LibraryImportError({ reason: 'not-a-library' })
  }

  const version = typeof raw.version === 'number' ? raw.version : 0
  if (version > LIBRARY_EXPORT_VERSION) {
    throw new LibraryImportError({ reason: 'too-new', version })
  }

  const songs: ExportedSong[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(raw.songs) ? raw.songs : []) {
    const song = readSong(entry)
    // `source_url` is UNIQUE in the schema, so a duplicate here is not merely
    // wasteful — it would be a constraint failure partway through the run.
    if (song && !seen.has(song.source_url)) {
      seen.add(song.source_url)
      songs.push(song)
    }
  }

  if (songs.length === 0) {
    // Not an error about the file's shape, but there is nothing to do and
    // saying "0 songs" after a folder picker reads as a failure anyway.
    throw new LibraryImportError({ reason: 'empty' })
  }

  const playlists: ExportedPlaylist[] = []
  for (const entry of Array.isArray(raw.playlists) ? raw.playlists : []) {
    const playlist = readPlaylist(entry, seen)
    if (playlist) playlists.push(playlist)
  }

  return {
    format: LIBRARY_EXPORT_FORMAT,
    version,
    exported_at: typeof raw.exported_at === 'string' ? raw.exported_at : '',
    songs,
    playlists,
    skipped_local: typeof raw.skipped_local === 'number' ? raw.skipped_local : 0,
  }
}

/** What the user is about to take on, so the screen can say it before starting. */
export interface LibraryImportSummary {
  songCount: number
  playlistCount: number
  exportedAt: string
}

export function summarise(document: LibraryExport): LibraryImportSummary {
  return {
    songCount: document.songs.length,
    // Favourites is a playlist row, and it already exists on this device — so
    // it is restored into rather than created, and counting it as a new
    // playlist would overstate what is about to appear.
    playlistCount: document.playlists.filter((playlist) => playlist.kind !== 'favourites').length,
    exportedAt: document.exported_at,
  }
}

/**
 * Every URL to fetch, in the order the file lists them.
 *
 * ⚠️ Order matters even though these are songs rather than a playlist: it is
 * what makes a resumed run continue where it stopped rather than pick a new
 * arbitrary order, and `listImport.ts` keeps the list's order on the way in.
 */
export function urlsToFetch(document: LibraryExport): string[] {
  return document.songs.map((song) => song.source_url)
}

/**
 * What a playlist restore should do, worked out before anything is written.
 *
 * Pure so the ordering and the favourites rule can be tested without a
 * database — the interesting part is which songs, in which order, into which
 * playlist, and none of that needs SQLite to be wrong.
 */
export interface PlaylistRestorePlan {
  name: string
  /** Favourites already exists on every device; it is restored into, not made. */
  intoFavourites: boolean
  /** Local song ids, in the file's order, for songs this device actually has. */
  songIds: string[]
}

/**
 * ⚠️ **Songs the run failed to fetch are simply absent**, and the playlist is
 * built from what arrived rather than being abandoned. A restore that refused
 * to rebuild a 200-track playlist because two tracks were region-locked would
 * be worse than one with 198 in it — the same reasoning as
 * `listImport.ts`'s "a track's failure is a track's failure" (#369).
 */
export function planPlaylistRestore(
  playlists: readonly ExportedPlaylist[],
  localIdBySourceUrl: ReadonlyMap<string, string>,
): PlaylistRestorePlan[] {
  const plans: PlaylistRestorePlan[] = []

  for (const playlist of playlists) {
    const songIds = playlist.songs
      .map((url) => localIdBySourceUrl.get(url))
      .filter((id): id is string => typeof id === 'string')

    // Nothing arrived for this one. Creating an empty playlist would leave the
    // user tidying up after a restore that looked like it worked.
    if (songIds.length === 0) continue

    plans.push({
      name: playlist.name,
      intoFavourites: playlist.kind === 'favourites',
      songIds,
    })
  }

  return plans
}

/** The key the progress store and the in-progress guard use for a copy. */
export function libraryImportKey(document: LibraryExport): string {
  // ⚠️ Namespaced. The guard is shared across sources, and a bare timestamp
  // could collide with nothing today and something tomorrow.
  return `libraryCopy:${document.exported_at}`
}

export interface LibraryImportOutcome {
  run: ListImportResult | null
  songsArrived: number
  playlistsRestored: number
}

/**
 * Download everything in a library file, then rebuild its playlists.
 *
 * ## Why the two phases, and why a holding playlist
 *
 * `runListImport` joins **one** playlist per run — it was written for importing
 * a playlist, which is what every other source does. A library has many, so the
 * download runs once over every song and the playlists are rebuilt afterwards
 * from local ids, which only exist once the songs do.
 *
 * ⚠️ The holding playlist exists because `ensurePlaylist` is required, not
 * because anyone wants it. It is deleted once the real playlists are in, and
 * deleting a playlist removes the playlist and its entries, never the songs.
 *
 * ⛔ **Everything below reuses the loop rather than reimplementing it.** Pacing,
 * two-at-a-time, per-track budgets, resume-is-free, ordered flush and the
 * foreground-service heartbeat each cost a device pass to get right (#369,
 * #389, #398, #411) and none of it is source-specific.
 */
export async function runLibraryImport(
  document: LibraryExport,
  onLibraryChanged?: () => void,
): Promise<LibraryImportOutcome> {
  const urls = urlsToFetch(document)
  const holdingId = await createPlaylist(holdingPlaylistName(document))

  const run = await runListImport(
    {
      key: libraryImportKey(document),
      title: holdingPlaylistName(document),
      logPrefix: 'libraryImport',
      listUrls: async () => urls,
      ensurePlaylist: async () => holdingId,
      report: (key, progress) => useListImportProgress.getState().report(key, progress),
    },
    onLibraryChanged,
  )

  // Read *after* the run: a local id exists only once its song does, and the
  // ones that failed are simply absent, which is what the planner expects.
  const localIds = await localIdsForSources(urls)
  const plans = planPlaylistRestore(document.playlists, localIds)

  for (const plan of plans) {
    const playlistId = plan.intoFavourites
      ? (await favouritesPlaylist()).id
      : await createPlaylist(plan.name)
    await addSongsToPlaylist(playlistId, plan.songIds)
  }

  await deletePlaylist(holdingId)
  onLibraryChanged?.()

  return { run, songsArrived: localIds.size, playlistsRestored: plans.length }
}

/**
 * ⚠️ Visible in the foreground-service notification while the copy runs, so it
 * says what is happening rather than showing a bare id.
 */
function holdingPlaylistName(document: LibraryExport): string {
  const day = document.exported_at.slice(0, 10)
  return day ? `Copied library ${day}` : 'Copied library'
}

/**
 * Ask for a file, read it, and validate it — without starting anything.
 *
 * ⚠️ Split from {@link runLibraryImport} deliberately. The user should see what
 * is in a file, and be told plainly if it is the wrong one, **before** an hour
 * of downloading begins. A picker that went straight to work would make an
 * accidental tap expensive.
 *
 * Returns **null** when the user cancelled, which is not a failure and must not
 * be reported as one.
 *
 * @throws {LibraryImportError} when the file is not one MiO can read.
 */
export async function pickLibraryFile(): Promise<LibraryExport | null> {
  const picked = await File.pickFileAsync({
    /*
     * ⚠️ `application/json` alone hides the file on most devices. Android's
     * document providers type files from their extension and routinely hand a
     * `.json` back as `application/octet-stream` or `text/plain` — the same
     * trap `pickLocalAudioFiles` documents for `.flac` and `.m4a`, where the
     * wildcard alone left the user told, wrongly, that they had no files.
     */
    mimeTypes: ['application/json', 'text/plain', 'application/octet-stream'],
  })

  /*
   * ⛔ `pickFileAsync` resolves to `{ result, canceled }` — **not** to a `File`.
   *
   * The first version of this treated the return value as the file itself, so
   * `.text()` was not a function, the TypeError was swallowed by a catch that
   * assumed any non-`LibraryImportError` was a cancelled picker, and choosing a
   * file did visibly nothing. `pickLocalAudioFiles` had the correct shape in
   * this same directory the whole time.
   *
   * ⚠️ Reading `canceled` here is also what lets the caller stop guessing: a
   * cancel is now `null`, so anything thrown is a real failure and can be said
   * out loud.
   */
  if (picked.canceled) return null

  return parseLibraryExport(await picked.result.text())
}
