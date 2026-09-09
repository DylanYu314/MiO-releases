import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'

import {
  MACHINE_TRANSLATED,
  SUPPORTED_LANGUAGES,
  setLanguage,
  type LanguageCode,
} from '../../src/i18n'
import { EqualizerPanel } from '../../src/components/EqualizerPanel'
import { DonateCard } from '../../src/components/DonateCard'
import { PRIVACY_URL } from '../../src/legal'
import { localLibraryKeys } from '../../src/api/localLibrary'
import { exportLibrary } from '../../src/library/libraryExport'
import { useListImportProgress } from '../../src/api/listImportProgress'
import {
  LibraryImportError,
  libraryImportKey,
  pickLibraryFile,
  runLibraryImport,
  summarise,
} from '../../src/library/libraryImport'
import type { LibraryExport } from '../../src/library/libraryExport'
import { showToast } from '../../src/components/Toast'
import { logWarn } from '../../src/diagnostics/log'
import { useOnboarding } from '../../src/onboarding/store'
import { useAudioSettings } from '../../src/player/audioSettings'
import { CROSSFADE_MAX_SECONDS, usePlayer } from '../../src/player/store'

import { Button } from '../../src/components/ui/Button'
import { Chip } from '../../src/components/ui/Chip'
import { SearchSourcePicker } from '../../src/components/SearchSourcePicker'
import { useAppUpdates, type CheckOutcome } from '../../src/updates/useAppUpdates'
import { useGuardedRouter } from '../../src/navigation/useGuardedRouter'
import { useNotificationPermission } from '../../src/system/notifications'
import {
  ACCENT_PRESETS,
  useTheme,
  useThemedStyles,
  useThemeStore,
  type AccentName,
  type Theme,
  type ThemeMode,
} from '../../src/theme'

/** Off, then a short, a middling and the store's maximum. Four steps rather
 *  than a slider: the difference between 7 and 8 seconds is not a decision
 *  anyone is trying to make, and a slider is a native module for the privilege. */
const CROSSFADE_CHOICES = [0, 3, 6, CROSSFADE_MAX_SECONDS] as const

/** The same three-way choice the web offers, in the same order (ADR-007). */
const MODES: ThemeMode[] = ['system', 'light', 'dark']

/**
 * Settings.
 *
 * Two kinds of thing live here, and the order says which matters more.
 *
 * **Appearance** arrived with #227. Until then mobile had no theme layer at all
 * — every screen imported the default accent at module scope and hardcoded its
 * own greys — so there was nothing for a picker to pick. The mechanism differs
 * from the web's (React Native has no cascade, so the palette is threaded
 * through a hook rather than set as CSS custom properties) but the choices are
 * identical, because they read the same `shared/tokens.ts`.
 *
 * **There is no access-key field here any more (#721).** There used to be one,
 * above appearance, on the reasoning that the key decided whether you could
 * search or import at all. That stopped being true: #613 ships the app with no
 * server (`expo.extra.serverUrl` is `""`), #637 deleted the one screen that
 * handed a link to one, and #614 put `POST /jobs` behind a key on a server the
 * user runs themselves. So the key gates nothing a normal install can reach,
 * and a credential field for a server you do not have is worse than no field.
 *
 * **The server row survives, at the bottom, as a self-hosting control.** The
 * connection store is still live — diagnostics upload, error reporting and the
 * handover path all read it — and `/setup` is the only door to a custom
 * address. It is last because almost nobody needs it.
 */
