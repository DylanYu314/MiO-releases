import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import * as Linking from 'expo-linking'

import { useRefetchOnForeground } from '../../../../src/api/useRefetchOnForeground'
import { useConnection } from '../../../../src/api/connection'
import { describeError } from '../../../../src/diagnostics/log'
import { fetchProfile } from '../../../../src/library/spotifyApi'
import { completeSignIn } from '../../../../src/library/spotifyAuth'
import { useFinishedImports } from '../../../../src/api/deviceImportState'
import { googleLoginUrl, useDisconnectGoogle, useGoogleStatus } from '../../../../src/api/google'
import { useImportProgress } from '../../../../src/api/importProgress'
import {
  spotifyLoginUrl,
  useDisconnectSpotify,
  useSpotifyStatus,
} from '../../../../src/api/spotify'
import {
  useCreateYouTubeImport,
  useDeletePlaylistImport,
  usePlaylistImports,
} from '../../../../src/api/playlistImports'
import type { LocalPlaylistImport as PlaylistImport } from '../../../../src/library/playlistImports'
import { useTheme, useThemedStyles, type Theme } from '../../../../src/theme'
import { useBilibiliAccount } from '../../../../src/library/bilibiliAuth'
import { useGuardedRouter } from '../../../../src/navigation/useGuardedRouter'
import { Button } from '../../../../src/components/ui/Button'
import { SearchSourcePicker } from '../../../../src/components/SearchSourcePicker'

/**
 * Import a public YouTube playlist or a Spotify one, and see the imports
 * already under way.
 *
 * The two are not symmetrical. A public YouTube playlist is its own candidate
 * list, so the backend skips matching and goes straight to review (ADR-010) —
 * paste a link and it starts. Spotify gives only a *track list*, needs an
 * account, and every track has to be found on YouTube first, which is why it is
 * a connect step, a picker and a review screen rather than a text field.
 *
 * The list of past imports is not decoration. A hundred tracks paced at a few
 * seconds each is tens of minutes, so the expected behaviour is to start one and
 * walk away — which only works if you can find it again.
 */
export default function ImportScreen() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const router = useGuardedRouter()
  const [url, setUrl] = useState('')
  const deleteImport = useDeletePlaylistImport()

  /**
   * Confirmed, because it cannot be undone and the wording matters.
   *
   * The message says the songs and the playlist stay — "delete" next to a list
   * of imports could easily read as "delete the music", and that is the one
   * thing this must not be mistaken for.
   */
  const confirmDelete = (item: PlaylistImport) =>
    Alert.alert(t('importPage.deleteTitle'), t('importPage.deleteMessage', { name: item.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => deleteImport.mutate(item.id),
      },
    ])

  const createImport = useCreateYouTubeImport()
  const { data, isPending } = usePlaylistImports()

  const imports = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data])

  /*
   * ⚠️ **The access-key lock is gone from this screen (#622), and that is the
   * point rather than a casualty.**
   *
   * It rendered when `POST /playlist-imports/youtube` answered 401, because the
   * server did the listing and the gate (ADR-009) stood in front of it. The
   * listing happens on the device now, so this screen reaches no server at all
   * — there is nothing left to be refused, and a lock that cannot fire is a
   * screen telling a user to go and find a key they do not need.
   *
   * The key still exists and still gates a **self-hoster's** server. What it
   * no longer does is stand between somebody and their own playlist, which is
   * the project's ground rules clause 5 arriving in code.
   */

  const submit = () => {
    const trimmed = url.trim()
    if (!trimmed) return
    createImport.mutate(trimmed, {
      onSuccess: (created) => {
        setUrl('')
        router.push(`/add/import/${created.id}`)
      },
    })
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <FlatList
        data={imports}
        keyExtractor={(item) => String(item.id)}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.description}>{t('youtubeImport.description')}</Text>
            <TextInput
              style={styles.input}
              value={url}
              onChangeText={setUrl}
              placeholder={t('youtubeImport.urlPlaceholder')}
              accessibilityLabel={t('youtubeImport.title')}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={submit}
            />
            <Pressable
              style={({ pressed }) => [
                styles.button,
                (createImport.isPending || !url.trim()) && styles.buttonDisabled,
                ,
                pressed && styles.pressed,
              ]}
              disabled={createImport.isPending || !url.trim()}
              onPress={submit}
              accessibilityRole="button"
            >
              {createImport.isPending ? (
                <ActivityIndicator color={theme.accentText} />
              ) : (
                <Text style={styles.buttonText}>{t('youtubeImport.import')}</Text>
              )}
            </Pressable>

            {createImport.isError ? (
              <View accessibilityRole="alert">
                <Text style={styles.error}>{createImport.error.message}</Text>
              </View>
            ) : null}

            {/* Every import below matches each track by *searching*, so the
                source applies to all of them (#551). Compact: Settings carries
                the explanation. */}
            <Text style={styles.section}>{t('searchSource.title')}</Text>
            <SearchSourcePicker />

            <SpotifySection />
            {GOOGLE_IMPORT_ENABLED ? <GoogleSection /> : <UnlistedHint />}
            <BilibiliFavSection />
            <NeteaseSection />
            <QQSection />
            <KugouSection />

            {imports.length > 0 ? <Text style={styles.section}>{t('import.recent')}</Text> : null}
            {isPending ? <ActivityIndicator style={styles.footer} /> : null}
          </View>
        }
        renderItem={({ item }) => (
          <ImportRow
            item={item}
            onPress={() => router.push(`/add/import/${item.id}`)}
            onDelete={() => confirmDelete(item)}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
    </KeyboardAvoidingView>
  )
}

