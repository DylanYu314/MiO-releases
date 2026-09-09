import { AppState } from 'react-native'

import { startForegroundTask, stopForegroundTask } from '../../modules/mio-foreground-task'
import { describeError, logError, logInfo, logWarn } from '../diagnostics/log'
import i18n from '../i18n'
import { importToDevice } from './deviceImport'
import { classifyFailure, isWorthRetrying } from './failureKind'
import { addSongsToPlaylist } from './playlists'
import { localIdsForSources, sourcesFullyOnDevice } from './songs'

/**
 * Importing a list of URLs onto this device, whatever produced the list.
 *
 * ## Why this is its own file
 *
 * This is `googleImport.ts` (#106) with the two Google-shaped parts lifted out.
 * It was extracted for #492, where Bilibili needs the identical loop over a
 * favourites folder — and the alternative was a second copy of 440 lines of
 * pacing, retries, ordered flush and heartbeat, which is how two loops drift
 * into two sets of bugs. Each of the rules below cost this project a device
 * pass to learn once; none of them is worth learning twice.
 *
 * **Everything source-specific is in {@link ListImportSpec}**, and there are
 * only four such things: where the URLs come from, which local playlist they
 * join, what the run is called in the log, and where progress is published.
 * Nothing below knows what a video id is.
 *
 * ## What the loop guarantees
 *
 * - **A track's failure is a track's failure.** Every entry is attempted on its
 *   own budget and the run always walks the whole list. There is no
 *   consecutive-failure limit, because five failures in a row is a reason to
 *   give up on five entries and not on the other hundred (#369).
 * - **Two at a time, paced as one.** Downloads overlap, but a new one is
 *   started no more often than a single-file loop started them — a burst is
 *   what provokes throttling (#389).
 * - **Resuming is free and is not a re-download.** Anything already fully on
 *   the device is skipped, counted as `alreadyHere`, and kept out of the
 *   progress bar's arithmetic, so a re-run over a finished list says "0 of 0"
 *   rather than "0 of 136" racing to the end (#398).
 * - **The list keeps its order**, whatever order the audio lands in.
 * - **The run's state never lies** about whether it is running.
 *
 * The server is not involved in any of it. `importToDevice` fetches every byte
 * on the phone (#246), which is what "music is stored on the user's device"
 * means.
 */

/** Pause between the *starts* of two downloads, run-wide. */
const PACE_MS = 1500

/** How many downloads are in flight at once. */
const CONCURRENCY = 2

/**
 * Attempts per entry before it is recorded as failed.
 *
 * Note how much one attempt already covers: `importToDevice` walks the whole
 * client chain and retires a client whose stream URL is refused. What the outer
 * attempts buy is **time** — the thing a dropped connection needs and a video
 * that is genuinely gone cannot be helped by, which is why a failure that is
 * not worth retrying stops immediately (#400).
 */
const ATTEMPTS_PER_TRACK = 3

