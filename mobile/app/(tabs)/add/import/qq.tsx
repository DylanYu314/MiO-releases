import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { useCreateExternalImport } from '../../../../src/api/playlistImports'
import { Button } from '../../../../src/components/ui/Button'
import { describeError, logWarn } from '../../../../src/diagnostics/log'
import {
  ExternalPlaylistTruncated,
  ExternalSourceRefused,
} from '../../../../src/library/externalPlaylist'
import { fetchQQPlaylist } from '../../../../src/library/qq'
import { NotAQQLink } from '../../../../src/library/qqUrl'
import { useSearchSource } from '../../../../src/library/searchSource'
import { useGuardedRouter } from '../../../../src/navigation/useGuardedRouter'
import { useThemedStyles, type Theme } from '../../../../src/theme'

/**
 * Import a QQ Music playlist (#103, ADR-013).
 *
 * The NetEase screen's twin, and deliberately so: both read a 歌单 on this
 * device and post the track list to `POST /playlist-imports/external`, so the
 * only differences are which fetcher runs and which strings are shown. What is
 * *not* shared is the wording — "歌单" and QQ's own privacy language belong to
 * this screen, and a generic "external playlist" screen would say neither well.
 *
 * Every track here is a title and an artist that still has to be *found* on
 * YouTube or Bilibili — whichever the user chose (#551) — so an import arrives
 * at `matching` and the review screen starts searching on mount. Landing there
 * is not decoration: a long 歌单 is minutes of searching, and going back to an
 * unchanged-looking form would give no sign anything had happened.
 */
export default function QQImportScreen() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  // Named rather than hardcoded, so this screen cannot repeat #557 — where the
  // NetEase screen promised YouTube to a user who had chosen Bilibili.
  const searchSource = useSearchSource((state) => state.source)
  const sourceName = t(`searchSource.${searchSource}`)
  const router = useGuardedRouter()

  const [url, setUrl] = useState('')
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const createImport = useCreateExternalImport()

  const busy = reading || createImport.isPending

  const submit = async () => {
    const trimmed = url.trim()
    if (!trimmed || busy) return

    setError(null)
    setReading(true)
    try {
      const playlist = await fetchQQPlaylist(trimmed)
      const created = await createImport.mutateAsync(playlist)
      setUrl('')
      router.replace(`/add/import/${created.id}`)
    } catch (caught) {
      logWarn('qq.import.failed', describeError(caught))
      setError(messageFor(caught, t))
    } finally {
      setReading(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.description}>{t('qq.description', { source: sourceName })}</Text>

        {/* Said before the attempt, not after it fails — the same argument as
            the NetEase screen's. MiO sends no cookies, so it can only read what
            an anonymous request can read, and the refusal that would follow is
            a QQ error code we cannot tell apart from "deleted". */}
        <Text style={styles.hint}>{t('qq.publicHint')}</Text>

        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder={t('qq.urlPlaceholder')}
          accessibilityLabel={t('qq.title')}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
        />

        {/* The way in when there is no link to copy (#564). The QQ Music app
            shares only to other Tencent apps and Kugou is mainland-only, so a
            phone user can be left with no URL at all — while all three of these
            screens have accepted a bare id since the day they were written and
            said so nowhere. */}
        <Text style={styles.hint}>{t('qq.idHint')}</Text>

        <Button
          label={t('qq.import')}
          variant="filled"
          busy={busy}
          disabled={!url.trim()}
          onPress={() => void submit()}
        />

        {/* Which of the two steps is running. A long 歌单 spends most of its
            wait in the first, and "Reading the playlist" is a very different
            thing to be waiting on than "Starting the import". */}
        {busy ? (
          <Text style={styles.hint}>{reading ? t('qq.reading') : t('qq.creating')}</Text>
        ) : null}

        {error !== null ? (
          <View accessibilityRole="alert">
            <Text style={styles.error}>{error}</Text>
          </View>
        ) : null}

        <Text style={styles.footnote}>{t('qq.audioNote', { source: sourceName })}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

/** The `t` from `useTranslation`, named so `messageFor` can take it. */
type Translate = ReturnType<typeof useTranslation>['t']

/**
 * What to tell the user, by what actually went wrong.
 *
 * `ApiError` 401 is the access-key gate (ADR-009), not a QQ problem —
 * `POST /playlist-imports*` is gated and an invited tester meets this first.
 */
function messageFor(error: unknown, t: Translate): string {
  if (error instanceof NotAQQLink) return t('qq.notALink')
  if (error instanceof ExternalPlaylistTruncated) {
    return t('qq.truncated', { expected: error.expected, received: error.received })
  }
  if (error instanceof ExternalSourceRefused) return t('qq.refused', { code: error.code })
  return describeError(error)
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    flex: { flex: 1, backgroundColor: theme.background },
    content: { padding: 16, gap: 12 },
    description: { fontSize: 14, color: theme.text },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
      color: theme.text,
      backgroundColor: theme.surface,
    },
    hint: { fontSize: 13, color: theme.textMuted },
    error: { fontSize: 13, color: theme.danger },
    footnote: { fontSize: 12, color: theme.textMuted, marginTop: 8 },
  })
