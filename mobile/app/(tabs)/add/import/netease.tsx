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
import { fetchNeteasePlaylist } from '../../../../src/library/netease'
import { NotANeteaseLink } from '../../../../src/library/neteaseUrl'
import { useGuardedRouter } from '../../../../src/navigation/useGuardedRouter'
import { useSearchSource } from '../../../../src/library/searchSource'
import { useThemedStyles, type Theme } from '../../../../src/theme'

/**
 * Import a NetEase Cloud Music playlist (#102, ADR-013).
 *
 * ## Two steps, and only the second one is the server's
 *
 * The playlist is read **on this device** — two plain HTTP requests, no account
 * — and then posted to `POST /playlist-imports/external`. Whether the droplet
 * could read NetEase is unmeasured and does not need to be: the connection that
 * should reach a user's music service is the user's own (ADR-013 decision 2).
 *
 * Landing on the review screen is not optional decoration. Every track here is
 * a title and an artist that still has to be *found* on YouTube or Bilibili
 * — whichever the user chose (#551) — so an import
 * arrives at `matching` and the review screen starts searching on mount. A
 * hundred-track playlist is minutes of that; going back to an unchanged-looking
 * form would give no sign anything had happened.
 *
 * ## Why the two failures are named separately
 *
 * "This is not a NetEase playlist link" and "NetEase refused the request" ask
 * for opposite actions — fix the text, or try again later. Collapsing them into
 * one message is the trap #492 fell into, where a login that had *succeeded*
 * was reported as an expired code.
 */
export default function NeteaseImportScreen() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  /*
   * Which site this screen should name (#557).
   *
   * It used to say "YouTube" twice, flatly. #551 made that a choice, so for the
   * user the toggle exists for — someone in mainland China, who has selected
   * Bilibili — both sentences were simply false, on the one screen that
   * promises where the audio comes from.
   */
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
      const playlist = await fetchNeteasePlaylist(trimmed)
      const created = await createImport.mutateAsync(playlist)
      setUrl('')
      router.replace(`/add/import/${created.id}`)
    } catch (caught) {
      logWarn('netease.import.failed', describeError(caught))
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
        <Text style={styles.description}>{t('netease.description', { source: sourceName })}</Text>

        {/* Said before the attempt, not after it fails.
         *
         * MiO sends no cookies and no login, so it can only read what an
         * anonymous request can read — and a private 歌单 is the one shape a
         * user is most likely to try first, because 我喜欢的音乐 is private by
         * default. The refusal that would follow is a NetEase error code we
         * cannot tell apart from "deleted", so the honest place to spend the
         * words is here. Same argument as `youtubeImport.privateHint`. */}
        <Text style={styles.hint}>{t('netease.publicHint')}</Text>

        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder={t('netease.urlPlaceholder')}
          accessibilityLabel={t('netease.title')}
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
        <Text style={styles.hint}>{t('netease.idHint')}</Text>

        <Button
          label={t('netease.import')}
          variant="filled"
          busy={busy}
          disabled={!url.trim()}
          onPress={() => void submit()}
        />

        {/* Which of the two steps is running. A hundred-track playlist spends
            most of its wait in the first, and "Reading the playlist" is a very
            different thing to be waiting on than "Starting the import". */}
        {busy ? (
          <Text style={styles.hint}>{reading ? t('netease.reading') : t('netease.creating')}</Text>
        ) : null}

        {error !== null ? (
          <View accessibilityRole="alert">
            <Text style={styles.error}>{error}</Text>
          </View>
        ) : null}

        <Text style={styles.footnote}>{t('netease.audioNote', { source: sourceName })}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

/** The `t` from `useTranslation`, named so `messageFor` can take it. */
type Translate = ReturnType<typeof useTranslation>['t']

/**
 * What to tell the user, by what actually went wrong.
 *
 * `ApiError` 401 is the access-key gate (ADR-009), not a NetEase problem —
 * `POST /playlist-imports*` is gated and an invited tester meets this first.
 */
function messageFor(error: unknown, t: Translate): string {
  if (error instanceof NotANeteaseLink) return t('netease.notALink')
  if (error instanceof ExternalPlaylistTruncated) {
    return t('netease.truncated', { expected: error.expected, received: error.received })
  }
  if (error instanceof ExternalSourceRefused) return t('netease.refused', { code: error.code })
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
