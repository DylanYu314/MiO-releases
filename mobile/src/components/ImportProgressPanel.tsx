import { useQueryClient } from '@tanstack/react-query'

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'

import {
  inFlight,
  MAX_AUTO_RETRIES,
  useActiveImports,
  type TrackedImport,
} from '../api/activeImports'
import { useConnection } from '../api/connection'
import { useCreateJob, useJob } from '../api/jobs'
import { isRetryable } from '../api/types'
import { localLibraryKeys } from '../api/localLibrary'
import { handOverSong } from '../library/handover'
import { useTheme, useThemedStyles, type Theme } from '../theme'
import { useGuardedRouter } from '../navigation/useGuardedRouter'

/**
 * A strip saying that something is being added, from wherever you are (#182).
 *
 * Downloads take tens of seconds and used to be visible only on the screen that
 * started them. Leave that screen and the app looked idle, which is how the same
 * link ends up pasted twice.
 *
 * Deliberately not a full list: it says *that* work is happening and how far
 * along, and tapping it goes to the screen that shows the detail. A panel that
 * tried to be the detail view would compete with the one that already is.
 *
 * It renders nothing when nothing is in flight, so it costs no space in the
 * normal case — and, more importantly, opens no sockets.
 */
export function ImportProgressPanel() {
  const { t } = useTranslation()
  const router = useGuardedRouter()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const imports = useActiveImports((state) => state.imports)

  const active = inFlight(imports)
  if (active.length === 0) return null

  return (
    <View style={styles.bar}>
      {/* One subscriber per job. `useJob` opens a socket (with a polling
          fallback), so these must only exist while the job is unfinished —
          which is what filtering to `inFlight` above guarantees. */}
      {active.map((entry) => (
        <ImportWatcher key={entry.jobId} entry={entry} />
      ))}

      <Pressable
        onPress={() => router.push('/add/link')}
        accessibilityRole="button"
        accessibilityLabel={t('importPanel.openAria')}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <ActivityIndicator size="small" color={theme.accentOnSurface} />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {t('importPanel.adding', { count: active.length })}
          </Text>
          <Text style={styles.detail} numberOfLines={1}>
            {active[0].status ? t(`jobStatus.${active[0].status}`) : t('importPanel.starting')}
          </Text>
        </View>
      </Pressable>
    </View>
  )
}

/**
 * Watches one job and writes its status back to the store. Renders nothing.
 *
 * The subscription has to live in a component because `useJob` is a hook, and
 * the store cannot call hooks. Splitting it out means each job gets its own
 * socket and its own lifecycle, rather than the panel juggling a variable number
 * of subscriptions.
 */
function ImportWatcher({ entry }: { entry: TrackedImport }) {
  const { data } = useJob(entry.jobId)
  const setStatus = useActiveImports((state) => state.setStatus)
  const markSavedLocally = useActiveImports((state) => state.markSavedLocally)
  const retried = useActiveImports((state) => state.retried)
  const serverUrl = useConnection((state) => state.serverUrl)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (data?.status) setStatus(entry.jobId, data.status, data.error_code)
  }, [data?.status, data?.error_code, entry.jobId, setStatus])

  /**
   * The server finishing is not the end of the import (#159).
   *
   * Under local-first the song is not in the library until its audio is on this
   * device, so a `done` job is followed by the handover. `inFlight` keeps this
   * component mounted until that lands, which is what stops the watcher
   * unmounting halfway through its own download.
   *
   * The download itself lives in `library/handover.ts` (#215), so search and
   * playlist import can do the same thing without mounting a progress panel.
   * What stays here is the *watching*: this component knows when a job is done.
   *
   * `savedLocally` guards it rather than a ref: the flag is persisted, so an
   * import that completed while the app was closed is not downloaded twice on
   * the next launch.
   */
  /**
   * Try again ourselves before asking the user to (#222).
   *
   * A transient failure is our problem first. The backend already retries
   * transient extraction failures inside the task; this is the second layer,
   * for the ones that arrive here as a finished, failed job — a bot check, a
   * rate limit, a dropped connection.
   *
   * Only *retryable* codes: a private or removed video fails identically
   * forever, and retrying it wastes the user's time while telling them nothing.
   * The budget is two, because a link that has failed the backend's three
   * attempts and two of ours will not come good on a sixth.
   *
   * The record follows the new job rather than gaining a second row — one
   * pasted link is one thing the user is waiting on, however many attempts it
   * takes underneath.
   */
  const createJob = useCreateJob()
  const shouldRetry =
    data?.status === 'failed' && entry.retries < MAX_AUTO_RETRIES && isRetryable(data.error_code)

  useEffect(() => {
    if (!shouldRetry) return

    let cancelled = false
    createJob.mutate(entry.url, {
      onSuccess: (created) => {
        if (!cancelled) retried(entry.jobId, created.id)
      },
    })
    return () => {
      cancelled = true
    }
    // `createJob` is deliberately absent: it is a new object each render, and
    // depending on it would re-fire the retry on every one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldRetry, entry.jobId, entry.url, retried])

  const songId = data?.status === 'done' ? data.song_id : null
  useEffect(() => {
    if (songId == null || entry.savedLocally || !serverUrl) return

    let cancelled = false
    void (async () => {
      try {
        await handOverSong(songId)
        // The song is on the device; the library lists the device (#216).
        await queryClient.invalidateQueries({ queryKey: localLibraryKeys.all })
        if (!cancelled) markSavedLocally(entry.jobId)
      } catch {
        // Left unmarked on purpose: the entry stays in flight, visibly
        // unfinished, and the next launch tries again. Swallowing it *and*
        // marking it done would lose the song silently.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [songId, entry.savedLocally, entry.jobId, serverUrl, markSavedLocally, queryClient])

  return null
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    bar: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      backgroundColor: theme.surface,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    pressed: { backgroundColor: theme.surfacePressed },
    text: { flex: 1, minWidth: 0 },
    title: { fontSize: 14, fontWeight: '600', color: theme.text },
    detail: { fontSize: 12, color: theme.textMuted, marginTop: 1 },
  })
