import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Linking from 'expo-linking'

import { googleFailure, googleLoginUrl, useGooglePlaylists } from '../../../../src/api/google'
import { useListImportProgress } from '../../../../src/api/listImportProgress'
import { localLibraryKeys } from '../../../../src/api/localLibrary'
import { playlistKeys } from '../../../../src/api/localPlaylists'
import { useConnection } from '../../../../src/api/connection'
import type { GooglePlaylist } from '../../../../src/api/types'
import { DeviceAddList } from '../../../../src/components/DeviceAddList'
import { Button } from '../../../../src/components/ui/Button'
import {
  importGooglePlaylistOnDevice,
  type GoogleImportResult,
} from '../../../../src/library/googleImport'
import { useGuardedRouter } from '../../../../src/navigation/useGuardedRouter'
import { useTheme, useThemedStyles, type Theme } from '../../../../src/theme'

/**
 * Pick one of the connected channel's playlists, and fetch it here (#106).
 *
 * ## There is no review step, and that is the feature
 *
 * A Spotify import has to *guess* which YouTube video each track is, so a human
 * confirms the guesses. A private YouTube playlist hands back exact video ids —
 * a review screen would show a list of right answers and ask whether they were
 * right. 2026-08-12: *"its from youtube, user know what they
 * importing."*
 *
 * So picking a playlist starts the download, and what the user watches is the
 * same `DeviceAddList` the add-link and search pages use (#318). No second
 * list-of-things-to-fetch exists.
 *
 * ## Three failures, three answers
 *
 * The listing endpoints answer **401** for an expired connection, **401** for a
 * missing access key, **429** for a spent quota and **503** for an unconfigured
 * server, and every one of them wants the user to do something different.
 * `googleFailure` is where that is decided; this screen renders the answer and
 * puts a *Connect again* button next to the one that has one. The expiry is
 * weekly, so it is the common case rather than an edge one — an unnamed 401
 * here is a feature that looks broken every seven days.
 */
