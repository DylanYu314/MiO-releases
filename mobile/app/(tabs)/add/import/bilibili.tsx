import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import QRCode from 'react-native-qrcode-svg'

import { useBilibiliFolders } from '../../../../src/api/bilibiliFolders'
import { useListImportProgress } from '../../../../src/api/listImportProgress'
import { localLibraryKeys } from '../../../../src/api/localLibrary'
import { playlistKeys } from '../../../../src/api/localPlaylists'
import { DeviceAddList } from '../../../../src/components/DeviceAddList'
import { Button } from '../../../../src/components/ui/Button'
import { showToast } from '../../../../src/components/Toast'
import { describeError, logError, logInfo, logWarn } from '../../../../src/diagnostics/log'
import type { FavFolder } from '../../../../src/library/bilibiliFav'
import {
  bilibiliImportKey,
  importBilibiliFavOnDevice,
  type BilibiliImportResult,
} from '../../../../src/library/bilibiliImport'
import { useGuardedRouter } from '../../../../src/navigation/useGuardedRouter'
import {
  BilibiliHandoffUnreadable,
  BilibiliSignedOut,
  clearBilibiliCredential,
  loadBilibiliCredential,
  pollQrLogin,
  saveBilibiliCredential,
  startQrLogin,
  useBilibiliAccount,
  type QrSession,
} from '../../../../src/library/bilibiliAuth'
import { useTheme, useThemedStyles, type Theme } from '../../../../src/theme'

/**
 * Sign in to Bilibili, and see the folders that unlocks (#492, slice 3).
 *
 * ## Why there is a login here at all
 *
 * 2026-08-13: *"we not targeting at importing public playlist, we
 * targeting those private one."* A person's own favourites are private by
 * default, so the public reader is the easy half and not the point. Bilibili
 * offers **no OAuth**, so the only route to a private folder is `SESSDATA` — a
 * cookie that is the whole account — and QR is how Bilibili's own TV apps get
 * one. `docs/bilibili.md` §6.1 is the decision and its conditions.
 *
 * The premise was measured against a real account before this was written: a
 * private folder reads back with `SESSDATA` alone, and `bili_jct` — the token
 * for *writes* — is not needed and is discarded.
 *
 * ## What this screen does
 *
 * Signs in, lists the folders, imports one, and disconnects.
 *
 * The import is `runListImport` — the same loop the private-YouTube import uses
 * — reached through `bilibiliImport.ts`. It was made generic in its own PR
 * rather than copied here: 440 lines of pacing, retries, ordered flush and a
 * foreground-task heartbeat is how two loops drift into two sets of bugs.
 *
 * **There is no review step**, for ADR-014's reason: a favourites folder hands
 * back exact `bvid`s, so a review would show a list of right answers and ask
 * whether they were right. So the confirmation dialog is the only thing between
 * a mis-tap and a hundred videos over mobile data.
 *
 * ⚠️ **The count Bilibili shows and the count imported can differ**, and that
 * is correct: dead entries (`attr !== 0`) still count towards a folder's own
 * total. `skipped` is shown for exactly that reason — arithmetic that silently
 * disagrees with Bilibili's own number reads as a bug forever.
 *
 * ## Polling
 *
 * ⚠️ **The status is `data.code`, not the outer `code`**, which is `0`
 * throughout — including while nothing has happened. `pollQrLogin` already
 * makes that decision; this screen only renders it. Polling stops when the
 * screen goes away, when the code expires, and when the login lands.
 */

/** Bilibili's own web client polls about this often. */
const POLL_MS = 2000

/** Roughly three minutes, which is past the code's own lifetime — the `expired`
 *  answer normally arrives first, and this is the backstop if it never does. */
const MAX_POLLS = 90

