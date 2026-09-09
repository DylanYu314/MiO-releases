import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import { localLibraryKeys } from '../../../src/api/localLibrary'
import {
  importLocalFiles,
  pickLocalAudioFiles,
  type LocalImportOutcome,
  type LocalImportProgress,
} from '../../../src/library/localImport'
import { useTheme, useThemedStyles, type Theme } from '../../../src/theme'

/**
 * Add tracks the user already has on their phone (#325).
 *
 * The fourth door on the Add tab, and the only one that touches no network. The
 * mechanism is `src/library/localImport.ts`; this screen is the picker button,
 * a progress line, and an account of what happened.
 *
 * ## Why this does not use `DeviceAddList`
 *
 * The standing rule is to reuse rather than rebuild, and `DeviceAddList` (#318)
 * is the right answer for the other three doors. It is the wrong one here, and
 * the reason is what it is *for*: it exists because a network add outlives the
 * screen that started it, so the record has to be persisted, keyed by URL, and
 * marked interrupted at launch when the process was killed mid-download.
 *
 * None of that describes this. A local import is a hash and a file copy: it
 * takes seconds, it cannot be interrupted in a way that leaves a half-state —
 * each file is committed on its own, so a crash leaves exactly the tracks that
 * finished, visible in the library itself — and there is no URL to key on.
 * Feeding twenty picked files into a twenty-record store would also evict every
 * genuine add-link record the user still needed.
 *
 * So: a summary that lives as long as the screen, which is as long as the fact
 * is interesting.
 */
export default function AddLocalScreen() {
  const { t } = useTranslation()
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  const queryClient = useQueryClient()

  const [progress, setProgress] = useState<LocalImportProgress | null>(null)
  const [outcomes, setOutcomes] = useState<LocalImportOutcome[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const busy = progress !== null

  const pickAndImport = () => {
    setError(null)
    void (async () => {
      let files
      try {
        files = await pickLocalAudioFiles()
      } catch (pickError) {
        setError(pickError instanceof Error ? pickError.message : String(pickError))
        return
      }
      // Backing out of the picker is an ordinary thing to do, and clearing the
      // last run's summary to say nothing about it would be a worse answer than
      // leaving it there.
      if (files.length === 0) return

      setOutcomes(null)
      setProgress({ current: 0, total: files.length, fileName: '' })
      try {
        const result = await importLocalFiles(files, { onProgress: setProgress })
        setOutcomes(result)
        // The library reads the device (#216), so without this the tracks are
        // copied in and nothing appears until the next launch.
        await queryClient.invalidateQueries({ queryKey: localLibraryKeys.all })
      } catch (runError) {
        // `importLocalFiles` turns a file's failure into an outcome rather than
        // an exception, so reaching here means something broke around the loop
        // and not inside it. Shown rather than swallowed all the same.
        setError(runError instanceof Error ? runError.message : String(runError))
      } finally {
        setProgress(null)
      }
    })()
  }

  const added = outcomes?.filter((outcome) => outcome.status === 'added') ?? []
  const duplicates = outcomes?.filter((outcome) => outcome.status === 'duplicate') ?? []
  const failed = outcomes?.filter((outcome) => outcome.status === 'failed') ?? []

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.description}>{t('localAdd.description')}</Text>

      <Pressable
        style={({ pressed }) => [
          styles.button,
          busy && styles.buttonDisabled,
          pressed && styles.pressed,
        ]}
        disabled={busy}
        onPress={pickAndImport}
        accessibilityRole="button"
        testID="pick-local-files"
      >
        {busy ? (
          <ActivityIndicator color={theme.accentText} />
        ) : (
          <Text style={styles.buttonText}>{t('localAdd.pick')}</Text>
        )}
      </Pressable>

      <Text style={styles.hint}>{t('localAdd.copiedHint')}</Text>

      {progress ? (
        <Text style={styles.progress} accessibilityRole="progressbar">
          {t('localAdd.progress', {
            current: progress.current,
            total: progress.total,
            name: progress.fileName,
          })}
        </Text>
      ) : null}

      {outcomes ? (
        <View style={styles.summary}>
          {added.length > 0 ? (
            <Text style={styles.added}>{t('localAdd.added', { count: added.length })}</Text>
          ) : null}

          {/* Said plainly rather than counted as a failure: the user did nothing
              wrong, and "you already have this" is the whole answer. */}
          {duplicates.length > 0 ? (
            <Text style={styles.note}>
              {t('localAdd.duplicates', { count: duplicates.length })}
            </Text>
          ) : null}

          {added.length === 0 && duplicates.length === 0 && failed.length === 0 ? (
            <Text style={styles.note}>{t('localAdd.nothing')}</Text>
          ) : null}

          {/* Named one by one, because "3 failed" is not something anyone can
              act on and the filename is the only handle the user has. */}
          {failed.map((outcome) => (
            <Text key={outcome.fileName} style={styles.failed}>
              {t('localAdd.failedOne', {
                name: outcome.fileName,
                reason: outcome.error ?? t('localAdd.unknownReason'),
              })}
            </Text>
          ))}
        </View>
      ) : null}

      {error ? (
        <View accessibilityRole="alert">
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : null}
    </ScrollView>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    /** The one shared press fill (#378). */
    pressed: { backgroundColor: theme.surfacePressed },
    container: { padding: 20 },
    description: { fontSize: 14, color: theme.textMuted, lineHeight: 20 },
    button: {
      backgroundColor: theme.accentSolid,
      borderRadius: 8,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 20,
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: theme.accentText, fontSize: 16, fontWeight: '600' },
    hint: { fontSize: 12, color: theme.textMuted, marginTop: 8, lineHeight: 17 },
    progress: { fontSize: 14, color: theme.text, marginTop: 16 },
    summary: { marginTop: 16, gap: 6 },
    added: { fontSize: 14, color: theme.success },
    note: { fontSize: 14, color: theme.textMuted, lineHeight: 20 },
    failed: { fontSize: 13, color: theme.danger, lineHeight: 19 },
    error: { color: theme.danger, fontSize: 14, marginTop: 16 },
  })
