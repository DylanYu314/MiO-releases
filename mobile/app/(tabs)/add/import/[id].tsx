import { useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'

import {
  importKeys,
  useConfirmImport,
  useImportableCount,
  usePlaylistImport,
  useRetryFailedTracks,
} from '../../../../src/api/playlistImports'
import { useImportProgress } from '../../../../src/api/importProgress'
import { deviceImportKeys } from '../../../../src/api/deviceImportState'
import { localLibraryKeys } from '../../../../src/api/localLibrary'
import { playlistKeys } from '../../../../src/api/localPlaylists'
import { MatchReview } from '../../../../src/components/MatchReview'
import { supplyCandidates, type MatchingProgress } from '../../../../src/library/deviceMatching'
import { isSourceRefusal } from '../../../../src/library/bilibiliSearch'
import { useSearchSource } from '../../../../src/library/searchSource'
import { describeError, logWarn } from '../../../../src/diagnostics/log'
import { pausedWhileAway, type AwaySpan } from '../../../../src/library/backgroundedRun'
import { showToast } from '../../../../src/components/Toast'
import { finishedImport, forgetFinishedImport } from '../../../../src/library/finishedImports'
import {
  importPlaylistOnDevice,
  type PlaylistImportResult,
} from '../../../../src/library/playlistImport'
import { useTheme, useThemedStyles, type Theme } from '../../../../src/theme'
import { useGuardedRouter } from '../../../../src/navigation/useGuardedRouter'
import { Button } from '../../../../src/components/ui/Button'

/**
 * One import, followed live.
 *
 * The shape of this screen is the backend's state machine, and the one moment
 * that matters is **review**: nothing downloads until a human says so, and
 * `POST /confirm` is the only way past it. That is deliberate — an import can be
 * a hundred tracks, and starting it by accident is expensive in both time and
 * somebody's goodwill at YouTube.
 *
 * Progress arrives over a WebSocket, so this stays current while it is open; the
 * import keeps running when it is not.
 */
export default function ImportDetailScreen() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const router = useGuardedRouter()
  const { id } = useLocalSearchParams<{ id: string }>()

  // Ids are TEXT on the device since #610, so the route param *is* the id —
  // there is nothing to parse, and nothing that can fail to parse.
  const importId = id
  const { data, isPending, isError, error } = usePlaylistImport(importId || null)
  const confirm = useConfirmImport(importId)
  const retryFailed = useRetryFailedTracks(importId)
  const importable = useImportableCount(importId || null)
  /**
   * The device fetches the tracks (#268).
   *
   * `done` now means the server accepted the matches and enqueued nothing, so
   * it is the *start* of the device's work rather than the end of the server's.
   * `import_total` is what it accepted.
   */
  /**
   * The device finds each track on YouTube (#353).
   *
   * Driven from this screen for the same reason the handover is: the import is
   * already open here, and `matching` is the state the user is looking at. The
   * run itself is resumable — it asks the server which tracks are still pending
   * rather than remembering — so re-entering the screen after an interruption
   * picks up where it stopped.
   */
  // Named rather than hardcoded, the way the import screens do it since #557 —
  // the message must not promise YouTube to somebody who chose Bilibili.
  const sourceName = t(`searchSource.${useSearchSource((state) => state.source)}`)
  const matching = useDeviceMatching(
    importId || null,
    // No `client_matches` any more: since #611 every import on this device is
    // matched by this device, so the flag had exactly one value and said
    // nothing. `matching` is the whole condition.
    data?.status === 'matching',
  )
  const handover = usePlaylistHandover(
    importId,
    data?.name ?? '',
    /*
     * **The user has confirmed** — which is `importing`, not only `done` (#655).
     *
     * This read `done` alone, and `done` used to be written by the *server*:
     * `POST /confirm {"download": false}` accepted the matches, enqueued
     * nothing and marked the import done, so `done` meant "the device's work
     * starts now". #611 removed the server and `useConfirmImport` writes
     * `importing`. Nothing took the transition over, so this was never true and
     * the loop never ran: twelve tracks confirmed, 12/12 shown failed, no
     * summary, and **nothing in the diagnostics** — because every line that
     * would have explained it is written by the loop.
     *
     * ⚠️ The suite asserted both halves and never the join: one test proved
     * confirm writes `importing`, another proved the handover runs on `done`.
     * Both passed against an app that downloaded nothing.
     *
     * `done` stays accepted so records written before this — and any that
     * reach `done` on their own — still run, and so an import already stuck in
     * `importing` recovers simply by being opened.
     */
    data?.status === 'importing' || data?.status === 'done',
    data?.import_total ?? 0,
  )

  if (isPending) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
        <Text style={styles.hint}>{t('importDetail.loading')}</Text>
      </View>
    )
  }

  if (isError || !data) {
    return (
      <View style={styles.centered}>
        <Text style={styles.title}>
          {t('importDetail.loadError', {
            message: error?.message ?? t('importDetail.unknownError'),
          })}
        </Text>
      </View>
    )
  }

  /*
   * The counters come from **this device**, not the server (#308).
   *
   * `import_total` / `imported_count` stopped moving the moment confirm began
   * sending `download: false` (#270) — the server accepts the matches and
   * downloads nothing — so the bar read "0 of 13" for an import that was
   * working perfectly. The device is the only thing that knows now.
   */
  /*
   * ⚠️ `saved + failed`, not `saved` (#567).
   *
   * The fallback used to be `result.saved`, which reads "13 of 13" on a clean
   * run and **"0 of 0"** on one where nothing worked — a bar that is both full
   * and empty, describing four attempted tracks as no work at all. What a
   * finished run's denominator means is *what it attempted*.
   */
  const attempted = handover.result ? handover.result.saved + handover.result.failed : null
  const total = handover.progress?.total ?? attempted ?? data.import_total ?? 0
  const isDownloading = handover.running
  const done = handover.result
    ? handover.result.saved + handover.result.failed
    : (handover.progress?.done ?? 0)
  const fraction = total > 0 ? Math.min(done / total, 1) : 0
  /*
   * How many of those `done` were failures (#567).
   *
   * `done` is `saved + failed`, which is right for a *progress* bar — the work
   * is finished either way — and reads as success at the end. My 2026-08-17
   * import saved nothing, failed four, and the bar said **"4 of 4"** at 100%.
   * The summary underneath was telling the truth the whole time; the bar is what
   * gets read.
   */
  const failed = handover.result?.failed ?? handover.progress?.failed ?? 0
  const saved = handover.result?.saved ?? handover.progress?.saved ?? 0
  /** Finished, and none of it worked. A full bar is the wrong picture for that,
   *  whatever the words beside it say. */
  const allFailed = handover.result !== null && saved === 0 && failed > 0
  /** Tracks this run had nothing to do for. Published since #398 and never
   *  shown, which left "47 of 53" with nothing to reconcile it. */
  const alreadyHere = handover.progress?.alreadyHere ?? 0

  /** How far matching has got. Reads the server's counters, so it is right for
   *  a web-started import as well as a phone-started one. */
  const matchTotal = data.track_count ?? 0
  const matchFraction = matchTotal > 0 ? Math.min(data.matched_count / matchTotal, 1) : 0

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>{data.name}</Text>
      <Text style={styles.status}>{t(`importStatus.${data.status}`)}</Text>

      {data.track_count != null ? (
        <Text style={styles.meta}>{t('importDetail.trackCount', { count: data.track_count })}</Text>
      ) : null}

      {/*
       * Every phase says where it has got to (#312).
       *
       * I asked for a progress bar for **fetching**, **matching** and
       * **downloading**; the first two showed nothing at all. They are not the
       * same kind of wait, though, and pretending they are would be the lie
       * this iteration exists to remove:
       *
       * - **Fetching** has no countable unit. The server pulls the whole
       *   tracklist from Spotify in one go and `track_count` only exists once
       *   it is finished, so a bar here could only be an animation shaped like
       *   information. A spinner and a sentence is the honest version — the
       *   same judgement `DeviceImportProgress` records about phases rather
       *   than percentages.
       * - **Matching** genuinely counts: `matched_count` of `track_count`, and
       *   it works whether the server is doing the searching or this phone is
       *   (#353).
       * - **Downloading** already counted, and is unchanged.
       */}
      {data.status === 'queued' || data.status === 'fetching' ? (
        <View style={styles.phase}>
          <ActivityIndicator />
          <Text style={styles.meta}>{t('importDetail.fetchingTracks')}</Text>
        </View>
      ) : null}

      {data.status === 'matching' ? (
        <>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${matchFraction * 100}%` }]} />
          </View>
          <Text style={styles.meta}>
            {/* Named differently while the phone is doing it, because "why is
                this slow" has a different answer then (#353). */}
            {matching.progress
              ? t('importDetail.matchingOnDevice', {
                  current: matching.progress.current,
                  total: matching.progress.total,
                })
              : t('importProgress.ofTotal', {
                  value: data.matched_count,
                  total: data.track_count ?? 0,
                })}
          </Text>
          {/* The one matching failure a user can do something about, and the
              thing to do is wait (#586). Everything else here is a log line:
              the run has already landed on this screen and the review shows
              what it found. A rate limit is different — the tracks it did not
              reach are still pending, and coming back finishes them. */}
          {matching.refused ? (
            <View accessibilityRole="alert">
              <Text style={styles.refused}>
                {t('importDetail.sourceRefused', { source: sourceName })}
              </Text>
            </View>
          ) : null}
        </>
      ) : null}

      {/*
        The limitation, said out loud rather than fixed (#371, de-scoped
        2026-08-10).

        A minimised import pauses. `modules/mio-foreground-task` was built to
        stop that and the device pass could not show it working; my call
        was that background imports are not worth more effort, since a run
        resumes from where it stopped (#369) and the cost is only the user's
        attention for a minute. What is *not* acceptable is the app knowing this
        and not saying so — a bar that stops moving with no explanation is the
        exact class of thing this iteration exists to remove.
      */}
      {/*
       * **A notice, not another status line** (#450) — and one that is *found*
       * before the mistake rather than after it (#458).
       *
       * #450 gave it a surface, a rule down the accent side, `role="alert"` and
       * body text instead of the muted register it was lost in. That fixed how
       * it looks and not where it is: it stayed at the **bottom** of the screen,
       * under a track list that is 136 rows on the import I was running.
       *
       * > *"for prompt like this, must put in the position where user can
       * > instantly notice."*
       *
       * A warning reached by scrolling is read after the thing it exists to
       * prevent. It now sits immediately **above the progress bar** — the one
       * element the user is already watching — and therefore above the list
       * rather than below it.
       *
       * Still only while a run is going: a warning that is always on screen is
       * furniture within a day.
       */}
      {isDownloading ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Text style={styles.noticeText}>{t('importDetail.keepScreenOpen')}</Text>
        </View>
      ) : null}

      {isDownloading || data.status === 'done' ? (
        <>
          <View style={styles.track}>
            <View
              style={[styles.fill, allFailed && styles.fillFailed, { width: `${fraction * 100}%` }]}
            />
          </View>
          <Text style={styles.meta}>
            {/* Never a bare "4 of 4" while tracks are failing (#567). The
                count is the work attempted, which is what a progress bar
                means — so the failures have to be *in* the label, not left
                to a line further down that a filled bar has already
                contradicted. */}
            {failed > 0
              ? t('importProgress.ofTotalWithFailed', { value: done, total, failed })
              : t('importProgress.ofTotal', { value: done, total })}
          </Text>
          {/* The gap between this run's total and the playlist's length,
              explained rather than left to be noticed (#398 asked for the
              honest arithmetic; this is the sentence that makes it legible). */}
          {alreadyHere > 0 ? (
            <Text style={styles.meta}>{t('importDetail.alreadyHere', { count: alreadyHere })}</Text>
          ) : null}
        </>
      ) : null}

      {/*
        The **server's** failure count, which is no longer the truth (#268).

        Since the device fetches the audio, `failed_count` only ever describes a
        server-side download — either an older attempt on this same import, or
        one confirmed from the web. Showing it beside a device run that is
        succeeding tells the user tracks failed when they are sitting in their
        library, which is worse than saying nothing.

        So the device's own result wins the moment it exists. `retry-failed` goes
        with it: it re-runs the *server's* download, which is the thing that does
        not work — the way back for a track the device missed is to tap it in the
        library (#268), where the row is already marked.
      */}
      {data.failed_count > 0 && !handover.result ? (
        // Partial success is success, and visible: the run still ends `done`,
        // with the failures recorded per track rather than swallowed.
        <>
          <Text style={styles.failed}>
            {t('importDetail.failedHint', { count: data.failed_count })}
          </Text>
          {/* A failed track needs a way back (#223). Deliberately manual: a
              playlist import is long and paces itself, so re-running a batch
              unasked would spend minutes on a decision nobody made. */}
          <Pressable
            onPress={() => retryFailed.mutate()}
            disabled={retryFailed.isPending}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.button,
              retryFailed.isPending && styles.buttonDisabled,
              pressed && styles.pressed,
            ]}
          >
            {retryFailed.isPending ? (
              <ActivityIndicator color={theme.accentText} />
            ) : (
              <Text style={styles.buttonText}>{t('importDetail.retryFailed')}</Text>
            )}
          </Pressable>
        </>
      ) : null}

      {data.error ? (
        <View accessibilityRole="alert">
          <Text style={styles.error}>{data.error}</Text>
        </View>
      ) : null}

      {/*
        The review (#203).

        For a YouTube import this is mostly a list to glance at — every entry is
        its own candidate, so everything arrives `auto_matched` and confirming
        without reading is a reasonable thing to do. For Spotify it is the
        point of the screen: the matcher guessed, and the guesses need
        answering before anything is downloaded.
      */}
      {data.status === 'review' ? (
        <>
          <MatchReview importId={importId} interactive />
          <Pressable
            onPress={() => confirm.mutate()}
            disabled={confirm.isPending}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.button,
              confirm.isPending && styles.buttonDisabled,
              pressed && styles.pressed,
            ]}
          >
            {confirm.isPending ? (
              <ActivityIndicator color={theme.accentText} />
            ) : (
              <Text style={styles.buttonText}>
                {/* The count, not just "Confirm": "Download 0 tracks" is a very
                    different thing to be about to tap, and rejecting everything
                    is an easy state to reach without noticing.

                    Guarded on it being a real number rather than merely
                    defined. The count is two totals added together, and a
                    server that answered without them would put "Download NaN
                    tracks" on the button — a label is not worth breaking the
                    only way past review for. */}
                {Number.isFinite(importable.data)
                  ? t('importDetail.confirmCount', { count: importable.data })
                  : t('importDetail.confirm')}
              </Text>
            )}
          </Pressable>
        </>
      ) : null}

      {/* Afterwards the same list is a record rather than a decision — which
          tracks arrived, which failed and why. */}
      {data.status === 'importing' || data.status === 'done' ? (
        <MatchReview importId={importId} />
      ) : null}

      {confirm.isError ? (
        <View accessibilityRole="alert">
          <Text style={styles.error}>{confirm.error.message}</Text>
        </View>
      ) : null}

      {/* The import is not finished when the server says so (#159, #215): a
          confirmed import downloads on the *server*, and the songs only enter
          this library once they are on this device. */}
      {handover.running ? (
        <>
          <View style={styles.deviceRow}>
            <ActivityIndicator size="small" color={theme.accentOnSurface} />
            <Text style={styles.meta}>
              {handover.progress
                ? t('importDetail.savingProgress', {
                    done: handover.progress.done,
                    total: handover.progress.total,
                  })
                : t('importDetail.savingToDevice')}
            </Text>
          </View>
          {/* What it is doing *right now*, which is the question a bar that
              looks stuck cannot answer (#370). A retry is the honest reason a
              track is taking three times as long, and saying so is the
              difference between slow and broken. */}
          {handover.progress?.phase === 'retrying' ? (
            <Text style={styles.meta}>
              {t('importDetail.retryingTrack', {
                title: handover.progress.title,
                attempt: handover.progress.attempt,
              })}
            </Text>
          ) : null}
          {/*
            Where the other number went (#398 follow-up).

            The bar counts **this run's work**, which is the honest arithmetic —
            a track already on the device is not being downloaded — and on its
            own it reads as a contradiction beside a playlist that holds more
            than the bar ever counted. I reconciled it himself and said the
            inconsistency was the problem, which is right: a number nobody can
            account for is a number nobody trusts.
          */}
          {handover.progress && handover.progress.alreadyHere > 0 ? (
            <Text style={styles.meta}>
              {t('importDetail.alreadyHere', { count: handover.progress.alreadyHere })}
            </Text>
          ) : null}
          {/* Failures counted while it runs rather than only in the summary —
              and no longer a sign the import is about to give up, because it
              does not give up any more (#369). */}
          {handover.progress && handover.progress.failed > 0 ? (
            <Text style={styles.failed}>
              {t('importDetail.failedSoFar', { count: handover.progress.failed })}
            </Text>
          ) : null}
        </>
      ) : null}

      {/*
        The run stopped for a reason that was not a track (#634).

        `usePlaylistHandover` has returned `failure` since #308 and **nothing
        ever rendered it**, while its own docblock claimed the user *"is told,
        rather than left watching a bar that will not move"*. When
        `importPlaylistOnDevice` throws rather than finishing with failures, the
        `catch` sets this, `running` goes false and `result` stays null — and
        every summary below is gated on `result`, including the retry button. So
        the screen showed nothing at all: no spinner, no error, no counts, no way
        to try again. I reported exactly that shape twice on 2026-08-20,
        about two different sources.

        The same shape as #555: a documented invariant with nothing enforcing it.
      */}
      {handover.failure && !handover.running ? (
        <>
          <View accessibilityRole="alert">
            <Text style={styles.error}>
              {t('importDetail.failed', { message: handover.failure })}
            </Text>
          </View>
          {/* `handover.retry` and not a fresh import: nothing was recorded as
              finished, so re-running the loop skips whatever did land and picks
              up where it stopped. The same button the failed-track summary uses,
              on the path that could not reach that summary. */}
          <Pressable
            onPress={handover.retry}
            accessibilityRole="button"
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          >
            <Text style={styles.buttonText}>{t('importDetail.tryAgain')}</Text>
          </Pressable>
        </>
      ) : null}

      {handover.result ? (
        <>
          {/* Said first and plainly when the run achieved nothing (#567).
              "0 songs are on this device" is technically true and reads like a
              rounding error next to a full progress bar. */}
          {allFailed ? <Text style={styles.failed}>{t('importDetail.noneSaved')}</Text> : null}
          <Text style={styles.meta}>
            {t('importDetail.savedToDevice', { count: handover.result.saved })}
          </Text>
          {/*
            Why the playlist can be shorter than the import (#398 follow-up).

            A 56-track import produced a 55-track playlist, and it was counted
            as a lost track. Nothing was lost: two accepted matches pointed at
            the same video, `songs.source_url` is UNIQUE since v6, and
            `addSongsToPlaylist` skips a song the playlist already holds. One
            video is one song. The device was right and silent, which is the
            combination this iteration exists to remove.
          */}
          {handover.result.duplicates > 0 ? (
            <Text style={styles.meta}>
              {t('importDetail.duplicates', { count: handover.result.duplicates })}
            </Text>
          ) : null}
          {handover.result.gaveUp ? (
            // Stopped on a run of failures rather than finishing: a condition,
            // not scattered bad luck, and grinding through the rest would burn
            // battery to reach the same answer.
            <Text style={styles.failed}>{t('importDetail.gaveUp')}</Text>
          ) : null}
          {handover.result.failed > 0 ? (
            <>
              <Text style={styles.failed}>
                {t('importDetail.deviceSaveFailed', { count: handover.result.failed })}
              </Text>
              {/*
                The way back to two failed tracks out of 136 (#370).

                It used to be "re-create the whole import job", which is the
                server fetching the tracklist and matching all 136 again to
                reach the same two. This forgets the durable record instead, so
                the ordinary loop runs and skips everything already on disk —
                the work is the failures and nothing else.

                Distinct from the `retryFailed` button further up, which re-runs
                the *server's* download and is the thing that does not work.
              */}
              <Pressable
                onPress={handover.retry}
                disabled={handover.running}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.button,
                  handover.running && styles.buttonDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.buttonText}>
                  {t('importDetail.retryOnDevice', { count: handover.result.failed })}
                </Text>
              </Pressable>
            </>
          ) : null}
        </>
      ) : null}

      {/*
        Offered only when something actually arrived (#225).

        The old guard was `status === 'done' && playlist_id != null`, which
        reads as "not a failed import" and is not. `run_confirmed_import`
        creates the playlist *before* downloading and always ends `done` unless
        the orchestration itself throws — partial success is success, by design
        — so an import where every track failed was `done`, with an empty
        playlist and a live link to it.

        And the id has to be the **local** one: since #219 playlists live on the
        device, so the server's id opens nothing.
      */}
      {/* Still gated on something having actually arrived (#225). The playlist
          now exists from the first track onward — it holds the metadata for
          failed ones too — so its existence no longer means anything played. */}
      {handover.result && handover.result.saved > 0 ? (
        <Button
          label={t('importDetail.openPlaylistCount', { count: handover.result.saved })}
          variant="plain"
          onPress={() => router.push(`/playlists/${handover.result?.local_playlist_id}`)}
        />
      ) : null}
    </ScrollView>
  )
}

/**
 * Bring a finished import's songs down to the device (#215).
 *
 * A confirmed import has no per-song job for the client to watch — unlike
 * add-a-link and add-from-search, which both register a job in
 * `useActiveImports` and get the handover from the progress panel. So this is
 * the third entry point, and it runs off the import reaching `done`.
 *
 * `handOverPlaylist` skips songs already on the device and guards against two
 * runs of the same playlist, so leaving this screen and coming back **resumes**
 * rather than restarting. That is also the retry: no state is persisted here,
 * because the presence of the files already is the state.
 *
 * `importedCount` gates it — an import where every track failed is still `done`,
 * with an empty playlist (partial success is success, by design), and there is
 * nothing to fetch.
 */
/**
 * Supply the server with candidates this phone found (#353).
 *
 * A Spotify import used to stall here on the droplet: the tracklist arrived and
 * then every YouTube search was refused, because YouTube does not serve a
 * datacenter address (#177). The searching happens on the phone now and the
 * server still does the scoring.
 *
 * Guarded against running twice for one import. The effect's dependencies
 * include the import's status, which *changes while it runs* — `matched_count`
 * ticks up and the socket pushes a new object every time — so without the ref
 * this would start a second pass over the same tracks on the first update.
 */
function useDeviceMatching(importId: string | null, active: boolean) {
  const [progress, setProgress] = useState<MatchingProgress | null>(null)
  /** Set when the *source* refused this address, not when a track was hard to
   *  find (#586). The two want opposite things said to the user. */
  const [refused, setRefused] = useState(false)
  const started = useRef<string | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (importId === null || !active || started.current === importId) return
    started.current = importId

    let cancelled = false
    void (async () => {
      try {
        await supplyCandidates(importId, {
          onProgress: (update) => {
            if (!cancelled) setProgress(update)
          },
        })
      } catch (error) {
        /*
         * ⚠️ There was no `catch` here at all until #586 — only `try/finally` —
         * so anything `supplyCandidates` threw became an unhandled rejection
         * inside a `void (async () => …)`. It never showed, because the only
         * throw that mattered was being swallowed a layer down.
         *
         * A source refusal is the one failure the user can act on, and the
         * action is *wait*. Everything else stays a log line: the run has
         * already navigated here and the review screen shows what it got.
         */
        if (!cancelled && isSourceRefusal(error)) setRefused(true)
        logWarn('matching.stopped', describeError(error))
      } finally {
        if (!cancelled) setProgress(null)
        // However it ended, the import row on screen is now out of date — it
        // says `matching` and the server may have moved it to `review`.
        void queryClient.invalidateQueries({ queryKey: importKeys.detail(importId) })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [importId, active, queryClient])

  return { progress, refused }
}

function usePlaylistHandover(
  importId: string,
  playlistName: string,
  ready: boolean,
  acceptedCount: number,
) {
  const [running, setRunning] = useState(false)
  /** Bumped by the retry button to re-run the effect below (#370). */
  const [attempt, setAttempt] = useState(0)
  /*
   * Read from the store, not from a callback of our own (#308 follow-up).
   *
   * The run is module state that outlives this screen — deliberately, so
   * leaving the page does not stop the download. That means a screen arriving
   * *during* a run is turned away by the in-progress guard, and a callback it
   * passed would be wired to nothing: the page showed a frozen "0 of 13".
   * Reading a store works whoever started the run.
   */
  const progress = useImportProgress((state) => state.runs[importId] ?? null)
  const [result, setResult] = useState<PlaylistImportResult | null>(null)

  /**
   * What happened last time, read back from disk (#411 follow-up).
   *
   * `result` is component state and the summary below it — how many saved, how
   * many failed, and the **"try the N that failed" button** — is drawn from it.
   * So leaving this screen threw the summary away, and coming back could not
   * rebuild it: the durable record in `finishedImports` makes the loop return
   * early, `outcome` is null, and `result` stayed null forever. The retry button
   * existed for exactly one visit to the page.
   *
   * I found it by tapping the failed track in my library and coming back,
   * which is the most natural thing to do with a failed track — and reported it
   * as tapping the library making the button disappear. It was leaving the
   * screen at all.
   *
   * The record already holds the counts, so nothing new is stored; this only
   * reads what `rememberFinishedImport` has been writing since #308. A live run
   * overwrites it the moment one produces an outcome.
   */
  useEffect(() => {
    // ⚠️ Was `Number.isFinite(importId)`, which is **always false for a
    // string** — so after #610 made ids TEXT this effect silently stopped
    // running for every import, and a reopened screen forgot what the last run
    // managed. An id is either present or it is not.
    if (!importId) return
    let cancelled = false
    void (async () => {
      const remembered = await finishedImport(importId)
      // Never over an outcome from this session: a run that has just finished is
      // more current than the record, and on the retry path the record is about
      // to be forgotten anyway.
      if (!cancelled && remembered) {
        // `duplicates` is optional on the record — entries written before #398
        // simply do not have it — and zero is the honest reading of "the run
        // that wrote this did not count them".
        setResult((current) => current ?? { ...remembered, duplicates: remembered.duplicates ?? 0 })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [importId])
  const { t } = useTranslation()

  /**
   * Say so when a run actually paused while the app was away (#430).
   *
   * The line above the progress bar has always warned that a minimised import
   * stops. That is a warning given *before* anything happens; my report was
   * that nothing says anything when it does — you come back, the bar is exactly
   * where you left it, and the app knew why and did not mention it.
   *
   * The rule lives in `backgroundedRun.ts` because it is the part that can be
   * wrong: claiming a pause that did not happen is worse than silence, since the
   * next time it is true nobody will believe it.
   */
  const awaySpan = useRef<AwaySpan | null>(null)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      const done = useImportProgress.getState().runs[importId]?.done ?? 0
      // Only while a run is actually going: a finished import is *supposed* to
      // sit still, and warning about that would be noise on every visit.
      const running = useImportProgress.getState().runs[importId] !== undefined
      if (next === 'background' || next === 'inactive') {
        awaySpan.current = running ? { done, at: Date.now() } : null
        return
      }
      if (next !== 'active') return
      if (running && pausedWhileAway(awaySpan.current, done, Date.now())) {
        showToast(t('importDetail.pausedWhileAway'))
      }
      awaySpan.current = null
    })
    return () => subscription.remove()
  }, [importId, t])

  /** Why it stopped, when it stopped for a reason that is not a track (#308).
   *  The `catch` here used to be empty, so reaching the server failing looked
   *  exactly like an import sitting still. */
  const [failure, setFailure] = useState<string | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!ready || acceptedCount === 0) return

    let cancelled = false
    void (async () => {
      // Inside the async body: a `setState` called synchronously in an effect
      // cascades a second render, and eslint's react-hooks rules reject it.
      if (!cancelled) setRunning(true)
      if (!cancelled) setFailure(null)
      try {
        const outcome = await importPlaylistOnDevice(importId, playlistName, () => {
          /*
           * Per track, and deliberately not guarded by `cancelled`: the run
           * outlives this screen, and the library is the thing being filled
           * in — it should be right whether or not anyone is watching.
           *
           * Nothing invalidated anything before this, and the local library
           * caches with `staleTime: Infinity`, which is why thirteen
           * imported songs were nowhere to be seen. The playlist screen
           * refetches on navigation, which is why they showed up *there* and
           * nowhere else — and why this looked like an import that had not
           * really happened.
           */
          void queryClient.invalidateQueries({ queryKey: localLibraryKeys.all })
          // **And the playlists**, which the first version forgot. They are a
          // separate key root (`['local-playlists']`), so invalidating the
          // library alone left the playlist page showing what it had cached —
          // reported as "I have to close the app and re-enter".
          void queryClient.invalidateQueries({ queryKey: playlistKeys.all })
          /*
           * **And the import's own lists** (#370).
           *
           * The Imported / Failed tabs stopped reading the server's
           * `TrackMatch.status` in #308 and read this device instead — but
           * nothing ever invalidated that query while a run was going, so they
           * only moved when the screen was left and re-entered. Which is
           * precisely when I was looking at them.
           */
          void queryClient.invalidateQueries({ queryKey: deviceImportKeys.all })
        })
        /*
         * The import's own row changed too (#659).
         *
         * The run marks it `done` with its counts (#655), and that write goes
         * to SQLite — so a screen already watching keeps its cached `importing`
         * and reads "Downloading" after the run has ended, until a navigation
         * away and back. The per-track callback above already refreshes the
         * library, the playlists and this import's track lists; the import's
         * **own** detail key was the one nothing refreshed, which did not
         * matter while the loop never ran at all.
         *
         * Outside the `cancelled` guard for the same reason the per-track
         * invalidation is: the record should be right whether or not anyone is
         * still watching.
         */
        void queryClient.invalidateQueries({ queryKey: importKeys.detail(importId) })
        void queryClient.invalidateQueries({ queryKey: importKeys.list() })
        if (!cancelled && outcome) setResult(outcome)
      } catch (error) {
        // Reaching the server failed rather than any one track. Nothing is
        // recorded as finished, so re-entering the screen tries again — but the
        // user is told, rather than left watching a bar that will not move.
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setRunning(false)
      }
    })()

    return () => {
      // The *screen* stops listening; the import does not stop. It is module
      // state in `playlistImport.ts`, so leaving mid-run and coming back joins
      // the run rather than starting a second one (#268).
      cancelled = true
    }
  }, [ready, acceptedCount, importId, playlistName, queryClient, attempt])

  /**
   * Try the tracks that failed, without re-creating the import (#370).
   *
   * The only route back to "2 of 136 failed" was making the whole job again.
   * What actually stands in the way is the durable record that says this import
   * finished — forget it and the ordinary loop runs, skipping every track
   * already on disk, so the work is exactly the failures.
   */
  const retry = () => {
    void (async () => {
      await forgetFinishedImport(importId)
      // The record is also what `useFinishedImports` is showing on the list
      // screen, so it has to be told.
      await queryClient.invalidateQueries({ queryKey: deviceImportKeys.all })
      setResult(null)
      setAttempt((value) => value + 1)
    })()
  }

  return { running, progress, result, failure, retry }
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    /** The one shared press fill (#378). */
    pressed: { backgroundColor: theme.surfacePressed },
    container: { padding: 20, gap: 6 },
    deviceRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
    title: { fontSize: 20, fontWeight: '600', color: theme.text },
    status: { fontSize: 14, fontWeight: '500', color: theme.accentOnSurface, marginTop: 4 },
    meta: { fontSize: 13, color: theme.textMuted },
    /** A pause, not a crash — `danger` would overstate it. The run resumes by
     *  coming back, and the copy says so (#586). */
    refused: { fontSize: 13, color: theme.text, marginTop: 8, lineHeight: 19 },
    /** A finished run that saved nothing (#567). The bar still fills — the work
     *  did happen — but it must not be the same colour as a success. */
    fillFailed: { backgroundColor: theme.danger },
    notice: {
      marginTop: 10,
      padding: 12,
      borderRadius: 8,
      backgroundColor: theme.surfaceMuted,
      // The rule is what carries it at a glance; the words are for afterwards.
      borderLeftWidth: 3,
      borderLeftColor: theme.accentSolid,
    },
    // `text`, not `textMuted`: muted is the register this notice was lost in.
    noticeText: { fontSize: 13, color: theme.text, lineHeight: 19 },
    track: { height: 6, borderRadius: 999, backgroundColor: theme.surfaceMuted, marginTop: 14 },
    // A spinner and its caption on one line — see the note above about why
    // fetching does not get a bar.
    phase: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
    fill: { height: 6, borderRadius: 999, backgroundColor: theme.accentSolid },
    failed: { fontSize: 13, color: theme.danger, marginTop: 8 },
    error: { fontSize: 13, color: theme.danger, marginTop: 12 },
    button: {
      backgroundColor: theme.accentSolid,
      borderRadius: 8,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 22,
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: theme.accentText, fontSize: 16, fontWeight: '600' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
    hint: { fontSize: 13, color: theme.textMuted },
  })