/** Backoff before a given attempt (1-based); doubling, from two seconds. */
function backoffMs(attempt: number): number {
  return 2000 * 2 ** (attempt - 2)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** How often a live run says it is still alive, and in which app state. */
const HEARTBEAT_MS = 15_000

export interface ListImportProgress {
  /** Entries **finished** — downloaded or failed — of this run's work. Never a
   *  list position: a resumed run walks from the top skipping what is here, and
   *  publishing the position is what made that look like a restart (#370). */
  done: number
  /** This run's work, which is the list minus what the device already holds
   *  (#398). A re-import that has nothing to do says "0 of 0". */
  total: number
  /** Entries downloaded by this run. */
  saved: number
  failed: number
  /** Entries the device already had. Not work, so not in `done`/`total` — but
   *  published, because a list of 53 showing "12" needs the other 41 explained
   *  or the numbers look wrong. */
  alreadyHere: number
  running: boolean
}

export interface ListImportResult {
  saved: number
  failed: number
  alreadyHere: number
  local_playlist_id: string
}

/**
 * Everything a run needs to know that is not the loop.
 *
 * Deliberately four functions and two strings rather than a source enum: adding
 * a source should not mean editing this file, and a `switch` on `'google' |
 * 'bilibili'` here would put every future source's knowledge in the one place
 * that is supposed to have none of it.
 */
export interface ListImportSpec {
  /**
   * Identifies this run, for the in-progress guard and the progress store.
   *
   * ⚠️ **Namespace it.** The guard is shared across sources now, so a bare
   * playlist id could collide between two of them — unlikely with YouTube's
   * `PL…` and Bilibili's digits, and not something to leave to luck.
   */
  key: string
  /** Named in the foreground-service notification, so the shade says which
   *  import is holding it. */
  title: string
  /** This source's log-event prefix, e.g. `googleImport`. Kept per source so a
   *  log still says which import a line came from. */
  logPrefix: string
  /**
   * The list, in the order it should appear in the playlist.
   *
   * URLs and not ids: the URL is the library's identity for a track
   * (`songs.source_url` is UNIQUE since v6) and it is what makes "already here"
   * answerable at all. It must be the **canonical page** URL, never a stream
   * URL — those expire within hours and are tied to the address that asked.
   *
   * Throwing here fails the run, which is right: it means the account, the key
   * or the quota, and it is a different thing from one track failing.
   */
  listUrls: () => Promise<string[]>
  /** Find-or-create the local playlist these songs join, returning its id. */
  ensurePlaylist: () => Promise<string>
  /** Publish progress somewhere every screen can read, rather than to the mount
   *  that started the run — the run outlives the screen (ADR-019). */
  report: (key: string, progress: ListImportProgress) => void
}

/**
 * Guard against two runs of the same list.
 *
 * Module-level rather than a ref, so returning to the screen joins the run in
 * progress instead of starting a second pass over the same tracks — and so the
 * run outlives the screen at all (ADR-019).
 */
const inProgress = new Set<string>()

/** Whether a run for this key is already going. */
export function listImportRunning(key: string): boolean {
  return inProgress.has(key)
}

/** Test seam: the in-progress guard is module state and outlives a test. */
export function resetListImportGuards(): void {
  inProgress.clear()
}

/**
 * Fetch one track, with time for a connection that dropped.
 *
 * The retry decision is `isWorthRetrying`, which is the app's existing answer
 * rather than a second list of failure kinds written here. It is what stops
 * three attempts and six seconds of backoff being spent on a track that is
 * region-locked or deleted — every client was telling the truth the first time
 * (#400).
 */
async function fetchWithRetries(
  url: string,
  pace: () => Promise<void>,
  logPrefix: string,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    await pace()
    try {
      const result = await importToDevice(url, { source: 'import' })
      return result.local_id
    } catch (error) {
      const kind = classifyFailure(error)
      if (attempt >= ATTEMPTS_PER_TRACK || !isWorthRetrying(kind)) throw error
      // The elapsed shape of a failure is what distinguishes a stuck run from a
      // slow one, and the kind is what says whether waiting can help.
      logWarn(`${logPrefix}.retrying`, `attempt ${attempt} failed as ${kind}`)
      await sleep(backoffMs(attempt + 1))
    }
  }
}

/**
 * Import one list of URLs onto this device.
 *
 * Returns `null` if a run for this key is already going — the caller has joined
 * it, and the progress store is where to watch it.
 *
 * Throws only if {@link ListImportSpec.listUrls} or
 * {@link ListImportSpec.ensurePlaylist} fails, which is a different thing from
 * a track failing: it means the account, the key or the quota, and the screen
 * names it. A track that cannot be fetched is counted and the run carries on.
 */
