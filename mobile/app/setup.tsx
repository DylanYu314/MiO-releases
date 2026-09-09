import { useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
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
} from 'react-native'

import { checkConnection, type ConnectionResult } from '../src/api/connectionCheck'
import { DEFAULT_SERVER_URL, useConnection } from '../src/api/connection'
import { useTheme, useThemedStyles, type Theme } from '../src/theme'
import { useGuardedRouter } from '../src/navigation/useGuardedRouter'
import { Button } from '../src/components/ui/Button'

/**
 * The invite screen (P10d).
 *
 * It used to ask for a server address first, because before the backend was
 * hosted there was no address anyone could have known. Now that one ships with
 * the app, the only thing a pilot tester has that the app does not is **their
 * key** — so that is the only thing on screen.
 *
 * The address survives behind "Advanced", because self-hosting is a real use
 * and `docs/history/phase-5.md` always described the manual field as the thing that
 * should become optional rather than disappear.
 *
 * ## Invite links
 *
 * `mio://setup?key=…` fills the field and connects on its own, so a tester who
 * taps a link types nothing at all. It connects rather than merely pre-filling
 * because a half-completed form is exactly the moment a non-technical user
 * stops. A failure still lands here, with the key in place and the error shown.
 */
export default function SetupScreen() {
  const { t } = useTranslation()
  const router = useGuardedRouter()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const params = useLocalSearchParams<{ key?: string }>()
  const { serverUrl, accessKey, usingDefaultServer, save } = useConnection()

  const [url, setUrl] = useState(serverUrl ?? DEFAULT_SERVER_URL)
  const [key, setKey] = useState(params.key ?? accessKey ?? '')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(
    async (candidateUrl: string, candidateKey: string) => {
      const errorFor = (result: ConnectionResult): string | null => {
        switch (result.kind) {
          case 'unreachable':
            return t('setup.errors.unreachable')
          case 'keyRejected':
            return t('setup.errors.keyRejected')
          case 'notAServer':
            return t('setup.errors.notAServer')
          default:
            return null
        }
      }

      setChecking(true)
      setError(null)
      const result = await checkConnection(candidateUrl, candidateKey.trim() || null)
      setChecking(false)

      const message = errorFor(result)
      if (message) {
        setError(message)
        return
      }
      await save(candidateUrl, candidateKey.trim() || null)
      router.replace('/')
    },
    [save, router, t],
  )

  /** An invite link connects by itself, once. */
  const autoConnected = useRef(false)
  useEffect(() => {
    if (autoConnected.current || !params.key) return
    autoConnected.current = true
    void connect(serverUrl ?? DEFAULT_SERVER_URL, params.key)
  }, [params.key, serverUrl, connect])

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{t('setup.title')}</Text>
        <Text style={styles.intro}>{t('setup.introInvite')}</Text>

        <Text style={styles.label}>{t('setup.keyLabel')}</Text>
        <TextInput
          style={styles.input}
          value={key}
          onChangeText={setKey}
          placeholder={t('setup.keyPlaceholder')}
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          accessibilityLabel={t('setup.keyLabel')}
        />
        <Text style={styles.hint}>{t('setup.keyHintInvite')}</Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={({ pressed }) => [
            styles.button,
            checking && styles.buttonDisabled,
            pressed && styles.pressed,
          ]}
          disabled={checking}
          onPress={() => connect(url, key)}
          accessibilityRole="button"
        >
          {checking ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>{t('setup.connect')}</Text>
          )}
        </Pressable>

        <Button label={t('setup.skip')} variant="plain" onPress={() => router.replace('/')} />

        <Button
          label={t('setup.advanced')}
          variant="plain"
          onPress={() => setShowAdvanced((shown) => !shown)}
        />

        {showAdvanced ? (
          <>
            <Text style={styles.label}>{t('setup.serverLabel')}</Text>
            <TextInput
              style={styles.input}
              value={url}
              onChangeText={setUrl}
              placeholder={DEFAULT_SERVER_URL || t('setup.serverPlaceholder')}
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              accessibilityLabel={t('setup.serverLabel')}
            />
            <Text style={styles.hint}>
              {usingDefaultServer ? t('setup.usingDefault') : t('setup.usingCustom')}
            </Text>
            {!usingDefaultServer && DEFAULT_SERVER_URL ? (
              <Button
                label={t('setup.resetServer')}
                variant="plain"
                onPress={() => setUrl(DEFAULT_SERVER_URL)}
              />
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    /** The one shared press fill (#378). */
    pressed: { backgroundColor: theme.surfacePressed },
    flex: { flex: 1, backgroundColor: theme.background },
    container: { padding: 24, gap: 4, flexGrow: 1, justifyContent: 'center' },
    title: { fontSize: 26, fontWeight: '600', marginBottom: 4, color: theme.text },
    intro: { fontSize: 15, color: theme.textMuted, marginBottom: 20 },
    label: { fontSize: 14, fontWeight: '500', marginTop: 12, color: theme.text },
    input: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      marginTop: 6,
      color: theme.text,
    },
    hint: { fontSize: 12, color: theme.textMuted, marginTop: 4 },
    error: { color: theme.danger, fontSize: 14, marginTop: 16 },
    button: {
      backgroundColor: theme.accentSolid,
      borderRadius: 8,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 24,
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: theme.accentText, fontSize: 16, fontWeight: '600' },
  })
