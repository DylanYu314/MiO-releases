import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Updates from 'expo-updates'
import {
  Clipboard,
  FlatList,
  Linking,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { deviceContext } from '../src/api/clientErrors'
import { useConnection } from '../src/api/connection'
import { getInstallId } from '../src/api/installId'
import { useDiagnostics, type LogEntry, type LogLevel } from '../src/diagnostics/log'
import { buildReport, collectContext, REPORT_FORM_URL } from '../src/diagnostics/report'
import { probeRangeSupport } from '../src/library/rangeProbe'
import { Button } from '../src/components/ui/Button'
import { useGuardedRouter } from '../src/navigation/useGuardedRouter'
import { useTheme, useThemedStyles, type Theme } from '../src/theme'
import { Chip } from '../src/components/ui/Chip'

/**
 * What the app has been doing, on the phone that did it (#322).
 *
 * ## Why this exists when the web reader also does
 *
 * The web page is where a log is actually *read* — a laptop, a big screen, a
 * month of history. This is for the moment before that: a tester in the field
 * who has just seen something go wrong and wants to send it now rather than
 * wait for tomorrow's handshake, and to be able to say "it did say something"
 * rather than "I think it broke".
 *
 * So it is deliberately thin. Newest first, one line each, a level filter and a
 * send button. Anything more belongs on the page with room for it.
 */

/** The first eight characters of the install id — enough to name this device in
 *  a message without asking anyone to read out sixty-four hex characters. */
function installShortId(): string {
  return getInstallId().slice(0, 8) || '—'
}

/** Newest first: the thing you came here to see is the thing that just went by. */
function newestFirst(entries: LogEntry[]): LogEntry[] {
  return [...entries].reverse()
}

const FILTERS: (LogLevel | 'all')[] = ['all', 'error', 'warn', 'info']

export default function DiagnosticsScreen() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const serverUrl = useConnection((state) => state.serverUrl)
  // `useGuardedRouter`, never `useRouter` — expo-router flushes a queue, so two
  // presses open two screens (#375).
  const router = useGuardedRouter()
  const entries = useDiagnostics((state) => state.entries)
  const clear = useDiagnostics((state) => state.clear)
  const [filter, setFilter] = useState<LogLevel | 'all'>('all')
  const [probeUrl, setProbeUrl] = useState('')
  const [probing, setProbing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const shown = newestFirst(filter === 'all' ? entries : entries.filter((e) => e.level === filter))

  /*
   * The report is built the same way for both buttons, so what a user copies
   * and what they share can never differ (#664).
   */
  const report = () => buildReport(newestFirst(entries), collectContext())

  const copyReport = () => {
    setNotice(null)
    try {
      /*
       * ⚠️ React Native's core `Clipboard` is deprecated — it warns that it
       * "has been extracted from react-native core and will be removed in a
       * future release" — and it is used anyway, deliberately.
       *
       * `expo-clipboard` is the replacement and is **not installed**, so adding
       * it would pull in a new native module: that moves the fingerprint, forces
       * a build, and blocks every pending JavaScript update behind it
       * (`docs/native-rebuild.md`). This screen exists for the day the app is
       * broken, and making it reachable only after a 35-minute build is the
       * wrong trade.
       *
       * ✅ Verified present in the shipped binary before relying on it:
       * `ClipboardModule` appears in v1.0.0's dex. Swap to `expo-clipboard` at
       * the next native build, where it is free.
       */
      Clipboard.setString(report())
      setNotice(t('diagnostics.copied'))
    } catch {
      // Whatever the clipboard did, the share button is still there.
      setNotice(t('diagnostics.copyFailed'))
    }
  }

  const shareReport = async () => {
    setNotice(null)
    try {
      await Share.share({ message: report() })
    } catch {
      // Dismissing the share sheet rejects on some Android versions, which is
      // not a failure and must not be reported as one.
    }
  }

  const HEADER = (
    <>
      <Text style={styles.description}>{t('diagnostics.description')}</Text>

      {/*
        Who this device is, shown to its own user (#354).

        Every report is stored against this install, and a bug report that says
        "it broke on my phone" is far easier to find in a list of several
        testers when it can say *which* install. Short-form because it is meant
        to be read out or typed into a message, not copied exactly — and it is
        an identifier, not a secret: the token itself lives in SecureStore and
        is never shown.
      */}
      <Text style={styles.identity} selectable>
        {t('diagnostics.thisDevice', {
          id: installShortId(),
          device: deviceContext().device ?? '—',
        })}
      </Text>

      {/*
        Which server this app is talking to (#374).

        It used to be printed in Settings, where an ordinary tester had no use
        for it and every reason to fidget with it. It belongs here instead: "the
        server is wrong" is a bug report, and this is the screen for the moment
        a bug has just happened. `selectable`, because the point of showing it
        is being able to put it in a message.
      */}
      <Text style={styles.identity} selectable>
        {/* ⚠️ Since #613 the shipped default is **no** server, so falling back
            to `DEFAULT_SERVER_URL` would print `Server: ` and leave the one
            question this line exists to answer unanswerable. */}
        {serverUrl ? t('diagnostics.thisServer', { url: serverUrl }) : t('diagnostics.noServer')}
      </Text>

      {/*
        Moved off Settings, where it had no business being.

        ⛔ #721 removed the access-key field from Settings because "a credential
        field for a server you do not have is worse than no field" — and left
        the button that opens `/setup`, which asks for exactly that key, on the
        same screen. A normal user tapped *Change server* and was asked to
        connect to something that does not exist.

        The app ships with no server and needs none (#613, ADR-020), so this is
        a self-hoster's control and belongs on the screen a self-hoster already
        reads. Nothing about self-hosting changes: `/setup` is still the only
        door to a custom address, and it is still one tap from here.
      */}
      <Button label={t('setup.change')} variant="plain" onPress={() => router.push('/setup')} />

      {/*
        Which bundle is actually running (#412).

        Over-the-air updates make "did my fix land?" a real question with a
        non-obvious answer: an update is downloaded on one launch and applied on
        the **next**, so the honest way to check is to look rather than to
        assume. The runtime version is the native side's fingerprint — when it
        changes, no update can apply and a build is genuinely needed — and the
        update id is the JavaScript bundle in hand. `embedded` means the one that
        shipped inside the APK.
      */}
      <Text style={styles.identity} selectable>
        {t('diagnostics.thisBuild', {
          runtime: Updates.runtimeVersion ?? '—',
          update: Updates.isEmbeddedLaunch ? 'embedded' : (Updates.updateId?.slice(0, 8) ?? '—'),
        })}
      </Text>

      <View style={styles.chips}>
        {FILTERS.map((option) => (
          <Chip
            key={option}
            label={t(`diagnostics.level.${option}`)}
            selected={filter === option}
            onPress={() => setFilter(option)}
          />
        ))}
      </View>

      {/*
        The range probe (#442), and it is deliberately here rather than on a
        screen a user would find.

        Three decisions wait on one unmeasured fact: whether a **freshly
        extracted** URL will serve `Range: bytes=N-`. #246 established only that
        a *second* request on the *same* URL is refused, which is a narrower
        claim than it is usually quoted as — and pause-and-resume, chunked
        downloads and the memory ceiling for hour-long tracks all turn on the
        wider one.

        It has to run from the phone: a stream URL is tied to the address that
        asked for it, so measuring from a laptop measures the wrong network,
        which is the whole history of #177.
      */}
      <Text style={styles.identity}>{t('diagnostics.rangeProbeHint')}</Text>
      <View style={styles.buttonRow}>
        <TextInput
          value={probeUrl}
          onChangeText={setProbeUrl}
          placeholder="https://www.youtube.com/watch?v=…"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.probeInput}
          accessibilityLabel={t('diagnostics.rangeProbe')}
        />
      </View>
      <View style={styles.buttonRow}>
        <Button
          label={probing ? t('diagnostics.rangeProbeRunning') : t('diagnostics.rangeProbe')}
          variant="outlined"
          disabled={probing || probeUrl.trim().length === 0}
          onPress={() => {
            setProbing(true)
            void probeRangeSupport(probeUrl.trim()).finally(() => setProbing(false))
          }}
        />
      </View>

      <View style={styles.buttonRow}>
        {/*
          Was "Send now", which since #613 could only fail — `uploadLog()`
          answers `no-server` for every ordinary user (#664). The app prepares
          the report; the user sends it.
        */}
        <Pressable
          onPress={copyReport}
          disabled={entries.length === 0}
          accessibilityRole="button"
          accessibilityState={{ disabled: entries.length === 0 }}
          testID="copy-report"
          style={({ pressed }) => [
            styles.button,
            entries.length === 0 && styles.buttonDisabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.buttonText}>{t('diagnostics.copyReport')}</Text>
        </Pressable>
        <Pressable
          onPress={() => void shareReport()}
          disabled={entries.length === 0}
          accessibilityRole="button"
          accessibilityState={{ disabled: entries.length === 0 }}
          testID="share-report"
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryText}>{t('diagnostics.shareReport')}</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            clear()
            setNotice(null)
          }}
          disabled={entries.length === 0}
          accessibilityRole="button"
          accessibilityState={{ disabled: entries.length === 0 }}
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryText}>{t('common.clear')}</Text>
        </Pressable>
      </View>

      {notice ? (
        <Text style={styles.notice} accessibilityLiveRegion="polite">
          {notice}
        </Text>
      ) : null}

      {/*
        Where the report goes (#664). Rendered only when a destination exists —
        a button that opens nothing is the dead UI this issue removed, not a
        smaller version of the feature.
      */}
      {REPORT_FORM_URL ? (
        <Text
          style={styles.reportLink}
          accessibilityRole="link"
          testID="report-form-link"
          onPress={() => void Linking.openURL(REPORT_FORM_URL)}
        >
          {t('diagnostics.reportProblem')}
        </Text>
      ) : null}
    </>
  )

  /*
   * ⛔ Everything above the log is the list's **header**, not a sibling of it.
   *
   * It used to be six fixed-height blocks and then the `FlatList`, all inside a
   * plain `View`. The list therefore got only the strip left over at the bottom
   * — a few rows — and the header could never scroll away, so the log was
   * unreadable however far you scrolled. Reported from a device, and it is what
   * made a real Bilibili failure impossible to diagnose from the app.
   *
   * ⚠️ Passed as an **element**, not a component. A function here is a new
   * component type on every render, which remounts the header and takes the
   * focus out of the probe's text input on the first keystroke.
   */
  return (
    <FlatList
      style={styles.flex}
      data={shown}
      keyExtractor={(entry) => entry.key}
      contentContainerStyle={styles.list}
      ListHeaderComponent={<View>{HEADER}</View>}
      ListEmptyComponent={<Text style={styles.empty}>{t('diagnostics.empty')}</Text>}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.rowHead}>
            <Text style={[styles.level, { color: levelColour(item.level, theme) }]}>
              {item.level}
            </Text>
            <Text style={styles.time}>{new Date(item.at).toLocaleTimeString()}</Text>
          </View>
          <Text style={styles.event}>{item.event}</Text>
          {item.detail ? <Text style={styles.detail}>{item.detail}</Text> : null}
        </View>
      )}
    />
  )
}

