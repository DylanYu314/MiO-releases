import { useListImportProgress } from '../api/listImportProgress'
import { fetchFavList } from './bilibiliFav'
import type { BilibiliPart } from './bilibili'
import { resetListImportGuards, runListImport, type ListImportResult } from './listImport'
import { playlistForBilibiliFav, playlistForBilibiliVideo } from './playlists'

/**
 * Importing a Bilibili favourites folder onto this device (#492, slice 3).
 *
 * ## It is `googleImport.ts` with a different list
 *
 * The loop is `listImport.ts` and nothing here re-implements any of it. What is
 * left is the three things that are about *Bilibili*: the folder listing, the
 * playlist row, and the run's key.
 *
 * There is **no matching and no review**, for the same reason a private YouTube
 * playlist has none (ADR-014): a favourites folder hands back exact `bvid`s, so
 * there is nothing to guess. Review exists for Spotify because a Spotify track
 * is not a video.
 *
 * ## The phone fetches it, not the droplet
 *
 * `importToDevice` routes on `platformOf()` since #492, so a `bilibili.com`
 * URL is extracted on the device like any other (#246). `add/bilibili.tsx` —
 * the server-side downloader — is no longer where Bilibili goes; what is left
 * there is any *other* site yt-dlp supports.
 *
 * ## What the folder count will not match, and why that is correct
 *
 * `fetchFavList` drops entries Bilibili has already retired (`attr !== 0`,
 * measured as exactly the rows titled 已失效视频) and types that are not a
 * fetchable video. So a folder Bilibili calls 55 can legitimately import 52.
 * `skipped` carries that number, and the caller shows it — a count that
 * silently disagrees with the one Bilibili displays is the kind of thing that
 * reads as a bug forever.
 */

/** Progress and the in-progress guard are keyed by this. Namespaced because the
 *  guard is shared with every other source and a `media_id` is bare digits. */
export function bilibiliImportKey(mediaId: string): string {
  return `bilibili:${mediaId}`
}

export interface BilibiliImportResult extends ListImportResult {
  /** Entries the folder holds that cannot be fetched — dead, or not a video.
   *  Not a failure: nothing was attempted and nothing went wrong. */
  skipped: number
}

/**
 * Import one Bilibili favourites folder onto this device.
 *
 * Returns `null` if a run for this folder is already going — the caller has
 * joined it, and {@link useListImportProgress} is where to watch it.
 *
 * Throws only if the **folder listing** fails, which is a different thing from
 * a track failing: it means the session is dead or the folder is not readable,
 * and the screen names it. A video that cannot be fetched is counted and the
 * run carries on.
 */
export async function importBilibiliFavOnDevice(
  folder: { mediaId: string; title: string },
  onLibraryChanged?: () => void,
): Promise<BilibiliImportResult | null> {
  /*
   * Captured from inside `listUrls` rather than fetched twice.
   *
   * The loop owns when the listing happens — it must be inside the run so a
   * failure fails the run and releases the guard — but `skipped` is only known
   * once it has. Fetching the folder again out here to read one number would
   * double a request that #492 measured a rate ceiling on.
   */
  let skipped = 0

  const result = await runListImport(
    {
      key: bilibiliImportKey(folder.mediaId),
      title: folder.title,
      logPrefix: 'bilibiliImport',
      listUrls: async () => {
        const list = await fetchFavList(folder.mediaId)
        skipped = list.skipped
        return list.entries.map((entry) => entry.url)
      },
      ensurePlaylist: () => playlistForBilibiliFav(folder.mediaId, folder.title),
      report: (key, progress) => useListImportProgress.getState().report(key, progress),
    },
    onLibraryChanged,
  )

  return result === null ? null : { ...result, skipped }
}

/**
 * Import the chosen parts of one multi-part Bilibili video (#575).
 *
 * ## Why this is the list loop and not a `for` over `importToDevice`
 *
 * Because 多P is **Bilibili-shaped, not Spotify-shaped**: the parts are exact
 * ids, so there is nothing to search for, nothing to score and nothing to
 * review — the same reason a favourites folder and a private YouTube playlist
 * have none (ADR-014). `listImport.ts` is the walk that already knows how to
 * pace, retry, flush in order and hold a foreground service, and each of those
 * rules cost a device pass to learn (#369, #389, #398, #411, #437). A hand-
 * rolled loop in a screen would inherit none of them.
 *
 * ## The playlist
 *
 * Several parts make one, named after the upload and keyed on its `bvid`
 * (schema v9), so importing the rest later fills in the same playlist rather
 * than building a second beside it. **One** part does not come through here at
 * all — the caller sends a single choice down the ordinary add-link path, where
 * a lone track has never made a playlist and should not start now.
 */
export function bilibiliPartsImportKey(bvid: string): string {
  return `bilibili-parts:${bvid}`
}

export async function importBilibiliPartsOnDevice(
  video: { bvid: string; title: string; parts: readonly BilibiliPart[] },
  onLibraryChanged?: () => void,
): Promise<ListImportResult | null> {
  return runListImport(
    {
      key: bilibiliPartsImportKey(video.bvid),
      title: video.title,
      logPrefix: 'bilibiliParts',
      // Already in hand: the caller listed them to ask which ones, so fetching
      // again here would repeat a request for an answer it is holding. The
      // order is the user's choice order, which `listImport` preserves.
      listUrls: async () => video.parts.map((part) => part.url),
      ensurePlaylist: () => playlistForBilibiliVideo(video.bvid, video.title),
      report: (key, progress) => useListImportProgress.getState().report(key, progress),
    },
    onLibraryChanged,
  )
}

/** Test seam: the in-progress guard is module state and outlives a test. */
export function resetBilibiliImportGuard(): void {
  resetListImportGuards()
}