export default function SettingsScreen() {
  const { t, i18n } = useTranslation()
  const router = useGuardedRouter()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const notifications = useNotificationPermission()
  const normalizeLoudness = useAudioSettings((state) => state.normalizeLoudness)
  const crossfadeSeconds = usePlayer((state) => state.crossfadeSeconds)
  const setCrossfadeSeconds = usePlayer((state) => state.setCrossfadeSeconds)
  const setNormalizeLoudness = useAudioSettings((state) => state.setNormalizeLoudness)
  const mode = useThemeStore((state) => state.mode)
  const accentName = useThemeStore((state) => state.accent)
  const setMode = useThemeStore((state) => state.setMode)
  const setAccent = useThemeStore((state) => state.setAccent)
  const replayTour = useOnboarding((state) => state.reset)

  const updates = useAppUpdates()
  const [checkResult, setCheckResult] = useState<CheckOutcome | null>(null)
  // Guards the button while the picker and the write are in flight, so a
  // second tap cannot start a second export over the first.
  const queryClient = useQueryClient()
  const [exporting, setExporting] = useState(false)
  /*
   * What the last export did, kept on screen.
   *
   * ⚠️ A toast lasts 2200 ms (`Toast.tsx`) and the skipped-files message is two
   * sentences carrying a count and a reason. Reported from a device: the export
   * worked, said something had been left out, and was gone before it could be
   * read — the toast was announcing information it had no time to deliver.
   *
   * The toast stays: it is the app's confirmation mechanism and it is right for
   * "it worked". This line is for the half that has to be *read*.
   */
  const [exportResult, setExportResult] = useState<string | null>(null)
  /*
   * A file that has been read and understood, waiting for the user to agree to
   * the download.
   *
   * ⚠️ Two steps on purpose. Reading is cheap and reversible; downloading is an
   * hour and a lot of data. An accidental tap on a picker should not commit
   * someone to that, and they should see what is in the file first.
   */
  const [pending, setPending] = useState<LibraryExport | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)
  /*
   * Which run to watch, kept after `pending` is cleared.
   *
   * ⚠️ Read from the store rather than held here, for the reason ADR-019 gives
   * and `add/import/bilibili.tsx` follows: the run outlives this screen, so
   * leaving Settings and coming back has to show the run in progress rather
   * than an idle button.
   */
  const [runKey, setRunKey] = useState<string | null>(null)
  const progress = useListImportProgress((state) => (runKey ? state.runs[runKey] : undefined))

  const pickLanguage = async (code: LanguageCode) => {
    await setLanguage(code)
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.section}>{t('settings.appearance')}</Text>
      <Text style={styles.description}>{t('settings.theme')}</Text>
      <View style={styles.chips}>
        {MODES.map((option) => (
          <Chip
            key={option}
            label={t(`settings.mode.${option}`)}
            selected={mode === option}
            onPress={() => void setMode(option)}
          />
        ))}
      </View>

      <Text style={[styles.description, styles.spaced]}>{t('settings.accent')}</Text>
      <View style={styles.swatches}>
        {/* Swatches rather than named chips: the thing being chosen *is* a
              colour, and six colour names in two languages is six strings that
              say less than the colour itself. The label stays on the
              accessibility node, where a screen reader needs it. */}
        {(Object.keys(ACCENT_PRESETS) as AccentName[]).map((name) => (
          <Pressable
            key={name}
            onPress={() => void setAccent(name)}
            accessibilityRole="button"
            accessibilityLabel={ACCENT_PRESETS[name].label}
            accessibilityState={{ selected: accentName === name }}
            // 40 dp of circle, 48 dp of target. Unlike the chips beside it a
            // swatch can take `hitSlop`: `styles.swatches` sets `gap: 12`, so
            // 4 dp a side lands exactly on the neighbour's edge without
            // crossing it, and the circle keeps the size the design wants
            // (#519, measured at 40x40 on a device).
            hitSlop={4}
            // Still bespoke: a swatch *is* a colour, so it cannot take the
            // Chip's fill without hiding the thing being chosen. It shrinks
            // under a finger instead — feedback that costs it no colour.
            style={({ pressed }) => [
              styles.swatch,
              { backgroundColor: ACCENT_PRESETS[name].ramp[5] },
              accentName === name && { borderColor: theme.text, borderWidth: 3 },
              pressed && styles.swatchPressed,
            ]}
          />
        ))}
      </View>

      <Text style={styles.section}>{t('settings.language')}</Text>
      <View style={styles.chips}>
        {SUPPORTED_LANGUAGES.map(({ code, label }) => (
          <Chip
            key={code}
            label={label}
            selected={i18n.language === code}
            onPress={() => void pickLanguage(code)}
          />
        ))}
      </View>
      {/* Shown only for a catalogue nobody who speaks it has read (#519).
            Under the picker rather than beside the chip, so it describes the
            language in use rather than decorating one option. */}
      {MACHINE_TRANSLATED.has(i18n.language) ? (
        <Text style={styles.description}>{t('settings.machineTranslated')}</Text>
      ) : null}

      {/* Beside language rather than under playback: for a user in mainland
            China this is not a preference about audio, it is whether searching
            works at all (#551). */}
      <Text style={styles.section}>{t('searchSource.title')}</Text>
      <SearchSourcePicker full />

      <Text style={styles.section}>{t('settings.playback')}</Text>
      <View style={styles.switchRow}>
        <View style={styles.switchLabel}>
          <Text style={styles.switchTitle}>{t('settings.normalizeLoudness')}</Text>
          <Text style={styles.description}>{t('settings.normalizeLoudnessHint')}</Text>
        </View>
        <Switch
          value={normalizeLoudness}
          onValueChange={(next) => void setNormalizeLoudness(next)}
          accessibilityLabel={t('settings.normalizeLoudness')}
          trackColor={{ false: theme.border, true: theme.accent[4] }}
          thumbColor={normalizeLoudness ? theme.accentSolid : theme.surfaceMuted}
        />
      </View>

      {/*
          Crossfade (#201), as chips rather than a slider.

          A slider needs a native module here and would offer a precision
          nobody wants — the difference between 7 and 8 seconds is not a
          decision anyone is trying to make. Four choices and Off cover it, and
          chips match the rest of this screen.
        */}
      <View style={styles.switchLabel}>
        <Text style={styles.switchTitle}>{t('playback.crossfade')}</Text>
        <Text style={styles.description}>{t('playback.crossfadeDescription')}</Text>
      </View>
      <View style={styles.chips}>
        {CROSSFADE_CHOICES.map((seconds) => (
          <Chip
            key={seconds}
            label={
              seconds === 0
                ? t('playback.crossfadeOff')
                : t('playback.crossfadeSeconds', { count: seconds })
            }
            selected={crossfadeSeconds === seconds}
            onPress={() => setCrossfadeSeconds(seconds)}
          />
        ))}
      </View>

      <EqualizerPanel />

      {/*
          Only when it is actually denied (#472).

          Android shows the permission dialog at most twice per install, so
          `requestNotificationPermission` cannot get the user back once they have
          said no — the system settings screen is the only route, and without a
          door to it the lock screen is lost for the life of the install. Hidden
          when granted, and while the first read is still pending (`null`), so
          nobody is warned about a state they are not in.
        */}
      {notifications === 'denied' && (
        <>
          <Text style={styles.section}>{t('settings.notifications')}</Text>
          <Text style={styles.description}>{t('settings.notificationsDenied')}</Text>
          <Button
            label={t('settings.openSystemSettings')}
            variant="plain"
            onPress={() => void Linking.openSettings()}
          />
        </>
      )}

      {/* Before the tour and diagnostics: "am I running the current MiO?" is
            the question someone asks when the app is misbehaving, and the two
            below are what they reach for next (#665). */}
      <Text style={styles.section}>{t('updates.title')}</Text>
      <Text style={styles.description}>
        {updates.currentVersion === null
          ? '—'
          : t('updates.current', { version: updates.currentVersion })}
      </Text>
      {/* Only `upToDate` and `unreachable` are worth a sentence here. When
            something *was* found the banner says so, and repeating it would be
            two components describing one fact. */}
      {checkResult === 'upToDate' && (
        <Text style={styles.description}>{t('updates.upToDate')}</Text>
      )}
      {checkResult === 'unreachable' && (
        <Text style={styles.description}>{t('updates.offline')}</Text>
      )}
      <Button
        label={updates.checking ? t('updates.checking') : t('updates.check')}
        variant="plain"
        disabled={updates.checking}
        onPress={() => {
          setCheckResult(null)
          void updates.checkNow().then(setCheckResult)
        }}
      />

      <Text style={styles.section}>{t('settings.tour')}</Text>
      <Text style={styles.description}>{t('settings.tourDescription')}</Text>
      <Button label={t('settings.showTour')} variant="plain" onPress={replayTour} />

      {/* #729. A copy, never a sync — the name is the mechanism. Nothing
            propagates afterwards, and that cannot be fixed without cloud
            storage MiO does not have, so the wording promises a one-time copy
            and the description says so plainly rather than warning about it
            later. */}
      <Text style={styles.section}>{t('settings.copyLibrary')}</Text>
      <Text style={styles.description}>{t('settings.copyLibraryDescription')}</Text>
      <Button
        label={t('settings.exportLibrary')}
        variant="plain"
        disabled={exporting}
        onPress={() => {
          setExporting(true)
          exportLibrary()
            .then(({ songCount, skippedLocal }) => {
              const songs = t('library.songCount', { count: songCount })
              const message =
                skippedLocal > 0
                  ? t('settings.libraryCopiedSkipped', {
                      songs,
                      skipped: t('library.songCount', { count: skippedLocal }),
                    })
                  : t('settings.libraryCopied', { songs })
              showToast(message)
              setExportResult(message)
            })
            .catch((error: unknown) => {
              // Cancelling the folder picker rejects, and a cancel is not a
              // failure — but it is indistinguishable here, so the message says
              // what did not happen rather than blaming anything.
              logWarn('libraryExport.failed', String(error))
              showToast(t('settings.exportFailed'))
              // Cleared rather than left showing a stale success: a failed
              // export must not be read as the previous one's result.
              setExportResult(null)
            })
            .finally(() => setExporting(false))
        }}
      />
      {exportResult ? <Text style={styles.description}>{exportResult}</Text> : null}

      <Button
        label={t('settings.importLibrary')}
        variant="plain"
        disabled={importing}
        onPress={() => {
          setImportResult(null)
          pickLibraryFile()
            // `null` is a cancelled picker, which leaves the screen as it was.
            .then((document) => {
              if (document) setPending(document)
            })
            .catch((error: unknown) => {
              /*
               * ⛔ Named reasons, not one message. "Could not read the copy" for
               * a file from a newer MiO would send someone looking for a
               * corrupted file instead of an app update — and the parser went
               * to the trouble of distinguishing them.
               */
              if (error instanceof LibraryImportError) {
                const reason = error.rejection.reason
                setImportResult(
                  t(
                    reason === 'too-new'
                      ? 'settings.importTooNew'
                      : reason === 'empty'
                        ? 'settings.importEmpty'
                        : 'settings.importNotALibrary',
                  ),
                )
                return
              }
              /*
               * ⛔ Said out loud, not swallowed.
               *
               * This used to assume anything reaching here was a cancelled
               * picker and stayed silent — so when `pickFileAsync`'s result
               * shape turned out to be `{ result, canceled }` rather than a
               * `File`, the TypeError vanished and choosing a file did visibly
               * nothing. A cancel is `null` now, so everything here is real.
               */
              logWarn('libraryImport.pickFailed', String(error))
              setImportResult(t('settings.importFailed'))
            })
        }}
      />
      {pending ? (
        <>
          <Text style={styles.description}>
            {t('settings.importLibraryConfirm', {
              songs: t('library.songCount', { count: summarise(pending).songCount }),
              date: summarise(pending).exportedAt.slice(0, 10),
            })}
          </Text>
          <Button
            label={t('settings.importLibraryStart')}
            variant="filled"
            disabled={importing}
            onPress={() => {
              const document = pending
              setPending(null)
              setRunKey(libraryImportKey(document))
              setImporting(true)
              runLibraryImport(document, () => {
                void queryClient.invalidateQueries({ queryKey: localLibraryKeys.all })
              })
                .then(({ songsArrived }) => {
                  setImportResult(
                    t('settings.importLibraryDone', {
                      songs: t('library.songCount', { count: songsArrived }),
                    }),
                  )
                })
                .catch((error: unknown) => {
                  logWarn('libraryImport.failed', String(error))
                  setImportResult(t('settings.importFailed'))
                })
                .finally(() => setImporting(false))
            }}
          />
        </>
      ) : null}
      {progress ? (
        <Text style={styles.description}>
          {t('settings.importProgress', {
            done: progress.done,
            total: progress.total,
            saved: progress.saved,
            failed: progress.failed,
          })}
          {progress.alreadyHere > 0
            ? ` ${t('settings.importAlreadyHere', { count: progress.alreadyHere })}`
            : ''}
        </Text>
      ) : null}
      {importResult ? <Text style={styles.description}>{importResult}</Text> : null}

      {/* #513. A link, not a screen: the policy has to be readable by someone
            deciding whether to install MiO at all, so the web page is canonical
            and a second in-app copy could only drift from it. */}
      <Text style={styles.section}>{t('settings.privacy')}</Text>
      <Text style={styles.description}>{t('settings.privacyDescription')}</Text>
      <Button
        label={t('settings.openPrivacyPolicy')}
        variant="plain"
        onPress={() => {
          // Never `void` alone — an Android with no browser at all throws
          // here, and a dead button that says nothing is worse than one that
          // admits it. Same reasoning as DonateCard.
          Linking.openURL(PRIVACY_URL).catch((error: unknown) => {
            logWarn('privacy.openFailed', String(error))
            showToast(t('settings.linkFailed'))
          })
        }}
      />

      {/* Last on the screen on purpose: it is for the session where something
            has gone wrong, not part of setting the app up (#322). */}
      <Text style={styles.section}>{t('diagnostics.title')}</Text>
      <Text style={styles.description}>{t('diagnostics.settingsHint')}</Text>
      <Button
        label={t('diagnostics.open')}
        variant="plain"
        onPress={() => router.push('/diagnostics')}
      />

      {/* Last, and with the full explanation rather than the player screen's
            short one. Someone who has scrolled to the bottom of Settings has
            gone looking; the compact card is for someone who has not (#517). */}
      <DonateCard />
    </ScrollView>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { padding: 20, paddingBottom: 40, backgroundColor: theme.background, flexGrow: 1 },
    section: {
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      color: theme.textMuted,
      marginTop: 24,
      marginBottom: 6,
    },
    description: { fontSize: 13, color: theme.textMuted, lineHeight: 18 },
    spaced: { marginTop: 16 },
    switchRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
    // The label takes the slack so a two-line hint wraps instead of squeezing the
    // switch, which has a fixed intrinsic width.
    switchLabel: { flex: 1 },
    switchTitle: { fontSize: 15, fontWeight: '600', marginBottom: 2, color: theme.text },
    chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
    swatches: { flexDirection: 'row', gap: 12, flexWrap: 'wrap', marginTop: 10 },
    swatch: {
      width: 40,
      height: 40,
      borderRadius: 999,
      // A transparent border always present, so selecting one does not resize it
      // and shuffle the row.
      borderWidth: 3,
      borderColor: 'transparent',
    },
    swatchPressed: { transform: [{ scale: 0.9 }] },
  })
