import { apiFetch } from '../api/client'
import { useConnection } from '../api/connection'
import { getInstallId } from '../api/installId'
import type { PlaylistDetail, Song } from '../api/types'
import { describeError, logWarn } from '../diagnostics/log'
import { addSongsToPlaylist, playlistForServerImport } from './playlists'
import { getLocalSongByServerId, saveSongToDevice, type DownloadContext } from './songs'

/**
 * The handover: the server finishing is not the end of an import (#159, #215).
 *
 * Under local-first a song is in the library when its audio is on **this
 * device**, so every path that adds music has to end with a download. This used
 * to live inside `ImportProgressPanel`, which meant two things:
 *
 * - a UI component was the thing that downloaded music, so the download's
 *   lifetime was a component's lifetime;
 * - and only the one entry point that mounted it — add-a-link — actually handed
 *   anything over. Adding from search created a job nobody watched, and a
 *   confirmed playlist import ran entirely server-side, so **two of the three
 *   ways to add music put nothing on the device**. Invisible only for as long as
 *   the library still read `GET /songs`.
 *
 * So it lives here, as plain functions, and all three call it.
 *
 * ## Idempotent by construction
 *
 * Nothing here records "already handed over". A song whose row has a `file_uri`
 * is skipped, because that column is a fact about the disk (`songs.ts`) rather
 * than a hope. That makes every entry point safely re-runnable — re-opening a
 * screen resumes a part-finished playlist instead of re-downloading it, and a
 * failure leaves exactly the un-downloaded songs to try again.
 */

/**
 * Where to download from, and the headers that make it work.
 *
 * Read from the store rather than passed in, because the callers are effects and
 * a background loop, not components with props. `null` when no server is
 * configured — there is nothing to hand over from.
 */
export function handoverContext(): DownloadContext | null {
  const { serverUrl, accessKey } = useConnection.getState()
  if (!serverUrl) return null

  const installId = getInstallId()
  return {
    serverUrl,
    headers: {
      // The audio endpoint 404s without this — ownership is the install (#170).
      ...(installId ? { 'X-Install-Id': installId } : {}),
      ...(accessKey ? { 'X-Unlock-Key': accessKey } : {}),
    },
  }
}

/** Whether this song's audio is already here, so the download can be skipped.
 *
 *  Looked up by the **server's** id, not the local one: the caller has a server
 *  song and this device mints its own ids for them (#246). Using `getLocalSong`
 *  here would silently never match, and every import would download again. */
async function alreadyOnDevice(serverSongId: number): Promise<boolean> {
  const local = await getLocalSongByServerId(serverSongId)
  return local?.file_uri != null
}

/**
 * Put one song on the device, given its id.
 *
 * Throws if the fetch or the download fails. Callers deliberately do **not**
 * mark anything as finished on failure: the entry stays visibly unfinished and
 * the next attempt retries it, where swallowing the error *and* marking it done
 * would lose the song silently.
 */
export async function handOverSong(songId: number): Promise<void> {
  const context = handoverContext()
  if (!context) throw new Error('No server configured')
  if (await alreadyOnDevice(songId)) return

  const song = await apiFetch<Song>(`/songs/${songId}`)
  await saveSongToDevice(song, context)
  await releaseServerCopy(songId)
}

/**
 * Tell the server this device has the file, so it can delete its own copy
 * (#221, ADR-017).
 *
 * **After `saveSongToDevice` and never before it.** That call writes the bytes
 * and only then records `file_uri`, so by the time this line runs the audio is
 * on disk and the library knows where. Confirming any earlier would delete the
 * server's copy while the download that needs it is still running — and the
 * handover's own retry reads that copy, which is exactly why the trigger cannot
 * be the job reaching `done`.
 *
 * Failures are swallowed. A confirmation that does not arrive costs the server
 * some disk; a confirmation that *throws* would fail a handover whose whole job
 * — getting the audio onto the phone — has already succeeded. The server keeps
 * its copy, the next handover of this song finds it already on the device and
 * returns early, and nothing is broken. That asymmetry is the whole reason this
 * is best-effort.
 */
async function releaseServerCopy(songId: number): Promise<void> {
  try {
    await apiFetch<void>(`/songs/${songId}/confirm-receipt`, { method: 'POST' })
  } catch (error) {
    logWarn('handover.releaseFailed', describeError(error))
  }
}

export interface PlaylistHandoverResult {
  /** Songs that reached the device on this run, plus those already here. */
  saved: number
  /** Songs whose download failed. They keep their row, so they are retryable. */
  failed: number
  /** This device's playlist for the import, when anything was imported (#225). */
  local_playlist_id: string | null
}

/**
 * Guard against two runs of the same playlist at once.
 *
 * The trigger is a render-driven effect on a screen that receives WebSocket
 * updates, so it fires again on every frame of an import's tail. Module-level
 * rather than a ref, so returning to the screen mid-download joins the run in
 * progress instead of starting a second one against the same files.
 */
const inProgress = new Set<number>()

/**
 * Put every song a confirmed playlist import produced on the device.
 *
 * A confirmed import has no per-song job for the client to watch — it is one
 * server-side run that ends with a playlist. So the playlist itself is the list
 * of what to download.
 *
 * One song failing does not stop the rest: partial success is success and
 * visible, the same rule the backend's own import follows. The count comes back
 * so a caller can say what happened — `null` when a run was already going, which
 * is not a result of zero songs and must not be shown as one.
 */
export async function handOverPlaylist(playlistId: number): Promise<PlaylistHandoverResult | null> {
  if (inProgress.has(playlistId)) return null
  inProgress.add(playlistId)

  try {
    const context = handoverContext()
    if (!context) throw new Error('No server configured')

    const playlist = await apiFetch<PlaylistDetail>(`/playlists/${playlistId}`)
    /**
     * The playlist is built **here**, on the device (#225).
     *
     * A confirmed import creates a playlist on the server and hands over the
     * songs. Since #219 the device owns playlists, so without this the import
     * downloaded a pile of loose songs and its "Open playlist" link pointed at
     * an id this phone has never heard of.
     */
    const localPlaylistId = await playlistForServerImport(playlistId, playlist.name)
    const localSongIds: string[] = []
    let saved = 0
    let failed = 0

    // Sequential on purpose: this is tens of tracks over a phone's connection,
    // and the server paces its own downloads for the same reason. Parallelism
    // here would buy little and risk both ends at once.
    for (const item of playlist.items) {
      try {
        if (await alreadyOnDevice(item.song.id)) {
          const existing = await getLocalSongByServerId(item.song.id)
          if (existing) localSongIds.push(existing.id)
          saved += 1
          continue
        }
        localSongIds.push(await saveSongToDevice(item.song, context))
        saved += 1
      } catch {
        // The row survives, so the song is visible in the library as present
        // but not downloaded, and the next run picks it up.
        failed += 1
      }
    }

    // Order preserved: the playlist's order is the import's order, and adding
    // them one pass at the end keeps it so even when some downloads failed.
    if (localSongIds.length > 0) {
      await addSongsToPlaylist(localPlaylistId, localSongIds)
    }

    return { saved, failed, local_playlist_id: localSongIds.length > 0 ? localPlaylistId : null }
  } finally {
    inProgress.delete(playlistId)
  }
}

/** Test seam: the in-progress guard is module state and outlives a test. */
export function resetHandoverGuard(): void {
  inProgress.clear()
}
