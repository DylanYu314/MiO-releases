import {
  isForegroundTaskRunning,
  startForegroundTask,
  stopForegroundTask,
} from '../../modules/mio-foreground-task'
import { AppState } from 'react-native'

import { useImportProgress } from '../api/importProgress'
import { describeError, logError, logInfo, logWarn } from '../diagnostics/log'
import { failuresIn, useTrackStates, type TrackPhase } from '../api/trackStates'
import { classifyFailure, type FailureKind } from './failureKind'
import i18n from '../i18n'
import { VideoUnavailable } from './extract'
import { extractorFor } from './deviceImport'
import { finishedImport, rememberFinishedImport } from './finishedImports'
import { addSongsToPlaylist } from './playlists'
import {
  playlistForImport,
  listMatches,
  updateImport,
  type LocalTrackMatch,
} from './playlistImports'
import {
  DownloadWasShort,
  downloadAudioFromUrl,
  getLocalSong,
  removeSongIfEmpty,
  saveCover,
  saveDeviceSongMetadata,
  sourcesFullyOnDevice,
  setSongLoudness,
} from './songs'

/**
 * Importing a reviewed playlist onto this device (#268).
 *
 * The last entry point that still downloaded on the server, and therefore the
 * last one refused by YouTube: measured at 1 success in 14 from the droplet
 * (#177), so a forty-track playlist landed about three songs. The phone is not
 * refused, because the request comes from a residential address.
 *
 * The server still fetches the listing, does the matching, and holds the review
 * state — none of that is what fails. `POST /confirm {"download": false}`
 * (#270) now means only *the user accepted these matches*.
 *
 * ## Metadata first, always
 *
 * Every accepted track gets its local row and its place in the playlist
 * **before** any audio is attempted, from the match the server already matched.
 * I asked for exactly this: if a track cannot be fetched it is not kept on
 * the server for later — *"if the user lost it they just add again"* — but they
 * must be able to see **what the import contained** in order to go and find it.
 *
 * `songs.file_uri` is already nullable and already means *known about, not
 * downloaded* (#159), so this needs no new schema. It also makes resuming free:
 * the tracks still to fetch are the playlist's rows with no file.
 *
 * ## Resumable, not immortal
 *
 * Android freezes a backgrounded app's process, and `expo-audio`'s foreground
 * service covers audio rather than downloading. So this survives leaving the
 * screen — it is module state, not component state — and if the OS stops it, the
 * next run continues from the rows without files.
 *
 * **Since #371 it also asks not to be stopped**: `modules/mio-foreground-task`
 * holds a `dataSync` foreground service for the length of the run, which exempts
 * the process from the freezer and leaves this loop in JavaScript, unchanged
 * (ADR-019). The resumability above stays exactly as it is — a foreground
 * service makes a run much harder to kill, not immortal.
 *
 * ## What #369 changed, and why
 *
 * Three faults, all read out of this file rather than guessed:
 *
 * 1. **There was no retry at all.** One `catch` removed the row and moved on,
 *    so a single dropped connection cost the track permanently.
 * 2. **Five consecutive failures abandoned the whole playlist.** That is the
 *    freeze I watched for three minutes, and the limit was a number
 *    somebody picked. A failure limit should skip a *track*, not the import.
 * 3. **Downloads were serial**, which for 136 tracks is most of "very slowly"
 *    on its own.
 *
 * What looked like an automatic re-download was none of these: it was this loop
 * *resuming* after Android suspended it, skipping everything already on disk.
 */

/** Pause between the *starts* of two downloads, for the same reason the server
 *  paced its own: a burst of forty is what provokes the throttling that then
 *  has to be recovered from.
 *
 *  Now enforced on the whole run rather than per track (see `pacer`), so
 *  raising `CONCURRENCY` overlaps downloads without asking YouTube for them any
 *  faster than it always did. */
const PACE_MS = 1500

/**
 * How many downloads are in flight at once.
 *
 * Two, and the number is a judgement about *where* the rate limit lives. The 11
 * tracks lost to 403s in Phase 3 were refused because the request came from the
 * droplet (#177); a phone is on a residential connection, and since #246 that
 * is the only address involved. The politeness that mattered — how often a new
 * download is *started* — is unchanged, because the pacer above is shared.
 *
 * Above two the progress line stops being able to name the track in hand
 * honestly, which is the kind of small lie this iteration exists to remove.
 */
const CONCURRENCY = 2

/**
 * How many times one track is attempted before it is recorded as failed.
 *
 * Three, and note what a single attempt already covers: `extractAudio` walks
 * every YouTube client, and a client whose stream URL is then refused is
 * excluded from the next attempt, so the four-client chain is exhausted inside
 * this budget. What the extra attempts buy is *time* — a second try two seconds
 * later and a third four seconds after that, which is what a dropped connection
 * needs and what a video that is genuinely gone cannot be helped by.
 */
const ATTEMPTS_PER_TRACK = 3