function ImportRow({
  item,
  onPress,
  onDelete,
}: {
  item: PlaylistImport
  onPress: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)

  /*
   * The numbers come from **this device** (#308).
   *
   * They used to be `item.imported_count` / `item.import_total`, which are the
   * server's — and the server has downloaded nothing since confirm began
   * sending `download: false` (#270), so this row read "0 of 13" for an import
   * that had finished, and never moved while one was running.
   *
   * Live progress first, then what the last run recorded, and only then the
   * track count for an import that has never been fetched.
   */
  const live = useImportProgress((state) => state.runs[item.id] ?? null)
  const { data: finishedImports } = useFinishedImports()
  const finished = finishedImports?.[item.id] ?? null

  const detail = live
    ? t('importProgress.ofTotal', { value: live.done, total: live.total })
    : finished
      ? t('importProgress.ofTotal', {
          value: finished.saved,
          total: finished.saved + finished.failed,
        })
      : t('importDetail.trackCount', { count: item.track_count ?? 0 })

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {`${t(`importStatus.${item.status}`)} · ${detail}`}
        </Text>
      </View>
      {item.status === 'failed' ? <Text style={styles.failed}>!</Text> : null}
      {/* Any record, succeeded or failed (#224). Deletes the *record*: the
          songs and the playlist it created are ordinary library rows. */}
      <Button
        label={t('importPage.delete')}
        variant="plain"
        onPress={onDelete}
        accessibilityLabel={t('importPage.deleteAria', { name: item.name })}
      />
    </Pressable>
  )
}

/**
 * Connect Spotify, or start an import from it (#203).
 *
 * ## The round trip leaves the app, on purpose
 *
 * OAuth needs a real browser — Spotify's consent page will not render in a
 * WebView it does not trust, and a login form inside our own app is exactly the
 * shape of a phishing page. So `Linking.openURL` hands off to the system
 * browser and the callback deep-links back to `mio://add/import`, which is this
 * screen.
 *
 * **This is why there is no `expo-web-browser` here.** An in-app auth session
 * would be a nicer return journey, and it is a new native module: it would not
 * exist in the installed dev build, so the feature could not be tested until an
 * EAS rebuild. `expo-linking` is already in the binary and already handles
 * `mio://setup?key=…`, so this works today. Worth revisiting when #201/#202
 * force a rebuild anyway.
 *
 * ⚠️ **Since #612 the deep link carries the authorization code itself**, not a
 * "we already stored it" signal. The backend used to receive Spotify's callback,
 * exchange the code and redirect here with nothing but an outcome; Spotify now
 * redirects straight to `mio://add/import?code=…&state=…` and this screen does
 * the exchange. So the parameters *are* the sign-in, and a missed one is a
 * sign-in lost rather than a refresh skipped.
 *
 * `spotify_error` is still read: a failure has nothing to exchange.
 */