export default function BilibiliFavouritesScreen() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()

  const signedIn = useBilibiliAccount((state) => state.signedIn)
  const userId = useBilibiliAccount((state) => state.userId)

  const [session, setSession] = useState<QrSession | null>(null)
  const [phase, setPhase] = useState<'waiting' | 'scanned' | 'expired' | null>(null)
  const [starting, setStarting] = useState(false)

  /** The folder this mount started, or joined by tapping it again. */
  const [chosen, setChosen] = useState<FavFolder | null>(null)
  const [result, setResult] = useState<BilibiliImportResult | null>(null)
  const [runFailure, setRunFailure] = useState<unknown>(null)

  const queryClient = useQueryClient()
  const router = useGuardedRouter()
  /*
   * Read from the store rather than held here: the run outlives this screen
   * (ADR-019), so leaving and returning must show the run in progress rather
   * than an idle picker.
   */
  const progress = useListImportProgress((state) =>
    chosen ? state.runs[bilibiliImportKey(chosen.mediaId)] : undefined,
  )

  /*
   * A query rather than an effect that sets state (ADR-003). Loading, failure
   * and refetch are three states worth not reinventing, and the effect version
   * tripped `react-hooks/set-state-in-effect` — correctly.
   */
  const foldersQuery = useBilibiliFolders(signedIn ? userId : null)
  // The two failures ask for opposite things (§6.1): a dead session wants
  // "sign in again", anything else is about the request. Collapsing them is
  // what made #106 look broken every seven days — and here there is no refresh
  // token at all, so expiry is certain rather than likely.
  const signedOut = foldersQuery.error instanceof BilibiliSignedOut

  // The credential outlives the screen, so a return visit must not show a
  // sign-in button to someone who is already signed in.
  useEffect(() => {
    void loadBilibiliCredential()
  }, [])

  /*
   * The poll loop.
   *
   * A ref for the session id rather than the state, so a code replaced while a
   * request is in flight cannot have its answer applied to the new one — the
   * shape of bug that makes a fresh QR code report "expired" immediately.
   */
  const activeKey = useRef<string | null>(null)

  useEffect(() => {
    if (!session) return
    activeKey.current = session.qrcodeKey

    let cancelled = false
    let polls = 0

    const timer = setInterval(async () => {
      if (cancelled) return
      if (++polls > MAX_POLLS) {
        // Clear the session as well, or the backstop leaves the QR on screen
        // and keeps polling for a code that will never answer anything else —
        // `phase` alone is not read while `session` is set.
        logWarn('bilibili.qr.gaveUp', `polls=${polls - 1}`)
        setPhase('expired')
        setSession(null)
        return
      }
      try {
        const status = await pollQrLogin(session.qrcodeKey)
        if (cancelled || activeKey.current !== session.qrcodeKey) return

        /*
         * One line per *transition*, not per poll: the log collapses an
         * immediate repeat, so two seconds apart for three minutes writes one
         * entry per answer rather than ninety. This is the opposite of #371,
         * where the de-duplication erased the thing being counted — here the
         * repeats are the noise and the change of answer is the whole signal.
         */
        logInfo('bilibili.qr.poll', `state=${status.state}`)

        if (status.state === 'done') {
          /*
           * ⚠️ **`via` is the one thing only a phone can answer.** The
           * credential arrives in `Set-Cookie` (measured 2026-08-15), and
           * React Native's `fetch` is OkHttp with its own cookie jar — whether
           * a `Set-Cookie` survives to JavaScript is not checkable from a
           * laptop. `cookie` means the header is visible here; `query` means it
           * is not and the fallback carried the login.
           */
          logInfo('bilibili.qr.credentialFrom', `via=${status.via}`)
          setSession(null)
          setPhase(null)
          // The store update is what flips this screen over to the folder list.
          await saveBilibiliCredential(status.credential)
          return
        }
        setPhase(status.state)
        if (status.state === 'expired') setSession(null)
      } catch (error) {
        /*
         * A single failed poll is not a failed login — the next one is two
         * seconds away, and the backstop above ends it if they all fail.
         *
         * ⚠️ **It is still written down.** This `catch` used to be empty, and
         * an empty one here is indistinguishable from a working login that
         * cannot be stored: `pollQrLogin` throws when a *confirmed* scan hands
         * back something unreadable, the next poll then answers `86038` because
         * the key has been spent, and the screen honestly reports "expired".
         * That is a login failing with no record of why, which is what I
         * saw on 2026-08-15 — *"it says the code expired… no error log caught"*.
         *
         * The unreadable case gets its own name and carries the *shape* of what
         * Bilibili sent — a length and the parameter names, never a value —
         * because "the login failed" would leave the next person exactly where
         * this one started.
         */
        if (error instanceof BilibiliHandoffUnreadable) {
          logError('bilibili.qr.unreadable', error.describe())
        } else {
          logWarn('bilibili.qr.pollFailed', describeError(error))
        }
      }
    }, POLL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [session])

  const beginLogin = async () => {
    setStarting(true)
    setPhase('waiting')
    try {
      setSession(await startQrLogin())
    } catch (error) {
      // "Ask for a new code" is the right offer whether the code expired or was
      // never issued — but which one it was belongs in the log, not guessed at.
      logWarn('bilibili.qr.startFailed', describeError(error))
      setPhase('expired')
      setSession(null)
    } finally {
      setStarting(false)
    }
  }

  const disconnect = async () => {
    await clearBilibiliCredential()
    showToast(t('bilibiliFav.disconnected'))
  }

  const start = (folder: FavFolder) => {
    setChosen(folder)
    setResult(null)
    setRunFailure(null)
    void (async () => {
      try {
        const outcome = await importBilibiliFavOnDevice(folder, () => {
          /*
           * Per track, and not guarded by whether this screen is still mounted:
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
        // The **folder listing** failed, which is a different thing from a
        // video failing: it means the session or the folder. A video that
        // cannot be fetched is counted and the run carries on.
        logWarn('bilibiliImport.listingFailed', describeError(failure))
        setRunFailure(failure)
      }
    })()
  }

  /**
   * Confirmed, because tapping the wrong row is expensive.
   *
   * There is no review step (ADR-014's reasoning: a favourites folder hands
   * back exact `bvid`s, so a review would show a list of right answers), which
   * makes this the only thing between a mis-tap and a hundred videos over
   * mobile data.
   */
  const confirmStart = (folder: FavFolder) =>
    Alert.alert(
      folder.title,
      t('bilibiliFav.itemCount', { count: folder.declaredCount }),
      [
        { text: t('bilibiliFav.cancel'), style: 'cancel' },
        { text: t('bilibiliFav.import'), onPress: () => start(folder) },
      ],
      { cancelable: true },
    )

  return (
    <ScrollView style={{ backgroundColor: theme.background }} contentContainerStyle={styles.page}>
      <Text style={styles.title}>{t('bilibiliFav.title')}</Text>

      {signedIn ? (
        <>
          <View style={styles.accountRow}>
            <Text style={styles.account}>{t('bilibiliFav.signedInAs', { userId })}</Text>
            <Button label={t('bilibiliFav.disconnect')} variant="plain" onPress={disconnect} />
          </View>

          <Text style={styles.heading}>{t('bilibiliFav.yourFolders')}</Text>

          {foldersQuery.isPending ? (
            <View style={styles.centred}>
              <ActivityIndicator color={theme.accentSolid} />
              <Text style={styles.hint}>{t('bilibiliFav.loadingFolders')}</Text>
            </View>
          ) : foldersQuery.error ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>
                {t(signedOut ? 'bilibiliFav.signedOut' : 'bilibiliFav.loadFailed')}
              </Text>
              <Button
                label={t(signedOut ? 'bilibiliFav.signIn' : 'bilibiliFav.retry')}
                variant="outlined"
                onPress={signedOut ? disconnect : () => void foldersQuery.refetch()}
              />
            </View>
          ) : (
            <FlatList
              scrollEnabled={false}
              /*
               * Hidden **while a run is going**, and back once it stops — the
               * same rule the Google picker uses. Not hidden merely because one
               * has been started: after a run finishes, picking another folder
               * is the ordinary next thing to do.
               */
              data={progress?.running ? [] : (foldersQuery.data ?? [])}
              keyExtractor={(folder) => folder.mediaId}
              ListEmptyComponent={
                progress?.running ? null : (
                  <Text style={styles.hint}>{t('bilibiliFav.noFolders')}</Text>
                )
              }
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => confirmStart(item)}
                  style={({ pressed }) => [styles.folder, pressed && styles.pressed]}
                  accessibilityRole="button"
                >
                  <Text style={styles.folderTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={styles.folderMeta}>
                    {t('bilibiliFav.itemCount', { count: item.declaredCount })} ·{' '}
                    {t(item.isPrivate ? 'bilibiliFav.private' : 'bilibiliFav.public')}
                  </Text>
                </Pressable>
              )}
            />
          )}

          {chosen && progress ? (
            <View style={styles.run}>
              <Text style={styles.runTitle} numberOfLines={1}>
                {chosen.title}
              </Text>
              <Text style={styles.runDetail}>
                {progress.running
                  ? t('bilibiliFav.importing', { done: progress.done, total: progress.total })
                  : t('bilibiliFav.finished', { count: progress.saved, name: chosen.title })}
              </Text>
              {progress.alreadyHere > 0 ? (
                <Text style={styles.runMeta}>
                  {t('bilibiliFav.alreadyHere', { count: progress.alreadyHere })}
                </Text>
              ) : null}
              {progress.failed > 0 ? (
                <Text style={[styles.runMeta, styles.failedText]}>
                  {t('bilibiliFav.failedCount', { count: progress.failed })}
                </Text>
              ) : null}
              {/* A folder Bilibili calls 55 can legitimately import 52, because
                  dead entries still count towards its own total. Said out loud,
                  or the arithmetic reads as a bug forever. */}
              {result && result.skipped > 0 ? (
                <Text style={styles.runMeta}>
                  {t('bilibiliFav.skipped', { count: result.skipped })}
                </Text>
              ) : null}

              {/* Said while it matters, and above the list rather than under it:
                  a warning reached by scrolling is read after the mistake it
                  exists to prevent (#450, #458). Background imports are
                  de-scoped, so this is the shipped behaviour, not an excuse. */}
              {progress.running ? (
                <View style={styles.notice} accessibilityRole="alert">
                  <Text style={styles.noticeText}>{t('importDetail.keepScreenOpen')}</Text>
                </View>
              ) : null}

              {result ? (
                <Button
                  label={t('bilibiliFav.openPlaylist')}
                  variant="outlined"
                  onPress={() => router.push(`/playlists/${result.local_playlist_id}`)}
                />
              ) : null}
            </View>
          ) : chosen ? (
            <View style={styles.run}>
              <ActivityIndicator color={theme.accentOnSurface} />
              <Text style={styles.runMeta}>{t('bilibiliFav.startingImport')}</Text>
            </View>
          ) : null}

          {runFailure ? (
            <View style={styles.notice} accessibilityRole="alert">
              <Text style={styles.noticeText}>
                {t(
                  runFailure instanceof BilibiliSignedOut
                    ? 'bilibiliFav.signedOut'
                    : 'bilibiliFav.importFailed',
                )}
              </Text>
            </View>
          ) : null}

          {/*
            Always, and it draws nothing when there is nothing to draw. This is
            the record that **survives leaving the screen** (#318) — which video
            failed and why, with a retry — so it must not be conditional on a
            run this mount started.
          */}
          <DeviceAddList source="import" />
        </>
      ) : session ? (
        <View style={styles.centred}>
          <Text style={styles.heading}>{t('bilibiliFav.scanTitle')}</Text>
          {/* White quiet zone regardless of theme: a dark-on-dark QR does not
              scan, and the code is the one thing here that must work. */}
          <View style={styles.qr}>
            <QRCode value={session.url} size={220} backgroundColor="#ffffff" color="#000000" />
          </View>
          <Text style={styles.hint}>{t('bilibiliFav.scanHint')}</Text>
          <Text style={styles.status}>
            {t(phase === 'scanned' ? 'bilibiliFav.scanned' : 'bilibiliFav.waiting')}
          </Text>
          <Button
            label={t('bilibiliFav.cancel')}
            variant="plain"
            onPress={() => {
              setSession(null)
              setPhase(null)
            }}
          />
        </View>
      ) : (
        <View style={styles.centred}>
          <Text style={styles.intro}>{t('bilibiliFav.intro')}</Text>
          {phase === 'expired' ? (
            <Text style={styles.status}>{t('bilibiliFav.expired')}</Text>
          ) : null}
          <Button
            label={t(phase === 'expired' ? 'bilibiliFav.newCode' : 'bilibiliFav.signIn')}
            variant="filled"
            onPress={beginLogin}
            disabled={starting}
          />
          {/* Says what is actually held and where, because the honest answer is
              short and the alternative is a user guessing. */}
          <Text style={styles.hint}>{t('bilibiliFav.credentialNote')}</Text>
        </View>
      )}
    </ScrollView>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    page: { padding: 16, gap: 12, paddingBottom: 48 },
    title: { fontSize: 22, fontWeight: '700', color: theme.text },
    intro: { fontSize: 14, color: theme.textMuted, lineHeight: 20 },
    heading: {
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      color: theme.textMuted,
      paddingTop: 8,
    },
    centred: { gap: 12, alignItems: 'center', paddingVertical: 12 },
    qr: { padding: 16, backgroundColor: '#ffffff', borderRadius: 12 },
    hint: { fontSize: 13, color: theme.textMuted, lineHeight: 19, textAlign: 'center' },
    status: { fontSize: 14, color: theme.accentOnSurface, fontWeight: '600' },
    accountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    account: { fontSize: 14, color: theme.text, flex: 1 },
    folder: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border },
    folderTitle: { fontSize: 15, fontWeight: '500', color: theme.text },
    folderMeta: { fontSize: 12, color: theme.textMuted, marginTop: 2 },
    notice: { gap: 10, paddingVertical: 8 },
    noticeText: { fontSize: 14, color: theme.text, lineHeight: 20 },
    /* `theme.surfacePressed` and not a hand-picked colour: every pressable in
     * the app fills with that one token (#378), and
     * `pressFeedbackConsistency.test.ts` reads the source to prove it. */
    pressed: { backgroundColor: theme.surfacePressed },
    run: { padding: 14, gap: 6, alignItems: 'flex-start' },
    runTitle: { fontSize: 16, fontWeight: '600', color: theme.text },
    runDetail: { fontSize: 14, color: theme.text },
    runMeta: { fontSize: 12, color: theme.textMuted },
    failedText: { color: theme.danger },
  })