export async function runListImport(
  spec: ListImportSpec,
  /**
   * Called whenever the library has **changed** — a row added or removed.
   *
   * Takes no argument: every caller uses it to invalidate queries, and a failed
   * track has no id to pass. A row appearing and a row disappearing are the
   * same event to a cache (#411).
   */
  onLibraryChanged?: () => void,
): Promise<ListImportResult | null> {
  if (inProgress.has(spec.key)) return null
  // Claimed **before the first await**: anything awaited above this line
  // reopens the window this guard exists to close.
  inProgress.add(spec.key)

  let heartbeat: ReturnType<typeof setInterval> | null = null

  /*
   * Declared out here so the `finally` can retract `running`.
   *
   * A run that throws *after* publishing — the playlist write, the flush, the
   * callback into React Query — would otherwise leave `running: true` in a
   * store that outlives the screen, and every mount from then on would show a
   * spinner for a run that is not happening. That is exactly the class of lie
   * `markInterrupted` exists to remove from the device-adds list.
   */
  let saved = 0
  let failed = 0
  let outstanding = 0
  let alreadyHere = 0
  let published = false

  /* Counters are `saved`/`failed`/`outstanding`; `done` and `total` are derived
   * in one place so the two can never be published disagreeing. */
  const publishAt = (running: boolean): void => {
    spec.report(spec.key, {
      done: saved + failed,
      total: outstanding,
      saved,
      failed,
      alreadyHere,
      running,
    })
  }

  try {
    const urls = await spec.listUrls()
    const localPlaylistId = await spec.ensurePlaylist()

    /*
     * What this run has to do, as opposed to what the list contains (#398).
     *
     * `sourcesFullyOnDevice` and not `sourcesWithAudio`: a track with audio and
     * no artwork still costs an extraction, so counting it as done is what
     * makes a resumed run look stalled.
     */
    const carried = await sourcesFullyOnDevice(urls)
    /*
     * Read-only, and that matters. `saveDeviceSongMetadata` would also return
     * these ids and would rewrite each row's title and artist from the raw
     * title on the way — renaming songs the library already had, every time the
     * list was re-imported (#309's mechanism).
     */
    const carriedIds = await localIdsForSources([...carried])
    outstanding = urls.filter((url) => !carried.has(url)).length
    alreadyHere = carried.size

    logInfo(`${spec.logPrefix}.started`, `${outstanding} to fetch, ${carried.size} already here`)

    /*
     * Ask Android not to freeze us (#371, ADR-019).
     *
     * Claimed after the listing, deliberately: a run that cannot reach its
     * source ends in seconds and has nothing to protect, and a notification for
     * it would be the shortest-lived lie in the app.
     *
     * A foreground service makes a run much harder to kill, not immortal — and
     * background imports are de-scoped (2026-08-10), so the screen also says to
     * keep it open. Resuming is what actually makes that safe.
     */
    logInfo(
      `${spec.logPrefix}.foregroundTask`,
      startForegroundTask(
        i18n.t('importNotification.title'),
        i18n.t('importNotification.body', { name: spec.title }),
      ),
    )

    const report = (running = true): void => {
      published = true
      publishAt(running)
    }

    // Published before the first download, so a long list shows its size rather
    // than nothing while the first extraction runs.
    report()

    heartbeat = setInterval(() => {
      logInfo(
        `${spec.logPrefix}.alive`,
        `done=${saved + failed}/${outstanding} failed=${failed} state=${AppState.currentState}`,
      )
    }, HEARTBEAT_MS)

    /*
     * One start every `PACE_MS`, across the whole run — shared rather than a
     * pause at the bottom of each worker, which with two workers would double
     * the rate at which downloads are started.
     */
    let nextStart = 0
    const pace = async (): Promise<void> => {
      const now = Date.now()
      const wait = Math.max(0, nextStart - now)
      nextStart = Math.max(now, nextStart) + PACE_MS
      if (wait > 0) await sleep(wait)
    }

    /*
     * The playlist ends up in the list's order, whatever order the audio lands
     * in.
     *
     * `landed[i]` is `undefined` until track *i* is decided, then its local id
     * or null. Adding is therefore not "as they finish" but "as the next
     * unbroken run of decided tracks becomes available" — so track 4 cannot
     * take track 3's place merely because 3 downloads more slowly.
     */
    const landed: (string | null | undefined)[] = new Array(urls.length).fill(undefined)
    let flushed = 0

    /** Serialises the cursor below: two workers finishing at once must not both
     *  read `flushed` and add the same songs twice. */
    let ordered: Promise<unknown> = Promise.resolve()
    const inOrder = <T>(work: () => Promise<T>): Promise<T> => {
      const next = ordered.then(work)
      ordered = next.catch(() => undefined)
      return next
    }

    const flush = () =>
      inOrder(async () => {
        const ready: string[] = []
        let cursor = flushed
        while (cursor < landed.length && landed[cursor] !== undefined) {
          const id = landed[cursor]
          if (id) ready.push(id)
          cursor += 1
        }
        if (ready.length > 0) await addSongsToPlaylist(localPlaylistId, ready)
        /*
         * **Advanced only once the write has succeeded.**
         *
         * Advancing first loses these songs from the playlist for good if the
         * write throws — and worse, it makes the *run* look successful, because
         * the flush at the end then finds nothing left to do and returns
         * happily over an empty playlist. Left where it is, a transient failure
         * (#437's transaction collisions are real) is simply retried by the
         * next flush, and a persistent one reaches the end and fails the run,
         * which is the truth: the audio is here and the playlist is not.
         */
        flushed = cursor
      })

    const handle = async (index: number): Promise<void> => {
      const url = urls[index]

      // Already here from an earlier run, or from another playlist. This is
      // what makes resuming free — and it still joins the playlist.
      if (carried.has(url)) {
        landed[index] = carriedIds.get(url) ?? null
        return
      }

      try {
        landed[index] = await fetchWithRetries(url, pace, spec.logPrefix)
        saved += 1
      } catch (error) {
        // Named at warn level and counted. `importToDevice` has already
        // recorded the reason against this track in `useDeviceAdds`, which is
        // what the screen shows; this line is for the uploaded log, so it
        // carries the position and never the title (#322, #354).
        logWarn(`${spec.logPrefix}.trackFailed`, `#${index}: ${describeError(error)}`)
        landed[index] = null
        failed += 1
      }
      // Whether it landed or not: `importToDevice` removes the row it made for
      // a track whose audio never arrived, and a row disappearing changes the
      // library exactly as much as one appearing (#411).
      onLibraryChanged?.()
      report()
    }

    let cursor = 0
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
        for (;;) {
          const index = cursor++
          if (index >= urls.length) return
          try {
            await handle(index)
          } catch (error) {
            /*
             * `handle` guards the download; this guards everything else in it —
             * the callback into React Query, and anything else that throws
             * where the code assumed it could not. Propagating would end the
             * worker's loop and release the run's guard while the *other*
             * worker was still downloading (#437's shape).
             */
            logError(`${spec.logPrefix}.trackThrew`, `#${index}: ${describeError(error)}`)
            // Only if this track had not already been decided. Counting it
            // again is how a run reported three saved **and** three failed for
            // one broken playlist write — `done` past `total`, which is the
            // arithmetic nobody can reconcile and therefore nobody trusts.
            if (landed[index] === undefined) {
              landed[index] = null
              failed += 1
            }
          }
          /*
           * **Outside the per-track guard, deliberately.**
           *
           * A playlist write that fails is the *run's* failure, not this
           * track's: the audio is on the device either way. Flushing inside the
           * guard above attributed a broken `addSongsToPlaylist` to every track
           * in the list, so the run claimed three downloaded and three failed
           * at the same time. Out here it propagates, the run ends, and the
           * screen says so.
           */
          await flush()
        }
      }),
    )

    for (const outcome of results) {
      if (outcome.status === 'rejected') {
        logError(`${spec.logPrefix}.workerThrew`, describeError(outcome.reason))
      }
    }

    // Anything the workers could not flush — a run whose last track threw
    // inside `flush` itself leaves the tail undecided, and the playlist should
    // still get what did land.
    await flush()
    report(false)

    return {
      saved,
      failed,
      alreadyHere,
      local_playlist_id: localPlaylistId,
    }
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat)
    // Never leave a spinner behind for a run that has stopped, however it did.
    if (published) publishAt(false)
    inProgress.delete(spec.key)
    /*
     * Released however the run ended — finished, or thrown out of the listing
     * call before a service was ever started. Stopping one that is not running
     * is a no-op, and anywhere more precise would leave a path that returns
     * with a permanent notification for an import that ended minutes ago.
     */
    stopForegroundTask()
  }
}