/** Backoff before a given attempt (1-based); doubling, from two seconds. */
function backoffMs(attempt: number): number {
  return 2000 * 2 ** (attempt - 2)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Seconds since `from`, to one decimal.
 *
 * Every log line in this file recorded *what* happened and none recorded **how
 * long it took**, which is the difference between the two explanations for an
 * import that stops moving. An instant 403 and a timed-out download both
 * printed `downloadRefused`, so a run burning minutes on a single track was
 * indistinguishable in the log from one doing nothing at all.
 *
 * The numbers here shrank with #454 — a stalled socket now costs one chunk's
 * budget rather than the whole file's — but the ambiguity it removes did not,
 * because a slow track still costs several chunks and prints nothing until it
 * ends.
 */
const secondsSince = (from: number): string => ((Date.now() - from) / 1000).toFixed(1)

/**
 * How often a live run says it is still alive.
 *
 * The heartbeat answers the question no other line here can: whether a gap in
 * the log means *the loop is working slowly* or *the loop is not being run*.
 * Those need opposite fixes — a timeout to tighten versus a thread that is not
 * scheduling us — and every previous device report has had to guess between
 * them from the shape of a silence.
 *
 * Fifteen seconds, which is short enough that a five-minute download shows
 * twenty beats across it, and long enough that a half-hour import adds about a
 * hundred and twenty entries to a bounded log rather than filling it.
 */
const HEARTBEAT_MS = 15_000

export interface PlaylistImportProgress {
  /**
   * Tracks **finished** — saved or failed — and never the index of the one in
   * hand (#370).
   *
   * It published `index` before, which is why a resumed run read as a restart:
   * the loop honestly walks from position 0 again, skipping everything already
   * on disk, and the bar honestly showed 0. Nothing was ever re-downloaded.
   *
   * **Both of these are about this run's work, not the playlist (#398).** A
   * track already on the device is neither counted nor totalled, so retrying one
   * failed track out of forty says "0 of 1" and then "1 of 1" — rather than
   * opening at "0 of 40" and racing to 39, which is what a re-download of the
   * whole list would also look like.
   */
  done: number
  total: number
  title: string
  /**
   * Where the track in hand has got to.
   *
   * Without this the bar sat on "0 of 13" for the whole of the first track —
   * an extraction, a whole-file download and a 1500 ms pace — which is
   * indistinguishable from a hang, and was reported as one. The shape is
   * `DeviceImportProgress`'s, because it is the same three steps, plus
   * `retrying` for the wait #369 added.
   */
  phase: 'extracting' | 'downloading' | 'saving' | 'retrying'
  /** Failures so far, so the screen can say so while it is still running
   *  rather than only in the summary. */
  failed: number
  /** Tracks on the device because of this run. `done - saved` is not `failed`
   *  for long enough to matter, but the screen shows both. */
  saved: number
  /** Which attempt the track in hand is on. 1 unless it is being retried, and
   *  that is the whole point of showing it: a slow import and a stuck one look
   *  identical without it. */
  attempt: number
  /**
   * Accepted tracks this run had nothing to do for, because the device already
   * held them.
   *
   * Published so the screen can *say* it. #398 took these out of `done` and
   * `total`, which is the honest arithmetic — they are not this run's work — and
   * it left "Downloading 47" beside a playlist of 53 with nothing to explain the
   * gap. I worked it out and said the inconsistency was the problem, which
   * is fair: a number nobody can reconcile is a number nobody trusts.
   */
  alreadyHere: number
}

export interface PlaylistImportResult {
  saved: number
  failed: number
  /**
   * Accepted tracks that were the **same video** as another in the same import.
   *
   * They are on the device — as one song, which is what one video is — so they
   * count in `saved` and not in the playlist's length. Reported because the
   * difference between the two numbers is otherwise a track that looks lost.
   */
  duplicates: number
  /**
   * Kept for the records already on disk, and never set by this loop any more
   * (#369).
   *
   * It meant "stopped early on a run of failures". A run does not stop early
   * now: every track gets its own attempts and the loop always walks the whole
   * list, because five failures in a row is a reason to give up on five tracks
   * and not on the other hundred and thirty-one.
   */
  gaveUp: boolean
  local_playlist_id: string
}

/**
 * Guard against two runs of the same import.
 *
 * Module-level rather than a ref, so returning to the screen joins the run in
 * progress instead of starting a second one against the same tracks — and so
 * the run outlives the screen at all.
 */
const inProgress = new Set<string>()

/**
 * Every accepted match, in order.
 *
 * Read from the device since #611 — no paging, because there is no request to
 * page. `auto_matched` counts as accepted: a review the user did not touch is
 * still a review they approved by confirming.
 */
async function acceptedMatches(importId: string): Promise<LocalTrackMatch[]> {
  const matches = await listMatches(importId)
  return matches
    .filter((match) => match.chosen_url && match.status !== 'rejected')
    .sort((a, b) => a.position - b.position)
}

/**
 * Say where the run has got to, to everyone rather than to one screen.
 *
 * The callback belongs to whichever mount started the run; the **store** is
 * readable by any mount, including one that arrived half way through and was
 * turned away by the in-progress guard. That screen used to show a frozen
 * "0 of 13".
 */
function publish(importId: string, progress: PlaylistImportProgress): void {
  useImportProgress.getState().report(importId, progress)
}

export async function importPlaylistOnDevice(
  importId: string,
  playlistName: string,
  /**
   * Called with each song id whose row has **changed**, so the caller can
   * invalidate the library and playlist queries while the run is still going.
   *
   * Named `onSaved` until #411's follow-up, and the name was the bug: it fired
   * only where a track succeeded, so the rows this loop *deletes* — the ones
   * created for a track whose audio never arrived — were removed from SQLite and
   * left sitting in a React Query cache that holds `staleTime: Infinity`. A
   * failed track therefore stayed visible in the library until something else
   * happened to invalidate it, which is exactly what I reported. A row
   * appearing and a row disappearing are the same event to a cache.
   */
  onLibraryChanged?: (localId: string) => void,
): Promise<PlaylistImportResult | null> {
  if (inProgress.has(importId)) return null
  // Claimed **before the first await**, and that ordering is the guard: two
  // screens mounting at once, or one remounting mid-run, must not both start a
  // pass over the same tracks. Anything awaited above this line reopens that
  // window.
  inProgress.add(importId)

  /** The delayed foreground-service read, so it can be cancelled if the run
   *  ends first. Declared out here because the `finally` has to reach it. */
  let serviceProbe: ReturnType<typeof setTimeout> | null = null

  try {
    /*
     * Already fetched, so do not fetch it again (#308, #311).
     *
     * The guard above only survives while the JS context does. This one is on
     * disk, which is what the replay needed: the screen's other gate is the
     * server's `status === "done"`, and that is true forever from the moment
     * the matches are confirmed — so every mount re-ran the whole loop.
     *
     * A record with failures in it is still a record: re-running unasked would
     * spend three attempts and six seconds of backoff on every one of them
     * every time the screen is opened. The way back is the retry button (#370),
     * which forgets this record on purpose.
     */
    const already = await finishedImport(importId)
    if (already) {
      const total = already.saved + already.failed
      publish(importId, {
        done: total,
        total,
        title: '',
        phase: 'saving',
        failed: already.failed,
        saved: already.saved,
        attempt: 1,
        alreadyHere: 0,
      })
      return {
        saved: already.saved,
        failed: already.failed,
        // Absent from records written before this existed, and zero is the
        // right answer for them: nothing was reported, so nothing is claimed.
        duplicates: already.duplicates ?? 0,
        gaveUp: already.gaveUp,
        local_playlist_id: already.local_playlist_id,
      }
    }

    // A fresh run replaces the previous per-track view: a retry that fetches
    // the four tracks that failed last time is the truth about this import now,
    // and leaving the old states behind would show both answers at once.
    useTrackStates.getState().reset(importId)

    const matches = await acceptedMatches(importId)
    const localPlaylistId = await playlistForImport(importId, playlistName)

    /*
     * Ask Android to stop freezing us (#371, ADR-019).
     *
     * This loop is JavaScript, and a minimised app with no foreground service is
     * a frozen process — which is the whole of bug 5, and of the "restart" and
     * the "automatic retry" that were really this run being stopped and resumed.
     *
     * Claimed after the matches, deliberately: a run that cannot reach the
     * server ends in a few seconds and has nothing to protect, and putting a
     * notification on screen for it would be the shortest-lived lie in the app.
     *
     * The reason is logged rather than acted on. Nothing here changes if it
     * failed — the import runs either way, exactly as it did before this landed,
     * and #369 made an interrupted run resume cheaply. What the reason buys is
     * that the *next* device report says which of the four failures happened
     * instead of "background imports still do not work".
     */
    const held = startForegroundTask(
      i18n.t('importNotification.title'),
      i18n.t('importNotification.body', { name: playlistName }),
    )
    /*
     * ⚠️ **`running=` here is not evidence, and the 2026-08-10 pass proved it by
     * accident.**
     *
     * That report read `ok running=false`, which looks like "the service never
     * started" — a completely different bug from the process being frozen, and
     * the two need opposite work. It is neither, because the measurement is a
     * race: `startForegroundTask` calls `startForegroundService`, which is
     * **asynchronous**. `onStartCommand` runs later on the main looper and
     * `MioForegroundTaskService.isRunning` is set only *after* `startForeground`
     * returns. Reading it on the next line samples it before it can possibly be
     * true, so `false` is what a healthy phone prints too.
     *
     * Left in place and left wrong-by-construction rather than fixed, because
     * I has de-scoped background imports (2026-08-10): the app now says to
     * keep the import screen open, and that is the shipped behaviour. Whoever
     * picks #371 back up should move this read to a delayed sample or make the
     * service report through the module — and should **not** take
     * `running=false` from an existing report as a finding.
     */
    // Both halves, because they are different claims (#371, second measurement).
    // `held` is what the system said to the *request*; `isForegroundTaskRunning`
    // is whether a service actually reached `startForeground`. The first device
    // pass had the first saying `ok` while the import paused anyway, which left
    // nothing to distinguish "never ran" from "ran and was frozen regardless".
    logInfo('import.foregroundTask', held)
    /*
     * **Read late, because reading it here answers `false` on a healthy phone.**
     *
     * `startForegroundTask` calls `startForegroundService`, which is
     * asynchronous: `onStartCommand` runs later on the main looper and
     * `isRunning` is set only after `startForeground` returns. The old line
     * sampled it on the *next statement*, so it could never print anything but
     * `false` — and it was read as a finding for a day (#371, #432).
     *
     * Two seconds is far longer than the main looper needs and far shorter than
     * the run, so the answer arrives while the import is still going.
     *
     * Cancelled in the `finally`, which is not optional: an uncancelled timer
     * that logs is a leak, and #396's probe shipped exactly that shape — it
     * scheduled one in every test and failed CI with all 1092 tests passing.
     */
    serviceProbe = setTimeout(() => {
      serviceProbe = null
      logInfo('import.foregroundTask.settled', `running=${isForegroundTaskRunning()}`)
    }, 2000)

    /*
     * What this run has to do, as opposed to what the playlist contains (#398).
     *
     * on tapping "try the 1 track that failed": *"somehow when i pressed
     * it, the counter started from 0 again, seems like re-downloading the whole
     * list"*. Nothing was re-downloaded — the loop walks every accepted match on
     * every run and skips what is already here — but the bar counted the whole
     * playlist, so a one-track retry opened at "0 of 40" and raced up to 39.
     * That is indistinguishable from starting again, and on mobile data the
     * difference between the two is an hour of traffic.
     *
     * #389 answered the same complaint for a *resumed* run by counting tracks
     * finished rather than list position. It is the denominator's turn: the
     * tracks already on this device are not work, so they are neither the
     * numerator nor the denominator. A retry of one failed track now says
     * "0 of 1".
     *
     * `sourcesFullyOnDevice` and not `sourcesWithAudio`, because a track with
     * audio and no artwork still costs an extraction below.
     */
    const carriedOver = await sourcesFullyOnDevice(
      matches.map((match) => match.chosen_url as string),
    )
    const outstanding = matches.filter(
      (match) => !carriedOver.has(match.chosen_url as string),
    ).length
    /** Finished tracks that this run did not have to do anything for. Kept out
     *  of the bar, and kept in `saved` — the summary is about the playlist. */
    let carried = 0

    /**
     * The last thing that went wrong for each track, by URL (#452).
     *
     * `fetchAudio` returns a bare `false` — it has always been enough for the
     * counters, and it throws the *reason* away. The reason is precisely what
     * I asked to see on a failed row, and the three attempts can fail three
     * different ways, so it is the last one that gets shown.
     */
    const lastFailure = new Map<string, FailureKind>()
    /** And in the thrower's own words (#582) — the status and byte offset that
     *  `FailureKind` flattens away. Same key, written at the same two sites. */
    const lastDetail = new Map<string, string>()

    let saved = 0
    let failed = 0
    /** Accepted tracks that turned out to be the same video as another. */
    let duplicates = 0

    /**
     * The last thing `report` published, for the heartbeat to quote.
     *
     * The title is deliberately not kept: the heartbeat is written to a log
     * that gets uploaded, and `scrub()` exists because #322 shipped song titles
     * to the server in breach of an invariant stated in two files (#354).
     */
    let lastPhase: PlaylistImportProgress['phase'] = 'extracting'
    let lastAttempt = 1
    let lastMovedAt = Date.now()

    /**
     * Where one *track* has got to (#452).
     *
     * Separate from `report` below, which is about the run: that one names the
     * single track in hand, and with `CONCURRENCY = 2` most of a 135-track
     * import is neither in hand nor finished. I asked to see all of them.
     *
     * Keyed by URL rather than position, because that is what the review rows
     * have and what survives a track being re-matched.
     */
    const trackState = (
      url: string,
      phase: TrackPhase,
      attempt = 1,
      failure: FailureKind | null = null,
      detail: string | null = null,
    ): void => useTrackStates.getState().set(importId, url, { phase, attempt, failure, detail })

    const report = (
      title: string,
      phase: PlaylistImportProgress['phase'],
      attempt: number,
    ): void => {
      if (phase !== lastPhase || attempt !== lastAttempt) lastMovedAt = Date.now()
      lastPhase = phase
      lastAttempt = attempt
      publish(importId, {
        done: saved + failed - carried,
        total: outstanding,
        title,
        phase,
        failed,
        saved,
        attempt,
        alreadyHere: matches.length - outstanding,
      })
    }

    /*
     * One start every `PACE_MS`, across the whole run.
     *
     * Shared rather than a `sleep` at the bottom of the loop, because with two
     * workers a per-worker pause would double the rate at which downloads are
     * started — which is the one thing the pause exists to hold constant.
     */
    let nextStart = 0
    const pace = async (): Promise<void> => {
      const now = Date.now()
      const wait = Math.max(0, nextStart - now)
      nextStart = Math.max(now, nextStart) + PACE_MS
      if (wait > 0) await sleep(wait)
    }

    /*
     * The playlist is written in import order, whatever order the audio lands
     * in.
     *
     * Workers take indices in ascending order and enqueue onto this chain
     * synchronously, before their first await, so track 4's row cannot be
     * inserted ahead of track 3's just because track 3's download is slower.
     * The work on the chain is two SQLite writes and no network, so a worker
     * waiting on it waits for microseconds.
     */
    let ordered: Promise<unknown> = Promise.resolve()
    const inOrder = <T>(work: () => Promise<T>): Promise<T> => {
      const next = ordered.then(work)
      ordered = next.catch(() => undefined)
      return next
    }

    /** Fetch one track's audio. Returns true if the device now holds it. */
    const fetchAudio = async (match: LocalTrackMatch, localId: string): Promise<boolean> => {
      const url = match.chosen_url as string
      /**
       * YouTube or Bilibili, decided from the URL (#555).
       *
       * A candidate's URL is what picks the extractor — the same single
       * decision `importToDevice` makes (#492). This loop used to call
       * `extractAudio` directly, so every Bilibili match #551 found failed with
       * `NotAYouTubeLink` before a request was made.
       */
      const extractor = extractorFor(url)
      /** Clients whose stream URL was fetched and refused. A URL that 403s is
       *  as useless as no URL, so the chain has to cover the download too.
       *  Only YouTube has a chain; Bilibili ignores it, by construction. */
      const refused: string[] = []
      /**
       * The rate a previous attempt actually achieved, when one ran out of time
       * with bytes still arriving (#439).
       *
       * Carried across attempts because it is evidence rather than a setting: a
       * refusal at byte 0 never produces one, so only a download that has
       * demonstrably moved megabytes widens the next attempt's budget.
       */
      let observedRate: number | null = null

      for (let attempt = 1; attempt <= ATTEMPTS_PER_TRACK; attempt++) {
        if (attempt > 1) {
          // Named before it is waited out, so "retrying in a moment" is a thing
          // the screen can say rather than a gap in the progress bar (#370).
          report(match.title, 'retrying', attempt)
          await sleep(backoffMs(attempt))
        }

        await pace()
        report(match.title, 'extracting', attempt)
        trackState(url, 'extracting', attempt)

        const extractStartedAt = Date.now()
        let audio: Awaited<ReturnType<typeof extractor.extract>>
        try {
          audio = await extractor.extract(refused)
        } catch (error) {
          /*
           * YouTube answered, and the answer will not change (#400).
           *
           * `Kvv5CpePWk0` failed three times across the whole client chain with
           * "no audio format" everywhere, which read as the app being blocked.
           * It is not: that video's `availableCountries` are AT, CH and DE, and
           * every client was telling the truth. Two more attempts and six
           * seconds of backoff cannot reach a video that is not offered here, so
           * this stops rather than performing patience.
           */
          lastFailure.set(url, classifyFailure(error))
          lastDetail.set(url, describeError(error))
          if (error instanceof VideoUnavailable) {
            logWarn(
              'playlistImport.unavailable',
              `${error.status} on attempt ${attempt} after ${secondsSince(extractStartedAt)}s`,
            )
            return false
          }
          // Every client refused, or the network is down. Nothing to retire —
          // the next attempt starts the chain again, later.
          logWarn(
            'playlistImport.extractFailed',
            `attempt ${attempt} after ${secondsSince(extractStartedAt)}s: ${describeError(error)}`,
          )
          continue
        }

        const downloadStartedAt = Date.now()
        try {
          report(match.title, 'downloading', attempt)
          trackState(url, 'downloading', attempt)
          await downloadAudioFromUrl(localId, audio.audio_url, audio.http_headers, {
            contentLength: audio.content_length,
            observedBytesPerSecond: observedRate,
            // A URL that stops serving mid-file is replaced rather than lost
            // (#454). Same client: this is about a spent URL, not a refused
            // video, and the size check inside rejects a different format.
            refresh: async () => {
              const next = await extractor.extract(refused)
              return {
                url: next.audio_url,
                headers: next.http_headers,
                contentLength: next.content_length,
              }
            },
          })
          /*
           * The cover and the loudness, which this path used to throw away
           * (#308).
           *
           * Written after the audio and never before it (#218): the song is
           * complete once the file lands, and `saveCover` swallows its own
           * failures, so a missing thumbnail cannot cost a track that
           * downloaded.
           */
          report(match.title, 'saving', attempt)
          trackState(url, 'saving', attempt)
          await setSongLoudness(localId, audio.loudness_lufs)
          await saveCover(localId, audio.cover_url)
          /*
           * A timestamped record that this track landed (#371).
           *
           * This loop logged only its *failures*, which made the diagnostics
           * unable to answer the one question they were opened for: when I
           * minimised an import for two minutes and the count had not moved on
           * my return, nothing on the phone said whether the downloads had
           * continued and the UI was merely stale, or whether the loop had
           * stopped despite `import.foregroundTask` reporting `ok`.
           *
           * The timestamps are the whole point — spread across the gap means it
           * kept working, clustered at the moment of return means it did not.
           *
           * **The position is in the detail so the entries do not collapse.**
           * `append` drops an identical entry within `REPEAT_WINDOW_MS`, and
           * "via ANDROID_VR" is identical for every track in a run — so a
           * per-track record with a constant detail is *one* record, and the
           * measurement it exists for is impossible. A test caught this; the
           * device would have caught it a build later.
           *
           * The position, never the title: `scrub()` exists because #322 shipped
           * song titles to the server in breach of an invariant stated in two
           * files, and a diagnostic is not a reason to do it again.
           */
          /*
           * `AppState` with it, since 2026-08-09.
           *
           * #406 put this line in so the #371 measurement could be taken, and
           * the measurement came back "the import paused while minimised" — but
           * a gap in a log's timestamps cannot say *why*. Whether tracks land
           * while the app is in the background is the question, and the answer
           * is one word: `background` entries during the gap mean the loop ran
           * and something else stopped it; none at all means the process really
           * was frozen despite the service.
           *
           * It also keeps the detail varying, which `append`'s 60-second
           * de-duplication requires — the reason #406 needed the position.
           */
          logInfo(
            'playlistImport.trackDone',
            `#${match.position} via ${audio.client ?? 'unknown'} while ${AppState.currentState}` +
              ` in ${secondsSince(downloadStartedAt)}s`,
          )
          return true
        } catch (error) {
          /*
           * A truncated download is the one failure that says something useful
           * about the connection (#439). Four long tracks failed on 2026-08-09
           * at ~35 kB/s, each cut off at about three quarters by the
           * five-minute ceiling; every one would have finished in about seven
           * minutes. The next attempt is sized from the rate this one measured.
           *
           * Deliberately **not** applied to a 403 at byte 0, which measures
           * nothing and would otherwise buy a dead URL a quarter of an hour.
           */
          lastFailure.set(url, classifyFailure(error))
          lastDetail.set(url, describeError(error))
          if (error instanceof DownloadWasShort) {
            observedRate = error.observedBytesPerSecond ?? observedRate
            /*
             * **And this client is kept**, which is the half that actually
             * failed the four tracks.
             *
             * Retiring is for a client that *refuses* — a 403 at byte 0 means
             * its URL is no use and the next attempt must ask someone else. A
             * client that delivered ten megabytes and ran out of time is the
             * opposite: it is the only one serving us at all. The 2026-08-09
             * log is unambiguous about the cost:
             *
             *     attempt 1 via ANDROID_VR after 300.1s: short
             *     attempt 2 via IOS        after   0.2s: 403 at byte 0
             *     attempt 3 via TV_SIMPLY  after   0.1s: 403 at byte 0
             *
             * ANDROID_VR was excluded for being slow, and the retries went to
             * clients that had already refused. A budget sized from a measured
             * rate is worthless if the client that measured it is never asked
             * again.
             */
          } else if (audio.client) {
            // This client's URL was refused; the next attempt asks a different
            // one. Which client is the question every download bug has turned on.
            refused.push(audio.client)
          }
          /*
           * **The elapsed time is the finding, not the decoration.**
           *
           * A 403 at byte 0 comes back in under a second; a socket that goes
           * quiet mid-body is aborted at `downloadTimeoutMs`, which for a 13 MB
           * track is the five-minute ceiling. Both printed this same line, so a
           * track burning fifteen minutes across three attempts and one failing
           * instantly were the same entry in the log — and the difference is
           * the whole of "why did the import stop for a dozen minutes".
           */
          logWarn(
            'playlistImport.downloadRefused',
            `attempt ${attempt} via ${audio.client ?? 'unknown'}` +
              ` after ${secondsSince(downloadStartedAt)}s: ${describeError(error)}`,
          )
        }
      }

      return false
    }

    const handle = async (match: LocalTrackMatch): Promise<void> => {
      // The row and its place in the playlist come first, from what the server
      // already knows — and in import order, which is what `inOrder` is for.
      const localId = await inOrder(async () => {
        const id = await saveDeviceSongMetadata({
          title: match.title,
          artist: match.artist,
          duration: match.duration_s,
          source_url: match.chosen_url as string,
          /*
           * The **URL's** platform, not always YouTube (#636).
           *
           * Hardcoded here since this loop was written, when YouTube was the
           * only thing a match could point at. #551 made a candidate's URL a
           * Bilibili one and #556 taught the download to route on it — and this
           * line, three above the routing, kept writing `Youtube` for every
           * Bilibili track the review imports saved.
           *
           * `extractorFor` is the same single decision `fetchAudio` makes below,
           * read rather than repeated: exactly #555's lesson, one level in.
           */
          source_platform: extractorFor(match.chosen_url as string).platform,
        })
        /*
         * Nothing added means this track is **already in the playlist**, and
         * the only way that happens on a first pass is two accepted matches
         * resolving to the same video (#398 follow-up).
         *
         * It is not a fault and it is not a loss: `songs.source_url` is UNIQUE
         * since v6, so one video is one row, and `addSongsToPlaylist` skips a
         * song the playlist already holds. The device is right. What was wrong
         * is that nobody said so — a 56-track import that produces a 55-track
         * playlist reads as one lost track, and I counted it as one.
         */
        const added = await addSongsToPlaylist(localPlaylistId, [id])
        if (added === 0) duplicates += 1
        return id
      })

      const existing = await getLocalSong(localId)
      if (existing?.file_uri) {
        /*
         * Here from an earlier run — but possibly from *before* covers were
         * kept (#308), in which case it has audio and no artwork and nothing
         * would ever give it any. Re-importing does not help: this branch is
         * exactly the one a re-import takes.
         *
         * One extraction for a track that is otherwise free, and only for the
         * ones actually missing a cover, so a healthy library costs nothing.
         */
        if (!existing.cover_uri) {
          try {
            report(match.title, 'saving', 1)
            const audio = await extractorFor(match.chosen_url as string).extract([])
            await saveCover(localId, audio.cover_url)
            await setSongLoudness(localId, audio.loudness_lufs)
          } catch {
            // A cover is not worth failing a track that is already here.
          }
        }
        // Already here from an earlier run, or from another playlist. This is
        // what makes the whole thing resumable at no cost.
        saved += 1
        // ...and it is not this run's work, so it stays out of the bar (#398).
        // Only if it needed nothing: the cover back-fill just above is a network
        // round trip, and a track that paid for one has been worked on.
        if (carriedOver.has(match.chosen_url as string)) carried += 1
        trackState(match.chosen_url as string, 'carried')
        // Still announced: a resumed run that reported nothing until it reached
        // new work looked exactly like a stuck one.
        onLibraryChanged?.(localId)
        report(match.title, 'saving', 1)
        return
      }

      if (await fetchAudio(match, localId)) {
        trackState(match.chosen_url as string, 'done')
        saved += 1
        // Per track, so the library and the playlist fill in as it runs. Nothing
        // invalidated anything before, and the library caches with
        // `staleTime: Infinity` — which is why thirteen imported songs were
        // nowhere to be seen until the app was restarted.
        onLibraryChanged?.(localId)
        report(match.title, 'saving', 1)
        return
      }

      /*
       * The row goes with it (#309).
       *
       * "Metadata first, always" was this file's own rule, and its reason was
       * that a track which cannot be fetched is still one the user should be
       * able to see they are missing. I re-took that decision: the library
       * means *music I have*, and a row with no file is a promise it cannot
       * keep.
       *
       * Where it is still visible is this import's own record — the "Failed"
       * list, which since #308 means exactly "the device does not have this
       * audio", and is built from the server's matches rather than from
       * library rows. So nothing is lost by removing the row: the track is
       * still named, still linked, and still retryable, on the page it came
       * from — and since #370 there is a button there to do it.
       */
      trackState(
        match.chosen_url as string,
        'failed',
        ATTEMPTS_PER_TRACK,
        // The last thing that went wrong, named. `unknown` rather than a guess
        // when nothing threw a shape we recognise (#441).
        lastFailure.get(match.chosen_url as string) ?? 'unknown',
        // …and said (#582). Eighteen tracks that all read "the source refused
        // the download" is a report nobody can act on.
        lastDetail.get(match.chosen_url as string) ?? null,
      )
      await removeSongIfEmpty(localId)
      // **And the caller is told**, which this path did not do. Removing the row
      // changes the library exactly as much as adding one does, and the local
      // library query caches with `staleTime: Infinity` — so without this the
      // deleted row stayed on screen, which is the failed track I kept
      // finding in my library after an import.
      onLibraryChanged?.(localId)
      failed += 1
      report(match.title, 'saving', ATTEMPTS_PER_TRACK)
    }

    /*
     * The whole list, always.
     *
     * There was a `CONSECUTIVE_FAILURE_LIMIT = 5` here that abandoned the
     * import. It is gone: a track now has its own attempts, so a failure that
     * survives them is about that track, and stopping the other hundred and
     * thirty-one to save battery is a trade nobody asked for. The condition it
     * was really guarding against — no network at all — costs three fast
     * refusals and six seconds per track now, and the run still ends with
     * everything it did manage recorded.
     */
    /*
     * **One track's unexpected throw must not take a worker with it.**
     *
     * `handle` was awaited bare here, and only its *download* is guarded —
     * `fetchAudio` catches extraction and download errors and returns false.
     * Everything else in `handle` is unprotected: the two SQLite writes inside
     * `inOrder`, `getLocalSong`, `removeSongIfEmpty`, and `onLibraryChanged`,
     * which calls straight into React Query. Any of those throwing ended the
     * worker's loop by propagating.
     *
     * The shape of that failure is exactly what I reported on 2026-08-09,
     * and it is worth spelling out because it does not look like a crash:
     *
     * - `Promise.all` rejects on the first worker to throw, but it does **not**
     *   cancel the other one. The survivor keeps downloading, unsupervised.
     * - The `finally` below therefore runs while a worker is still going,
     *   releasing the `inProgress` guard and stopping the foreground service
     *   underneath a live run — so re-entering the screen starts a *second*
     *   pass over the same tracks.
     * - `rememberFinishedImport` is never reached, so no durable record is
     *   written and the screen never reaches a terminal state: no summary, and
     *   no retry button.
     * - The screen's `catch` sets `failure` and `setRunning(false)`, which is
     *   why the bar froze at 45 while the orphan quietly finished the list —
     *   *"after a dozen minutes, playlist somehow started re-downloading, all
     *   the way to the end"*. Nothing restarted. It had never stopped.
     *
     * So a throw here fails **this track**, by name, and the loop goes on. The
     * track is counted as failed, which is what it is: no audio landed.
     */
    /*
     * **Is this run alive?** — the question no other line in this file answers.
     *
     * Every existing entry is written when something *finishes*. That makes a
     * silence ambiguous in exactly the way that has cost this iteration the most
     * time: an import that has stopped moving prints nothing, and an import
     * grinding through three five-minute download timeouts also prints nothing.
     * They need opposite fixes, and every device report so far has had to guess
     * between them from the shape of a gap.
     *
     * A beat every fifteen seconds removes the guess. `AppState` rides along,
     * because a run that keeps beating while `background` proves the process is
     * not frozen — which is the claim ADR-019 makes and which #371's own
     * diagnostic was never able to test.
     *
     * `setInterval` and not a loop of `sleep`: this must not hold the worker
     * pool open, and it is cleared in a `finally` so no beat outlives the run.
     */
    /*
     * `done=` is four characters and it cost real analysis time (#457).
     *
     * The line read `45/136`, which is 45 tracks *finished* of 136. I read
     * it as **track #45** — reasonably, because `playlistImport.trackDone`
     * prints `#45` for a position and the two happened to coincide — and then
     * spent a paragraph on the mystery of *"weird thing about #46, it don't
     * have its own #46 log, it displayed as 45 too"*. There was never a #46
     * line. He was reading the counter.
     */
    const heartbeat = setInterval(() => {
      logInfo(
        'playlistImport.alive',
        `done=${saved + failed - carried}/${outstanding} phase=${lastPhase}` +
          ` attempt=${lastAttempt} stuck=${secondsSince(lastMovedAt)}s failed=${failed}` +
          ` state=${AppState.currentState}`,
      )
    }, HEARTBEAT_MS)

    /*
     * Every accepted track is `waiting` before the pool starts, so the list is
     * complete from the first frame rather than filling in as tracks are
     * reached. A list that grows is indistinguishable from a list that is
     * stuck, which is the fault this whole feature exists to remove.
     */
    for (const match of matches) {
      const url = match.chosen_url as string
      trackState(url, carriedOver.has(url) ? 'carried' : 'waiting')
    }

    let cursor = 0
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(CONCURRENCY, matches.length) }, async () => {
        for (;;) {
          const index = cursor++
          if (index >= matches.length) return
          try {
            await handle(matches[index])
          } catch (error) {
            /*
             * Named, and at error level, because this is the branch nobody knew
             * existed. `downloadRefused` is an expected failure with a known
             * shape; this is the opposite — something threw where the code
             * assumed it could not — and the log has to be able to say which.
             *
             * The position, never the title (#322, #354).
             */
            logError(
              'playlistImport.trackThrew',
              `#${matches[index].position}: ${describeError(error)}`,
            )
            const url = matches[index].chosen_url as string
            if (url) {
              trackState(
                url,
                'failed',
                ATTEMPTS_PER_TRACK,
                classifyFailure(error),
                describeError(error),
              )
            }
            failed += 1
            report('', 'saving', ATTEMPTS_PER_TRACK)
          }
        }
      }),
    )
    // Safe here rather than in a `finally`: `allSettled` never rejects, so this
    // line is reached however the workers ended.
    clearInterval(heartbeat)
    /*
     * `allSettled`, so the guard and the foreground service are released only
     * once **every** worker has stopped — never while one is still running.
     * A rejection here now means the worker loop itself failed, not a track,
     * and there is nothing left to attribute it to but the run.
     */
    for (const outcome of results) {
      if (outcome.status === 'rejected') {
        logError('playlistImport.workerThrew', describeError(outcome.reason))
      }
    }

    publish(importId, {
      done: outstanding,
      total: outstanding,
      title: '',
      phase: 'saving',
      failed,
      saved,
      attempt: 1,
      alreadyHere: matches.length - outstanding,
    })
    const result = { saved, failed, duplicates, gaveUp: false, local_playlist_id: localPlaylistId }
    /*
     * The import row reaches a terminal state (#655).
     *
     * The **server** used to write this, and #611 removed the server without
     * replacing it — which is half of why a confirmed import went nowhere: the
     * status stayed `importing` forever, so the header read "Downloading" after
     * the run had finished and `isImportTerminal` reported a finished import as
     * still going, on the list screen too.
     *
     * Written before the durable record rather than after: the record is what
     * makes a reopened screen skip the loop, so anything that must be true of a
     * finished import belongs on the near side of it.
     */
    await updateImport(importId, {
      status: 'done',
      imported_count: saved,
      failed_count: failed,
    })
    // Durably, so reopening the record shows what happened instead of running
    // the whole loop again (#308, #311).
    await rememberFinishedImport(
      importId,
      result,
      failuresIn(useTrackStates.getState().forImport(importId)),
    )
    return result
  } finally {
    if (serviceProbe !== null) clearTimeout(serviceProbe)
    inProgress.delete(importId)
    /*
     * Released however the run ended — finished, thrown, or returned early from
     * the remembered-record branch, which never started one.
     *
     * `stopForegroundTask` tolerates that: stopping a service that is not
     * running is a no-op, and putting the call anywhere more precise would mean
     * a path that returns without releasing it, which is a permanent
     * notification for an import that ended minutes ago.
     */
    stopForegroundTask()
  }
}

/** Test seam: the in-progress guard is module state and outlives a test. */
export function resetPlaylistImportGuard(): void {
  inProgress.clear()
}
