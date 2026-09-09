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
import { fetchKugouPlaylist } from '../../../../src/library/kugou'
import { NotAKugouLink } from '../../../../src/library/kugouUrl'
import { useSearchSource } from '../../../../src/library/searchSource'
import { useGuardedRouter } from '../../../../src/navigation/useGuardedRouter'
import { useThemedStyles, type Theme } from '../../../../src/theme'

/**
 * Import a Kugou playlist (#104, ADR-013).
 *
 * The NetEase and QQ screens' sibling: the 歌单 is read on this device and
 * posted to `POST /playlist-imports/external`, so the only differences are
 * which fetcher runs and which strings are shown.
 *
 * ## The one thing this screen says that the others do not
 *
 * Kugou stores the artist and the title in a single `filename` field, and the
 * split can fail. A failed split leaves the artist empty, which caps the match
 * score at 0.70 — under the 0.80 auto threshold — so the track goes to
 * **review** rather than to a wrong song. That is the correct degradation, and
 * `kugou.splitHint` says so up front, because otherwise a user sees a handful
 * of tracks needing review with no explanation and assumes MiO is failing.
 */
export default function KugouImportScreen() {
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
      const playlist = await fetchKugouPlaylist(trimmed)
      const created = await createImport.mutateAsync(playlist)
      setUrl('')
      router.replace(`/add/import/${created.id}`)
    } catch (caught) {
      logWarn('kugou.import.failed', describeError(caught))
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
        <Text style={styles.description}>{t('kugou.description', { source: sourceName })}</Text>

        {/* Said before the attempt, not after it fails — the same argument as
            the NetEase screen's. */}
        <Text style={styles.hint}>{t('kugou.publicHint')}</Text>

        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder={t('kugou.urlPlaceholder')}
          accessibilityLabel={t('kugou.title')}
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
        <Text style={styles.hint}>{t('kugou.idHint')}</Text>

        <Button
          label={t('kugou.import')}
          variant="filled"
          busy={busy}
          disabled={!url.trim()}
          onPress={() => void submit()}
        />

        {busy ? (
          <Text style={styles.hint}>{reading ? t('kugou.reading') : t('kugou.creating')}</Text>
        ) : null}

        {error !== null ? (
          <View accessibilityRole="alert">
            <Text style={styles.error}>{error}</Text>
          </View>
        ) : null}

        {/* Why some tracks will need review. Without this the degradation looks
            like a fault rather than the deliberate choice it is. */}
        <Text style={styles.hint}>{t('kugou.splitHint')}</Text>

        <Text style={styles.footnote}>{t('kugou.audioNote', { source: sourceName })}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

/** The `t` from `useTranslation`, named so `messageFor` can take it. */
type Translate = ReturnType<typeof useTranslation>['t']

/**
 * What to tell the user, by what actually went wrong.
 *
 * `ApiError` 401 is the access-key gate (ADR-009), not a Kugou problem —
 * `POST /playlist-imports*` is gated and an invited tester meets this first.
 */
function messageFor(error: unknown, t: Translate): string {
  if (error instanceof NotAKugouLink) return t('kugou.notALink')
  if (error instanceof ExternalPlaylistTruncated) {
    return t('kugou.truncated', { expected: error.expected, received: error.received })
  }
  if (error instanceof ExternalSourceRefused) return t('kugou.refused', { code: error.code })
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