/** Semantic names only — no screen hardcodes a colour (#227). */
function levelColour(level: LogLevel, theme: Theme): string {
  if (level === 'error') return theme.danger
  if (level === 'warn') return theme.accentOnSurface
  return theme.textMuted
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    /** The one shared press fill (#378). */
    pressed: { backgroundColor: theme.surfacePressed },
    /*
     * ⚠️ No padding here any more. This is the `FlatList`'s outer style now, and
     * padding there insets the scrolling viewport rather than the content — the
     * scrollbar ends up floating inside the inset. The padding moved to
     * `contentContainerStyle`, which is what scrolls.
     */
    flex: { flex: 1, backgroundColor: theme.background },
    description: { fontSize: 13, color: theme.textMuted, lineHeight: 18 },
    identity: {
      fontSize: 12,
      color: theme.textMuted,
      marginTop: 10,
      fontFamily: Platform.OS === 'android' ? 'monospace' : undefined,
    },
    chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 14 },
    buttonRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
    probeInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: theme.text,
      fontSize: 13,
    },
    button: {
      backgroundColor: theme.accentSolid,
      borderRadius: 8,
      paddingVertical: 12,
      paddingHorizontal: 22,
      alignItems: 'center',
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: theme.accentText, fontSize: 15, fontWeight: '600' },
    secondaryButton: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingVertical: 12,
      paddingHorizontal: 18,
      alignItems: 'center',
    },
    secondaryText: { fontSize: 15, color: theme.text },
    reportLink: {
      color: theme.accentOnSurface,
      fontSize: 14,
      marginTop: 12,
      textDecorationLine: 'underline',
    },
    notice: { fontSize: 13, color: theme.accentOnSurface, marginTop: 12 },
    list: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 40 },
    empty: { fontSize: 14, color: theme.textMuted, textAlign: 'center', marginTop: 32 },
    row: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      paddingVertical: 10,
    },
    rowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    level: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
    time: { fontSize: 11, color: theme.textMuted },
    event: { fontSize: 14, fontWeight: '600', color: theme.text, marginTop: 2 },
    detail: {
      fontSize: 12,
      color: theme.textMuted,
      marginTop: 2,
      fontFamily: Platform.OS === 'android' ? 'monospace' : undefined,
    },
  })
