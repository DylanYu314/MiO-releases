import AsyncStorage from '@react-native-async-storage/async-storage'

import type { FailureKind } from './failureKind'
import type { PlaylistImportResult } from './playlistImport'

const KEY = 'mio-finished-imports'

/** How many are remembered. A number, not "forever": this is a record of what
 *  happened, and nobody scrolls back through fifty imports. */
const LIMIT = 20

export interface FinishedImport {
  importId: string
  saved: number
  failed: number
  /** Accepted tracks that were the same video as another (#398 follow-up).
   *  Optional: records written before it existed simply do not have it. */
  duplicates?: number
  gaveUp: boolean
  local_playlist_id: string
  finishedAt: string
  /**
   * Why each failed track failed, by source URL (#452).
   *
   * Only the failures. A `done` track is already answered by the library
   * holding its audio, and writing 135 entries to record that 131 worked is a
   * cost with no reader.
   *
   * Optional, because records written before this existed do not have it — and
   * a failed row with no reason is still a failed row, which is where the
   * screen was before.
   */
  failures?: Record<string, FailureKind>
}

/**
 * Which playlist imports have already been fetched onto this device (#308).
 *
 * ## Why this exists at all
 *
 * Nothing recorded that an import had finished. The only guard was a
 * module-level `Set` that dies with the JS context, and the screen's gate was
 * the server's `status === "done"` — which is permanently true from the moment
 * the matches are confirmed. So **every mount re-ran the entire loop**: it
 * re-paged every match, re-UPSERTed every row and re-added every playlist
 * entry, in a fraction of a second, which is what "every time I open this
 * record it reloads 0/13 → 13/13" was. The same fault re-drove Spotify's
 * matching on every open (#311).
 *
 * The download itself was already skipped for tracks that had a file, so the
 * replay was cheap and invisible — and it still told the user their finished
 * import was starting again, which is its own kind of lie.
 *
 * ## Why AsyncStorage rather than a table
 *
 * This is a record *about* an import, not part of the library, and the library
 * schema is the thing a migration can break. It is also deliberately small: it
 * answers one question, and #318 is the issue that turns "what happened to my
 * imports" into a real per-source record with links, titles and thumbnails.
 * When that lands this should fold into it rather than sit beside it.
 */
export async function rememberFinishedImport(
  importId: string,
  result: PlaylistImportResult,
  /** Why each failed track failed. Absent for callers that do not know — the
   *  record is still worth writing without it. */
  failures?: Record<string, FailureKind>,
): Promise<void> {
  const finished = await finishedImports()
  const next: FinishedImport[] = [
    {
      importId,
      ...result,
      // Omitted rather than written empty, so "this import predates reasons"
      // and "this import had no failures" stay distinguishable.
      ...(failures && Object.keys(failures).length > 0 ? { failures } : {}),
      finishedAt: new Date().toISOString(),
    },
    // Any earlier record of the *same* import is replaced, not kept beside the
    // new one: a retry that fetches the four tracks that failed last time is
    // the truth about that import now.
    ...finished.filter((entry) => entry.importId !== importId),
  ].slice(0, LIMIT)

  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Failing to record it means the import runs again next time, which is
    // wasteful and harmless. It is not worth failing an import that worked.
  }
}

/** What happened last time this import was fetched, or null if it never was. */
export async function finishedImport(importId: string): Promise<FinishedImport | null> {
  const finished = await finishedImports()
  return finished.find((entry) => entry.importId === importId) ?? null
}

/** Every import this device has finished, newest first. */
export async function allFinishedImports(): Promise<FinishedImport[]> {
  return finishedImports()
}

async function finishedImports(): Promise<FinishedImport[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    // Anything unrecognisable is treated as nothing rather than trusted: the
    // cost of being wrong is one repeated import, and the cost of trusting a
    // bad shape is a screen that cannot render.
    return Array.isArray(parsed) ? (parsed as FinishedImport[]) : []
  } catch {
    return []
  }
}

/**
 * Forget one import, which is what the retry button is (#370).
 *
 * The record is the thing that stops `importPlaylistOnDevice` running twice, so
 * "try the two that failed again" is exactly "forget that this finished". The
 * run that follows is not a re-import: every track already on disk is skipped
 * by the `file_uri` branch, so the work is the failures and nothing else.
 *
 * Deliberately not automatic. A playlist import is long and paces itself, so
 * re-running one unasked would spend minutes on a decision nobody made.
 */
export async function forgetFinishedImport(importId: string): Promise<void> {
  const finished = await finishedImports()
  const next = finished.filter((entry) => entry.importId !== importId)
  if (next.length === finished.length) return
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Same reasoning as writing one: failing to forget means the retry button
    // does nothing, which is visible and harmless. It is not worth throwing.
  }
}

/** Test seam, and the answer to "I want to import that again": forget
 *  everything recorded here. */
export async function forgetFinishedImports(): Promise<void> {
  await AsyncStorage.removeItem(KEY)
}
