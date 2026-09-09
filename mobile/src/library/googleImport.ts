import { fetchGooglePlaylistItems } from '../api/google'
import { useListImportProgress } from '../api/listImportProgress'
import { resetListImportGuards, runListImport, type ListImportResult } from './listImport'
import { playlistForGooglePlaylist } from './playlists'

/**
 * Importing a **private** YouTube playlist onto this device (#106).
 *
 * ## What is missing here, and why that is the design
 *
 * No matching, no review, no server-side download, and no `PlaylistImport` row.
 * A private playlist hands back **video ids**, so there is nothing to guess and
 * nothing to confirm — 2026-08-12: *"its from youtube, user know what
 * they importing."* Review exists for Spotify because a Spotify track is not a
 * YouTube video; here the answer is exact.
 *
 * The server's part is one authenticated listing call. It never sees a byte of
 * audio, which is what "music is stored on the user's device" means.
 *
 * ## Where the loop went
 *
 * `listImport.ts`, unchanged, as of #492 — Bilibili needs the identical walk
 * over a favourites folder and the alternative was a second copy of it. What is
 * left here is the only three things about this import that are about *Google*:
 * the listing call, the playlist row, and the watch URL.
 *
 * ⚠️ **The feature is off.** `GOOGLE_IMPORT_ENABLED` in the import screen is
 * `false` (#504): `youtube.readonly` is a sensitive scope and Google offers only
 * a 7-day testing token or a verification review. The code is retained and ships
 * over the air, so flipping the constant brings it back.
 */

/**
 * The watch URL for a video id.
 *
 * The **watch** URL and never a stream URL, for the reason `deviceImport` gives:
 * stream URLs expire within hours and are tied to the address that asked, and
 * this string is also the library's identity for the video (`songs.source_url`
 * is UNIQUE since v6). It is what makes "already here" answerable at all.
 */
export function watchUrlFor(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

export type GoogleImportResult = ListImportResult

/**
 * Import one Google playlist onto this device.
 *
 * Returns `null` if a run for this playlist is already going — the caller has
 * joined it, and the progress store is where to watch it.
 *
 * Throws only if the **listing** fails, which is a different thing from a video
 * failing: it means the account, the key or the quota, and the screen names it
 * with `googleFailure`. A video that cannot be fetched is counted and the run
 * carries on.
 */
export async function importGooglePlaylistOnDevice(
  playlist: { id: string; title: string },
  onLibraryChanged?: () => void,
): Promise<GoogleImportResult | null> {
  return runListImport(
    {
      /*
       * ⚠️ **Not namespaced, unlike Bilibili's.** The progress store is keyed by
       * Google's own playlist id and the screen reads it back by that id, so a
       * prefix here would have to be threaded through `useListImportProgress`
       * and every reader of it. The guard is shared, but `PL…` cannot collide
       * with the digits Bilibili uses.
       */
      key: playlist.id,
      title: playlist.title,
      logPrefix: 'googleImport',
      listUrls: async () => {
        const tracks = await fetchGooglePlaylistItems(playlist.id)
        return tracks.map((track) => watchUrlFor(track.video_id))
      },
      ensurePlaylist: () => playlistForGooglePlaylist(playlist.id, playlist.title),
      report: (key, progress) => useListImportProgress.getState().report(key, progress),
    },
    onLibraryChanged,
  )
}

/** Test seam: the in-progress guard is module state and outlives a test. */
export function resetGoogleImportGuard(): void {
  resetListImportGuards()
}
