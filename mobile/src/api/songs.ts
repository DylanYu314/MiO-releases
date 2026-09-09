/**
 * What is left of the server's songs client (#324).
 *
 * This module used to hold `useSongs` (the library, paged from `GET /songs`)
 * and `useDeleteSong`, plus the sort and query types they needed. All of it went
 * unused when the library moved onto the device: `localLibrary.ts` reads the
 * phone's own SQLite and `localDelete.ts` removes the phone's own files, and
 * nothing has called anything here since. They were still compiling, still
 * carrying their own cache keys, and still describing a library the app no
 * longer has.
 *
 * `formatDuration` is the survivor, with five call sites. It is a pure
 * formatter with no server in it, so the honest place for it is not an `api/`
 * module — that move is deliberately **not** in this sweep, which is deletions
 * only so that it stays one clean revert. Left here, named, rather than moved
 * quietly alongside a hundred deleted lines.
 */

/** Seconds as m:ss. Null durations render as an em dash rather than "0:00",
 *  which would read as a real (and wrong) length. */
export function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}