function SpotifySection() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const router = useGuardedRouter()
  const {
    spotify_error: failure,
    code,
    state,
  } = useLocalSearchParams<{ spotify_error?: string; code?: string; state?: string }>()
  const [exchangeError, setExchangeError] = useState<string | null>(null)

  const { data: status, refetch } = useSpotifyStatus()
  const disconnect = useDisconnectSpotify()
  // ⚠️ Since #612 this is a local read, not a server body — there is no
  // `accounts` array and no id, because a device signs in as one account.
  const account = status?.connected ? { display_name: status.displayName } : null

  /*
   * Finish the sign-in the deep link arrived with (#612).
   *
   * ⚠️ **Once per code.** The verifier is deleted as it is spent, so a second
   * attempt with the same parameters — which a re-render or a screen rotation
   * would produce — fails with "this device did not start that sign-in" and
   * would show the user an error for a sign-in that actually worked. #538's
   * shape exactly: a confirmed key is spent, and re-polling it reads as expired.
   */
  const exchanged = useRef<string | null>(null)
  useEffect(() => {
    if (!code || exchanged.current === code) return
    exchanged.current = code
    void (async () => {
      try {
        await completeSignIn({ code, state })
        await fetchProfile()
        setExchangeError(null)
      } catch (error: unknown) {
        setExchangeError(describeError(error))
      } finally {
        void refetch()
      }
    })()
  }, [code, state, refetch])

  // Coming back from the browser is a *navigation*, not a mount, so a
  // `useQuery` alone would show the pre-login answer until something else
  // invalidated it.
  useFocusEffect(
    useCallback(() => {
      void refetch()
    }, [refetch]),
  )

  /*
   * And the focus effect is not enough on its own (#312).
   *
   * Connecting hands off to the **system browser**, which backgrounds the app
   * without changing which screen the navigator thinks is focused — so
   * returning re-fires nothing and the section keeps showing "not connected"
   * until the page is left and re-entered, which is exactly what I
   * reported. `AppState` is the event that actually happened.
   */
  useRefetchOnForeground(useCallback(() => void refetch(), [refetch]))

  if (status && !status.configured) {
    // The server has no SPOTIFY_CLIENT_ID. Nothing in the app can fix that, so
    // it says so instead of offering a button that would 503.
    return (
      <View style={styles.spotifyBlock}>
        <Text style={styles.section}>{t('spotify.title')}</Text>
        <Text style={styles.description}>{t('spotify.notConfiguredShort')}</Text>
      </View>
    )
  }

  return (
    <View style={styles.spotifyBlock}>
      <Text style={styles.section}>{t('spotify.title')}</Text>

      {/* ⚠️ `exchangeError` as well as `failure` (#612): the exchange happens on
          this screen now, so it has its own way of going wrong — and gating the
          alert on the deep link's `spotify_error` alone would make a failed
          token exchange invisible, leaving the user looking at a Connect
          button with no idea why nothing happened. */}
      {failure || exchangeError ? (
        <View accessibilityRole="alert">
          <Text style={styles.error}>
            {exchangeError ?? t(`spotify.error.${failure as string}`, t('spotify.error.unknown'))}
          </Text>
        </View>
      ) : null}

      {account ? (
        <>
          <Text style={styles.description}>
            {t('spotify.connectedAs', { name: account.display_name ?? t('spotify.yourAccount') })}
          </Text>
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            onPress={() => router.push('/add/import/spotify')}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>{t('spotify.pickPlaylist')}</Text>
          </Pressable>
          <Button
            label={t('spotify.disconnect')}
            variant="plain"
            onPress={() => disconnect.mutate()}
            disabled={disconnect.isPending}
          />
        </>
      ) : (
        <>
          <Text style={styles.description}>{t('spotify.noAccount')}</Text>
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            /*
             * ⚠️ No longer gated on a server (#612). The sign-in goes straight
             * to Spotify with a PKCE challenge minted here, so what would stop
             * it is a build carrying no client id — which `status.configured`
             * already reports, and which hides this section entirely.
             *
             * Async because the challenge has to be generated and its verifier
             * stored before the browser opens.
             */
            onPress={() => {
              void (async () => {
                await Linking.openURL(await spotifyLoginUrl())
              })()
            }}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>{t('spotify.connect')}</Text>
          </Pressable>
        </>
      )}
    </View>
  )
}

/**
 * Whether this build offers Google sign-in for private playlists (#106, #504).
 *
 * **`false`, and the reason is not technical.** #106 works — backend, client and
 * ADR-014 all shipped and the droplet reports `configured: true`. What stops it
 * is `youtube.readonly` being a **sensitive** scope, which leaves two doors and
 * no third:
 *
 * - **Testing** — only accounts added by hand in the console, and the refresh
 *   token expires every 7 days.
 * - **Published** — either Google verification (privacy policy, verified
 *   domain, demo video, review), or ship unverified and take a warning screen
 *   plus *"a hard cap of 100 total users"*, which is Google's own wording.
 *
 * My call, 2026-08-14: *"i want every user to use it without me manually
 * add their accound, but i also dont want google to review my project."* Neither
 * door gives that, so MiO stops asking for the scope.
 *
 * **Nothing is lost that matters, because a private playlist has a free
 * workaround.** Setting a playlist to **Unlisted** in YouTube keeps it out of
 * search and off the channel, and makes it readable by link — which is exactly
 * what `POST /playlist-imports/youtube` (ADR-010) already takes. `UnlistedHint`
 * below is that instruction. Only **Watch Later** is genuinely unreachable: it
 * cannot be made unlisted.
 *
 * **The code stays, and this is the switch.** A `boolean` annotation rather than
 * an inferred literal, so both branches remain live code — same reason as
 * `SESSION_ENABLED` in `PlayerHost`. Anyone self-hosting with their own Google
 * project flips this one constant and the whole feature is back; it is
 * JavaScript, so it ships over the air.
 */
