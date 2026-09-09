import { useQueryClient } from '@tanstack/react-query'

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { localLibraryKeys } from '../../../src/api/localLibrary'
import { DeviceAddList } from '../../../src/components/DeviceAddList'
import { importToDevice } from '../../../src/library/deviceImport'
import {
  listBilibiliParts,
  type BilibiliPart,
  type BilibiliVideoParts,
} from '../../../src/library/bilibili'
import { importBilibiliPartsOnDevice } from '../../../src/library/bilibiliImport'
import { playlistKeys } from '../../../src/api/localPlaylists'
import { PartPicker } from '../../../src/components/PartPicker'
import { showToast } from '../../../src/components/Toast'
import { describeError, logWarn } from '../../../src/diagnostics/log'
import { canImportOnDevice, platformOf } from '../../../src/library/sources'
import { linkToImport } from '../../../src/library/linkText'
import { useSharedText } from '../../../src/library/sharedText'
import { useTheme, useThemedStyles, type Theme } from '../../../src/theme'

/**
 * Paste a link, get a song — fetched by this phone (#320, #492).
 *
 * ## The server route has left this screen
 *
 * It used to be here as the big filled button, with the on-device import
 * underneath as a secondary outlined one. That was the wrong way round and it
 * cost real confusion: the obvious action produced a track that lives on the
 * server and streams, which is what "seeking is slow" turned out to be.
 *
 * *"remove add link from server from add link page, I know add link from
 * bilibili still rely on that... we detach add link from bilibili feature from
 * that page, make it separate page."*
 *
 * So it moved rather than died: `add/bilibili.tsx` is the server route now, and
 * `JobProgress`, `useJob` and the recent-jobs list went with it. This screen is
 * one path, and it is the one that makes *"music is stored on the user's
 * device"* literally true — the phone asks YouTube directly and writes the
 * result to its own library.
 *
 * Still needs **no access key**: `POST /jobs` was the open endpoint (ADR-009)
 * and this route talks to no endpoint at all.
 *
 * ## Bilibili arrives here too (#492)
 *
 * This screen used to refuse a Bilibili link and point at `add/bilibili.tsx`,
 * the one page where the **server** downloads. It does not have to any more:
 * the phone can fetch Bilibili itself, with three unauthenticated requests and
 * a `buvid3` cookie we mint. `canImportOnDevice` now answers for both sites and
 * `importToDevice` routes on the URL, so nothing on this screen chooses.
 *
 * The refusal notice stays for everything that is *neither* — the message names
 * what the device can do rather than a class nobody outside this repo has heard
 * of, which is what it replaced in #320.
 *
 * ## What this screen remembers
 *
 * `DeviceAddList` (#318), not `useActiveImports` — the latter is keyed on a
 * numeric server job id, which a device import does not have. It went to the
 * Bilibili page with the rest of the server path.
 */
