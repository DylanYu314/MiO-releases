import Constants from 'expo-constants'
import * as Updates from 'expo-updates'
import { useCallback, useEffect, useRef, useState } from 'react'

import { logInfo, logWarn } from '../diagnostics/log'
import {
  fetchLatestVersion,
  isNewerVersion,
  LATEST_VERSION_URLS,
  type LatestVersion,
} from './latestVersion'

/**
 * The two kinds of update, and why they need separate machinery (#665).
 *
 * | | ships how | app finds out |
 * |---|---|---|
 * | JavaScript fix | `expo-updates`, silently on launch | `useUpdates()` |
 * | native change | a new APK, by hand | `version.json` |
 *
 * `expo-updates` already downloads a JS bundle on every launch and applies it
 * on the *next* one, so the user is silently fixed one launch late and is never
 * told. A native change it cannot deliver at all — the fingerprint differs, so
 * the phone is never offered the update. That second hole is the one that left
 * v1.0.0 undiscoverable by anyone running v0.1.0.
 *
 * ## ⚠️ Both halves fail silently
 *
 * MiO ships with no server (#613). Neither check may ever surface an error: an
 * offline user pressing "check for updates" is told *nothing found*, not
 * *something is wrong*. `fetchLatestVersion` returns `null` for every failure
 * and `checkForUpdateAsync` is wrapped, because it throws when updates are
 * disabled — which is every development build.
 */
/**
 * What a *deliberate* check found.
 *
 * ⚠️ `unreachable` and `upToDate` must stay distinct. Collapsing them would
 * make an offline phone claim it is current — a lie, and precisely the lie that
 * matters, since the reason someone presses the button is that they suspect
 * their app is stale.
 */
export type CheckOutcome = 'upToDate' | 'updateAvailable' | 'unreachable'

export type AppUpdates = {
  /** A JS bundle is downloaded and applies on restart. */
  jsUpdateReady: boolean
  /** A newer APK exists, and where to get it. `null` means "nothing to say". */
  apkUpdate: LatestVersion | null
  /** A manual check is in flight. */
  checking: boolean
  /** What this build calls itself, for display. */
  currentVersion: string | null
  /** Apply the downloaded JS bundle now. */
  restart: () => Promise<void>
  /** Check both kinds, on purpose, because a user asked. */
  checkNow: () => Promise<CheckOutcome>
}

/**
 * ⚠️ Read through `expoConfig` rather than hardcoded, the same reasoning as
 * `src/api/connection.ts`: one edit to `app.json` moves both. `clientErrors.ts`
 * has read it this way since #322.
 */
/**
 * A failure's name and message, in one line, for the diagnostics log.
 *
 * ⚠️ **The class name is the half that matters**, which #303 paid five builds to
 * learn: `session_blocked` said nothing and `session_blocked:<ExceptionClass>`
 * was the whole answer. A bare message loses it.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function currentVersionName(): string | null {
  return Constants.expoConfig?.version ?? null
}

/**
 * Ask `expo-updates` for a JavaScript update, and say which of three things
 * happened rather than two (#776).
 *
 * ⛔ **This used to be an empty `catch`.** Its comment was right that
 * `checkForUpdateAsync` throws on every development build and whenever the
 * network is gone, and wrong about what to do with that: a genuine failure was
 * discarded alongside the harmless cases, and the screen then said *up to date*
 * — the one lie this module exists to avoid. It also made #774 undiagnosable,
 * because a user reporting "updates never arrive" produced no line anywhere.
 *
 * ⚠️ **`isEnabled` is checked rather than caught.** A development build is not a
 * failure, and reporting it as one is how a log fills with noise until nobody
 * reads it — which is the same outcome as logging nothing.
 */
async function checkForJsUpdate(): Promise<'found' | 'none' | 'failed' | 'skipped'> {
  if (!Updates.isEnabled) return 'skipped'

  let available: boolean
  try {
    available = (await Updates.checkForUpdateAsync()).isAvailable
  } catch (error) {
    logWarn('updates.jsCheckFailed', describe(error))
    return 'failed'
  }
  if (!available) return 'none'

  // ⚠️ Separate from the check on purpose. The manifest and the bundle come from
  // different hosts, so "asked and was told yes" and "actually downloaded it"
  // fail independently — which is precisely the distinction #774 needed and
  // could not make.
  try {
    await Updates.fetchUpdateAsync()
  } catch (error) {
    logWarn('updates.jsFetchFailed', describe(error))
    return 'failed'
  }
  return 'found'
}