/**
 * Bilibili favourites (#492, slice 3).
 *
 * Its own section rather than a row on the Spotify one: a Bilibili sign-in
 * grants a *different* thing — a private folder — and the screen behind it is
 * where the credential is explained and can be revoked. Nothing is stored until
 * the user signs in, so this is a link and not a gate.
 */
function BilibiliFavSection() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const router = useGuardedRouter()
  const signedIn = useBilibiliAccount((state) => state.signedIn)

  return (
    <>
      <Text style={styles.section}>{t('bilibiliFav.title')}</Text>
      <Text style={styles.description}>{t('bilibiliFav.intro')}</Text>
      <Button
        label={t(signedIn ? 'bilibiliFav.yourFolders' : 'bilibiliFav.signIn')}
        variant="outlined"
        onPress={() => router.push('/add/import/bilibili')}
      />
    </>
  )
}

/**
 * NetEase Cloud Music (#102, ADR-013).
 *
 * A link and no sign-in, because a NetEase playlist is readable without one —
 * the phone makes two plain HTTP requests and posts the track list. Its own
 * screen rather than a second URL box here: this hub already has one at the
 * top, and two inputs a scroll apart with different rules is how a user pastes
 * a YouTube link into the wrong one.
 */
function NeteaseSection() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const router = useGuardedRouter()

  return (
    <>
      <Text style={styles.section}>{t('netease.title')}</Text>
      <Text style={styles.description}>{t('netease.intro')}</Text>
      <Button
        label={t('netease.open')}
        variant="outlined"
        onPress={() => router.push('/add/import/netease')}
      />
    </>
  )
}

function QQSection() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const router = useGuardedRouter()

  return (
    <>
      <Text style={styles.section}>{t('qq.title')}</Text>
      <Text style={styles.description}>{t('qq.intro')}</Text>
      <Button
        label={t('qq.open')}
        variant="outlined"
        onPress={() => router.push('/add/import/qq')}
      />
    </>
  )
}

function KugouSection() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const router = useGuardedRouter()

  return (
    <>
      <Text style={styles.section}>{t('kugou.title')}</Text>
      <Text style={styles.description}>{t('kugou.intro')}</Text>
      <Button
        label={t('kugou.open')}
        variant="outlined"
        onPress={() => router.push('/add/import/kugou')}
      />
    </>
  )
}

const GOOGLE_IMPORT_ENABLED: boolean = false

/**
 * What to do instead of signing in (#504).
 *
 * Deliberately phrased as a thing to *do* rather than a feature that is
 * missing. Someone with a private playlist has a working route in two taps, and
 * the failure this replaces was a `403` on Google's own page — which reads as
 * MiO being broken and is the worst version of this to leave in place.
 */
function UnlistedHint() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)

  return (
    <View style={styles.spotifyBlock}>
      <Text style={styles.section}>{t('google.title')}</Text>
      <Text style={styles.description}>{t('youtubeImport.privateHint')}</Text>
    </View>
  )
}

/**
 * Connect a YouTube account, for the playlists only its owner can see (#106).
 *
 * ## Why this is a separate section from the box at the top of the screen
 *
 * The URL field above imports a **public** playlist and needs no account at
 * all — anyone can read a public listing. A private playlist is invisible
 * without the owner's permission, which is the entire reason this OAuth round
 * trip exists. Same site, different problem.
 *
 * ## The three states, which is the whole of this component
 *
 * `/google/status` answers `configured`, and separately whether an account is
 * connected. Both "no"s look alike and mean opposite things: an unconfigured
 * *server* cannot complete a login however many times it is tapped, so it says
 * so instead of offering a button that can only 503 (the argument ADR-005 makes
 * for Spotify).
 *
 * ## The weekly expiry is said out loud, before it happens
 *
 * While the consent screen is in Testing, Google expires the refresh token
 * about every 7 days. `/google/status` **cannot see that** — it reads our
 * database, not Google — so this section will go on saying "Connected as …"
 * for an account that has stopped working, and the discovery happens on the
 * next listing call. The standing note is what stops a scheduled expiry
 * reading as MiO being broken; the listing screen (#106, next slice) is where
 * the 401 itself is caught and named.
 *
 * The browser round trip and its `useFocusEffect`/`AppState` refetch are
 * `SpotifySection`'s, above, for the reasons its docblock gives (#312).
 */