export default function AddLinkScreen() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const [url, setUrl] = useState('')
  /** Changes when a *new* share arrives, which is what fills the box again for
   *  a second share while this screen is already open. */
  const sharedPending = useSharedText((state) => state.pending)
  /** The last share written into the box, so one share fills it once. */
  const [applied, setApplied] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const [deviceState, setDeviceState] = useState<
    { status: 'idle' } | { status: 'working' } | { status: 'done'; title: string }
  >({ status: 'idle' })
  const [deviceError, setDeviceError] = useState<string | null>(null)
  /** True while the parts listing is in flight — one request, but a slow one on
   *  a bad connection, and a button that does nothing visible reads as broken. */
  const [checking, setChecking] = useState(false)
  /** The video whose parts are being chosen, or null (#575). */
  const [choosing, setChoosing] = useState<BilibiliVideoParts | null>(null)

  /**
   * Whether what is typed can be fetched here at all.
   *
   * Derived during render rather than mirrored into state: it is a pure
   * function of the input, and `react-hooks` rightly refuses a `setState` in an
   * effect to track a value already available (ADR-003).
   *
   * An empty box is not wrong, it is empty — so it says nothing.
   */
  /*
   * The link inside whatever was pasted (#573).
   *
   * Nothing shares a bare URL — every share sheet and "copy link" button hands
   * over a sentence, and Bilibili's is a bracketed title followed by a link
   * with tracking parameters. All of those were refused, because validation
   * starts at `new URL(input)`, and the user had to edit the text down by hand
   * on a phone keyboard.
   *
   * `canImportOnDevice` is the preference rather than the filter: with several
   * links, the one this phone can fetch is the interesting one wherever it
   * sits — and when none of them is, the *first* still comes back so the
   * "needs the server" notice below can name a real link instead of nothing.
   */
  const trimmed = linkToImport(url, canImportOnDevice) ?? url.trim()
  const wrongPlatform = trimmed.length > 0 && !canImportOnDevice(trimmed)

  /**
   * Fetch one link onto the device.
   *
   * Takes the URL rather than reading the input, so the record's "try again"
   * (#318) can re-run one that failed days ago without the box having to hold
   * it — the record is the memory now, not this screen.
   */
  const addOnDevice = (target: string) => {
    const value = target.trim()
    // Guarded here as well as on the button: `DeviceAddList`'s retry calls
    // straight in with a URL this screen never validated.
    if (!value || !canImportOnDevice(value)) return

    setDeviceError(null)
    setDeviceState({ status: 'working' })
    void (async () => {
      try {
        const result = await importToDevice(value, { source: 'link' })
        // The library reads the device now (#216), so this is what makes the
        // song appear — without it the download succeeds and nothing shows.
        await queryClient.invalidateQueries({ queryKey: localLibraryKeys.all })
        setDeviceState({ status: 'done', title: result.title })
        setUrl('')
      } catch (error) {
        // Shown rather than swallowed: a failure that says nothing is what made
        // #177 expensive to diagnose.
        setDeviceError(error instanceof Error ? error.message : String(error))
        setDeviceState({ status: 'idle' })
      }
    })()
  }

  /**
   * Ask which parts, when there is more than one (#575).
   *
   * 2026-08-17: *"yes we asked, and we allow user to select which
   * episodes, or select all"*.
   *
   * ⚠️ **The listing happens before anything is imported**, and it is one
   * `view` call — the same one the extractor was about to make — so asking the
   * question costs what the answer was going to cost anyway.
   *
   * Only for Bilibili, and only for a video that actually has parts. Everything
   * else, including a single-part Bilibili upload, goes straight down
   * `addOnDevice` exactly as before: a sheet that appears with one row in it is
   * a question with no answer.
   *
   * A listing failure is **not** fatal here. If Bilibili will not say what the
   * parts are, the ordinary import is still worth attempting — it may well
   * succeed, and refusing to try because a question could not be asked would
   * turn a working add into a dead end.
   */
  /*
   * Pre-filled from a share, never imported straight away (#573).
   *
   * 2026-08-17: *"prefill is fine"*. It is also the safer half — a share
   * sheet is easy to hit by accident, and #246's imports are not free — and it
   * is what makes the multi-part picker work for a shared Bilibili link with no
   * extra wiring, because the ordinary Add button still runs.
   *
   * ## Adjusted during render, not in an effect
   *
   * `react-hooks` refuses a synchronous `setState` inside an effect and it is
   * right to: this is the "reset state when an input changes" case React
   * documents, and doing it during render costs one render rather than two.
   * `applied` is what makes it once-per-share instead of once-per-render.
   */
  if (sharedPending !== null && sharedPending !== applied) {
    setApplied(sharedPending)
    setUrl(sharedPending)
  }

  /*
   * And the store is emptied, which is a separate job.
   *
   * `applied` alone would stop the box re-filling on *this* mount and not on
   * the next one — leaving the screen and coming back would meet the same link
   * again, which is the whole thing `sharedText.ts` exists to prevent. Clearing
   * external state is what an effect is *for*; no state of this component is
   * set here.
   */
  useEffect(() => {
    if (sharedPending !== null) useSharedText.getState().take()
  }, [sharedPending])

  const submit = () => {
    // The extracted link, not the raw box: what the user pasted may be a
    // sentence, and every path below this wants the URL (#573).
    const value = trimmed
    if (!value || !canImportOnDevice(value)) return
    if (platformOf(value) !== 'bilibili') {
      addOnDevice(value)
      return
    }

    setDeviceError(null)
    setChecking(true)
    void (async () => {
      try {
        const video = await listBilibiliParts(value)
        if (video.parts.length > 1) {
          setChoosing(video)
          return
        }
      } catch (error) {
        logWarn('bilibili.parts.failed', describeError(error))
      } finally {
        setChecking(false)
      }
      addOnDevice(value)
    })()
  }

  /**
   * Import what they chose.
   *
   * **One part is not a list.** It goes down the ordinary path, where a single
   * track has never made a playlist and should not start now. Two or more is
   * `listImport.ts` — the walk that already paces, retries, flushes in order and
   * holds a foreground service, each rule bought with a device pass.
   */
  const importParts = (parts: BilibiliPart[]) => {
    const video = choosing
    setChoosing(null)
    if (!video || parts.length === 0) return
    if (parts.length === 1) {
      addOnDevice(parts[0].url)
      return
    }

    showToast(t('parts.started', { count: parts.length, name: video.title }))
    setUrl('')
    void (async () => {
      await importBilibiliPartsOnDevice({ ...video, parts }, () =>
        queryClient.invalidateQueries({ queryKey: localLibraryKeys.all }),
      )
      await queryClient.invalidateQueries({ queryKey: playlistKeys.all })
    })()
  }
  const busy = deviceState.status === 'working' || checking

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {/*
          No standing description here (#374).

          `addLink.description` — "Paste a link from YouTube, Bilibili, or any
          other supported site… downloaded in the background" — described the
          *server* route, and stopped being true of this screen in #320. It is
          still rendered by the **web** client, where the server really does
          fetch it and really does support any site yt-dlp does, so the string
          stays in `shared/i18n`; what was wrong was showing it here.

          What replaces it is `onDeviceHint` under the button, which already
          says the true thing — this phone, YouTube only — and the Bilibili
          pointer below, which now appears only once a Bilibili link is
          actually pasted.
        */}
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder="https://..."
          placeholderTextColor={theme.textMuted}
          accessibilityLabel={t('addLink.urlAria')}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={submit}
        />

        {/*
          Said before the attempt, not after it (#320).

          This used to surface as a raw `NotAYouTubeLink` thrown from inside the
          import — an internal class name, with nothing to do about it. A link
          this screen cannot handle is an ordinary situation, and the honest
          answer is now simply what MiO can read.

          ⚠️ **There is no page to point at any more** (#637). It used to offer
          the "Other sites" screen, which handed the link to `POST /jobs` on a
          server — and after #613 the app ships without one and after #614 that
          endpoint needs an access key on a server the user runs themselves. An
          offer nobody can take is worse than none.

          Since #492 a Bilibili link is **not** one of these: it is fetched here
          like any other.
        */}
        {wrongPlatform ? (
          <View style={styles.notice} accessibilityRole="alert">
            <Text style={styles.noticeText}>{t('addLink.unsupportedSite')}</Text>
          </View>
        ) : null}

        <Pressable
          style={({ pressed }) => [
            styles.button,
            (busy || !trimmed || wrongPlatform) && styles.buttonDisabled,
            pressed && styles.pressed,
          ]}
          disabled={busy || !trimmed || wrongPlatform}
          onPress={submit}
          accessibilityRole="button"
        >
          {busy ? (
            <ActivityIndicator color={theme.accentText} />
          ) : (
            <Text style={styles.buttonText}>{t('addLink.add')}</Text>
          )}
        </Pressable>
        <Text style={styles.hint}>{t('addLink.onDeviceHint')}</Text>

        {busy ? <Text style={styles.hint}>{t('addLink.onDeviceWorking')}</Text> : null}
        {deviceState.status === 'done' ? (
          <Text style={styles.done}>{t('addLink.onDeviceDone', { title: deviceState.title })}</Text>
        ) : null}

        <DeviceAddList source="link" onRetry={(retryUrl) => void addOnDevice(retryUrl)} />

        {deviceError ? (
          <View accessibilityRole="alert">
            <Text style={styles.error}>{deviceError}</Text>
          </View>
        ) : null}
      </ScrollView>

      {/* Outside the scroll view: it is a modal, and mounting it inside one
          makes its own list fight the page's scroll. */}
      {choosing ? (
        <PartPicker
          title={choosing.title}
          parts={choosing.parts}
          onConfirm={importParts}
          onClose={() => setChoosing(null)}
        />
      ) : null}
    </KeyboardAvoidingView>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    /** The one shared press fill (#378). */
    pressed: { backgroundColor: theme.surfacePressed },
    flex: { flex: 1, backgroundColor: theme.background },
    container: { padding: 20 },
    input: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 11,
      fontSize: 16,
      color: theme.text,
    },
    notice: {
      backgroundColor: theme.surfaceMuted,
      borderRadius: 10,
      padding: 12,
      marginTop: 12,
      gap: 6,
    },
    noticeText: { fontSize: 13, lineHeight: 19, color: theme.text },
    // Filled, and the only button on the screen. It was the outlined secondary
    // one until #320, back when the server route was the default.
    button: {
      backgroundColor: theme.accentSolid,
      borderRadius: 8,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 14,
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: theme.accentText, fontSize: 16, fontWeight: '600' },
    hint: { fontSize: 12, color: theme.textMuted, marginTop: 8, lineHeight: 17 },
    done: { fontSize: 14, color: theme.success, marginTop: 10 },
    error: { color: theme.danger, fontSize: 14, marginTop: 16 },
  })