export default function GooglePlaylistsScreen() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const router = useGuardedRouter()
  const queryClient = useQueryClient()
  const serverUrl = useConnection((state) => state.serverUrl)

  const { data: playlists, isPending, isError, error } = useGooglePlaylists()

  const runs = useListImportProgress((state) => state.runs)
  const [chosen, setChosen] = useState<GooglePlaylist | null>(null)
  const [result, setResult] = useState<GoogleImportResult | null>(null)
  const [runFailure, setRunFailure] = useState<unknown>(null)

  /*
   * Which run this screen is showing — the one it started, or one already going.
   *
   * The run is module state that outlives the screen (ADR-019), so leaving and
   * coming back must **join** it rather than show an idle picker over a live
   * download. Derived during render rather than mirrored into state with an
   * effect, which is what ADR-003 and `react-hooks` both ask for.
   */
  const activeId = chosen?.id ?? Object.keys(runs).find((id) => runs[id].running) ?? null
  const progress = activeId ? (runs[activeId] ?? null) : null
  const active = chosen ?? playlists?.find((playlist) => playlist.id === activeId) ?? null

  const start = (playlist: GooglePlaylist) => {
    setChosen(playlist)
    setResult(null)
    setRunFailure(null)
    void (async () => {
      try {
        const outcome = await importGooglePlaylistOnDevice(playlist, () => {
          /*
           * Per video, and not guarded by whether this screen is still mounted:
           * the run outlives it, and the library should be right whether or not
           * anyone is watching. Both key roots, because they are separate
           * caches and the library caches with `staleTime: Infinity` — the
           * playlists one was forgotten first time round on the server path and
           * the report was "I have to close the app and re-enter" (#411).
           */
          void queryClient.invalidateQueries({ queryKey: localLibraryKeys.all })
          void queryClient.invalidateQueries({ queryKey: playlistKeys.all })
        })
        if (outcome) setResult(outcome)
      } catch (failure) {
        // The **listing** failed, which is a different thing from a video
        // failing: it means the account, the key or the quota. A video that
        // cannot be fetched is counted and the run carries on.
        setRunFailure(failure)
      }
    })()
  }

  /**
   * Confirmed, because tapping the wrong row is expensive.
   *
   * This is not "create an import to review later" — it starts downloading, and
   * on mobile data a hundred videos is real traffic. Naming the playlist and
   * its size is what makes a mis-tap recoverable before it costs anything.
   */
  const confirmStart = (playlist: GooglePlaylist) =>
    Alert.alert(
      playlist.title,
      t('google.videoCount', { count: playlist.track_count }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('nav.import'), onPress: () => start(playlist) },
      ],
      { cancelable: true },
    )

  const failure = googleFailure(error ?? runFailure)
  const message =
    failure !== null
      ? t(`google.failure.${failure}`)
      : (error ?? runFailure) instanceof Error
        ? ((error ?? runFailure) as Error).message
        : null

  if (isPending) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
        <Text style={styles.hint}>{t('google.loadingPlaylists')}</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <FlatList
        /*
         * Hidden **while a run is going**, and back once it stops.
         *
         * Not hidden merely because one has been started: after a run finishes,
         * picking another is the ordinary next thing to do, and a screen that
         * has to be left and re-entered to offer it is the shape of stuckness
         * this iteration keeps removing.
         */
        data={progress?.running ? [] : (playlists ?? [])}
        keyExtractor={(playlist) => playlist.id}
        ListHeaderComponent={
          <>
            {message ? (
              <View style={styles.notice} accessibilityRole="alert">
                <Text style={styles.noticeText}>{message}</Text>
                {/* The one failure with something to press. An expired
                    connection is fixed by making a new one, and the whole point
                    of naming it is to be able to offer that here. */}
                {failure === 'reauth' && serverUrl ? (
                  <Button
                    label={t('google.reconnect')}
                    variant="outlined"
                    onPress={() => void Linking.openURL(googleLoginUrl(serverUrl))}
                  />
                ) : null}
              </View>
            ) : null}

            {active && progress ? (
              <View style={styles.run}>
                <Text style={styles.runTitle} numberOfLines={1}>
                  {active.title}
                </Text>
                <Text style={styles.runDetail}>
                  {progress.running
                    ? t('google.importing', { done: progress.done, total: progress.total })
                    : t('google.finished', { count: progress.saved, name: active.title })}
                </Text>
                {progress.alreadyHere > 0 ? (
                  <Text style={styles.runMeta}>
                    {t('google.alreadyHere', { count: progress.alreadyHere })}
                  </Text>
                ) : null}
                {progress.failed > 0 ? (
                  <Text style={[styles.runMeta, styles.failed]}>
                    {t('google.failedCount', { count: progress.failed })}
                  </Text>
                ) : null}

                {/* Said while it matters, and above the list rather than under
                    it: a warning reached by scrolling is read after the mistake
                    it exists to prevent (#450, #458). Background imports are
                    de-scoped, so this is the shipped behaviour, not an excuse. */}
                {progress.running ? (
                  <View style={styles.keepOpen} accessibilityRole="alert">
                    <Text style={styles.noticeText}>{t('importDetail.keepScreenOpen')}</Text>
                  </View>
                ) : null}

                {result ? (
                  <Button
                    label={t('google.openPlaylist')}
                    variant="outlined"
                    onPress={() => router.push(`/playlists/${result.local_playlist_id}`)}
                  />
                ) : null}
              </View>
            ) : null}

            {activeId && !progress ? (
              <View style={styles.run}>
                <ActivityIndicator color={theme.accentOnSurface} />
                <Text style={styles.runMeta}>{t('google.startingImport')}</Text>
              </View>
            ) : null}

            {/*
              Always, and it draws nothing when there is nothing to draw.
              This is the record that **survives leaving the screen** (#318) —
              which video failed and why, with a retry — so it is the one thing
              here that must not be conditional on a run this mount started.
            */}
            <DeviceAddList source="import" />
          </>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => confirmStart(item)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {t('google.videoCount', { count: item.track_count })}
              </Text>
            </View>
            {/* Only where it is not public: a private playlist is the entire
                reason this screen exists, and a list that cannot say which ones
                those are hides the point of it. */}
            {item.privacy === 'private' || item.privacy === 'unlisted' ? (
              <Text style={styles.badge} testID={`privacy-${item.id}`}>
                {t(`google.${item.privacy}`)}
              </Text>
            ) : null}
          </Pressable>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          !activeId && !isError ? (
            <View style={styles.centered}>
              <Text style={styles.hint}>{t('google.noPlaylists')}</Text>
            </View>
          ) : null
        }
      />
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
    pressed: { backgroundColor: theme.surfacePressed },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: 15, fontWeight: '500', color: theme.text },
    rowMeta: { fontSize: 12, color: theme.textMuted, marginTop: 2 },
    badge: {
      fontSize: 11,
      fontWeight: '600',
      color: theme.accentOnSurface,
      backgroundColor: theme.surfaceMuted,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 999,
      overflow: 'hidden',
    },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginLeft: 14 },
    centered: { alignItems: 'center', justifyContent: 'center', gap: 6, padding: 32 },
    hint: { fontSize: 13, color: theme.textMuted, textAlign: 'center' },
    notice: {
      backgroundColor: theme.surfaceMuted,
      borderLeftWidth: 3,
      borderLeftColor: theme.accentSolid,
      borderRadius: 10,
      padding: 12,
      margin: 14,
      gap: 8,
      alignItems: 'flex-start',
    },
    noticeText: { fontSize: 13, lineHeight: 19, color: theme.text },
    keepOpen: {
      backgroundColor: theme.surfaceMuted,
      borderLeftWidth: 3,
      borderLeftColor: theme.accentSolid,
      borderRadius: 10,
      padding: 12,
      marginTop: 4,
    },
    run: { padding: 14, gap: 6, alignItems: 'flex-start' },
    runTitle: { fontSize: 16, fontWeight: '600', color: theme.text },
    runDetail: { fontSize: 14, color: theme.text },
    runMeta: { fontSize: 12, color: theme.textMuted },
    failed: { color: theme.danger },
  })