export function GoogleSection() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const router = useGuardedRouter()
  const serverUrl = useConnection((state) => state.serverUrl)
  const { google_error: failure } = useLocalSearchParams<{ google_error?: string }>()

  const { data: status, refetch } = useGoogleStatus()
  const disconnect = useDisconnectGoogle()

  useFocusEffect(
    useCallback(() => {
      void refetch()
    }, [refetch]),
  )
  useRefetchOnForeground(useCallback(() => void refetch(), [refetch]))

  if (status && !status.configured) {
    return (
      <View style={styles.spotifyBlock}>
        <Text style={styles.section}>{t('google.title')}</Text>
        <Text style={styles.description}>{t('google.notConfiguredShort')}</Text>
      </View>
    )
  }

  // The id, not the title: a channel with no title is still a connected
  // account, and treating it as unconnected would offer a second login for one
  // the server already holds.
  const connected = status?.channel_id ?? null
  const name = status?.channel_title ?? connected

  const confirmDisconnect = () =>
    Alert.alert(t('google.disconnectTitle'), t('google.disconnectMessage', { name }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('google.disconnect'), style: 'destructive', onPress: () => disconnect.mutate() },
    ])

  return (
    <View style={styles.spotifyBlock}>
      <Text style={styles.section}>{t('google.title')}</Text>

      {failure ? (
        <View accessibilityRole="alert">
          <Text style={styles.error}>
            {t(`google.error.${failure}`, t('google.error.unknown'))}
          </Text>
        </View>
      ) : null}

      {connected ? (
        <>
          <Text style={styles.description}>{t('google.connectedAs', { name })}</Text>
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            onPress={() => router.push('/add/import/google')}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>{t('google.pickPlaylist')}</Text>
          </Pressable>
          <Button
            label={t('google.disconnect')}
            variant="plain"
            onPress={confirmDisconnect}
            disabled={disconnect.isPending}
          />
        </>
      ) : (
        <>
          <Text style={styles.description}>{t('google.noAccount')}</Text>
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            // No server, nothing to log in to: the login URL is the backend's.
            disabled={!serverUrl}
            onPress={() => void Linking.openURL(googleLoginUrl(serverUrl as string))}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>{t('google.connect')}</Text>
          </Pressable>
        </>
      )}

      {/* Said whether or not it has happened yet, because a warning that only
          appears once the account is already broken is a warning that arrives
          after the confusion it exists to prevent. */}
      <Text style={styles.hint}>{t('google.expiry')}</Text>
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    flex: { flex: 1, backgroundColor: theme.background },
    header: { padding: 20, paddingBottom: 8 },
    description: { fontSize: 13, color: theme.textMuted, lineHeight: 19 },
    input: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 11,
      fontSize: 15,
      marginTop: 16,
      color: theme.text,
    },
    button: {
      backgroundColor: theme.accentSolid,
      borderRadius: 8,
      paddingVertical: 13,
      alignItems: 'center',
      marginTop: 12,
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: theme.accentText, fontSize: 15, fontWeight: '600' },
    error: { color: theme.danger, fontSize: 13, marginTop: 14 },
    section: {
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      color: theme.textMuted,
      marginTop: 28,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 13,
      gap: 12,
    },
    pressed: { backgroundColor: theme.surfacePressed },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: 15, fontWeight: '500', color: theme.text },
    rowMeta: { fontSize: 12, color: theme.textMuted, marginTop: 3 },
    failed: { fontSize: 18, fontWeight: '700', color: theme.danger },
    delete: { color: theme.danger, fontSize: 13, paddingHorizontal: 4 },
    spotifyBlock: { gap: 8, marginTop: 20 },
    hint: { fontSize: 12, color: theme.textMuted, lineHeight: 17 },
    disconnect: { fontSize: 13, color: theme.danger, alignSelf: 'flex-start' },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginLeft: 20,
    },
    footer: { paddingVertical: 16 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
    lockedTitle: { fontSize: 18, fontWeight: '600', color: theme.text },
    lockedBody: { fontSize: 14, color: theme.textMuted, textAlign: 'center', lineHeight: 20 },
  })