export function useAppUpdates(): AppUpdates {
  const { downloadedUpdate, checkError, downloadError } = Updates.useUpdates()
  const [apkUpdate, setApkUpdate] = useState<LatestVersion | null>(null)
  const [checking, setChecking] = useState(false)
  const currentVersion = currentVersionName()

  // ⛔ The automatic on-launch check, which is the one almost every user relies
  // on, reported nothing at all before #776 — `useUpdates()` exposes these and
  // nothing read them. A user whose app silently never updates now leaves a line
  // behind without pressing anything.
  //
  // ⚠️ Keyed on the message so a persistent failure logs once per distinct
  // error rather than on every render. The log's own de-duplication is 60
  // seconds, which is shorter than a session.
  const reported = useRef<string | null>(null)
  useEffect(() => {
    const error = checkError ?? downloadError
    if (!error) return
    const detail = describe(error)
    if (reported.current === detail) return
    reported.current = detail
    logWarn(checkError ? 'updates.autoCheckFailed' : 'updates.autoFetchFailed', detail)
  }, [checkError, downloadError])

  // A check that resolves after the screen has gone must not call setState.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /**
   * Work out what the manifest says, touching no React state.
   *
   * Separate from storing it so the effect below can `setApkUpdate` inside a
   * promise callback rather than in its own body — which is what
   * `react-hooks/set-state-in-effect` asks for, and is the same pure/IO split
   * `preflight.ts` uses for the same reason: the decision is testable and the
   * plumbing is trivial.
   */
  const resolveApk = useCallback(async (): Promise<{
    outcome: CheckOutcome
    update: LatestVersion | null
  }> => {
    const current = currentVersionName()
    if (current === null) {
      // Nothing to compare against, so there is no honest answer. Say nothing
      // rather than guessing — this is the branch that would nag every user if
      // `expoConfig` were ever empty in a release build.
      logWarn('updates.noVersion', 'expoConfig.version is unavailable')
      return { outcome: 'unreachable', update: null }
    }

    const latest = await fetchLatestVersion()
    if (latest === null) {
      // Not `upToDate`: nothing was read, so nothing is known.
      //
      // ⚠️ Logged here rather than inside `fetchLatestVersion`, which takes its
      // `fetch` as a seam precisely so it stays pure and testable — importing
      // the logger there would drag AsyncStorage and zustand into it. And it is
      // logged only once every host has failed, because falling through R2 to
      // GitHub is the design working, not a fault.
      // ⚠️ A count, not the URLs. `scrub()` rewrites any URL to `<url>` before
      // this is stored (#354), so listing the hosts would log `<url>, <url>` —
      // leaning on a privacy guard to produce nonsense. The number of hosts
      // tried is what distinguishes "both failed" from "there is only one".
      logWarn('updates.apkCheckFailed', `no host answered (${LATEST_VERSION_URLS.length} tried)`)
      return { outcome: 'unreachable', update: null }
    }

    const newer = isNewerVersion(current, latest.versionName)
    if (newer) logInfo('updates.apkAvailable', `${current} -> ${latest.versionName}`)
    return { outcome: newer ? 'updateAvailable' : 'upToDate', update: newer ? latest : null }
  }, [])

  // One look on mount. Cheap, silent, and the only thing that makes a native
  // release discoverable at all.
  useEffect(() => {
    void resolveApk().then(({ update }) => {
      if (mounted.current) setApkUpdate(update)
    })
  }, [resolveApk])

  const checkNow = useCallback(async (): Promise<CheckOutcome> => {
    setChecking(true)
    try {
      // Ask for a JS update too, so one button answers the user's actual
      // question ("is my app current?") rather than half of it.
      const js = await checkForJsUpdate()

      const { outcome, update } = await resolveApk()
      if (mounted.current) setApkUpdate(update)
      if (outcome === 'updateAvailable' || js === 'found') return 'updateAvailable'
      // ⛔ A JS check that *failed* is not evidence that the app is current, so
      // it must not be allowed to report `upToDate` on the APK check's behalf.
      // That is the exact lie this file's docblock forbids, arriving by a second
      // route (#776). `skipped` is different: updates are disabled, so there was
      // never anything to learn.
      if (js === 'failed' && outcome === 'upToDate') return 'unreachable'
      return outcome
    } finally {
      if (mounted.current) setChecking(false)
    }
  }, [resolveApk])

  const restart = useCallback(async () => {
    try {
      await Updates.reloadAsync()
    } catch {
      // Nothing useful to do: the update applies on the next launch anyway.
    }
  }, [])

  return {
    jsUpdateReady: downloadedUpdate !== undefined,
    apkUpdate,
    checking,
    currentVersion,
    restart,
    checkNow,
  }
}
