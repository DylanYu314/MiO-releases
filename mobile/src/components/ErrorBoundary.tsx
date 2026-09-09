import { Component, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

import { reportClientError } from '../api/clientErrors'
import { logError } from '../diagnostics/log'
import { useTheme, useThemedStyles, type Theme } from '../theme'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches a render crash, reports it, and asks what happened (P9, #136).
 *
 * Without this, a render error in React Native leaves a blank screen in a
 * production build — no red box, no message, nothing a tester can describe. The
 * first thing anyone would know is "it stopped working".
 *
 * **Still a class component**, because `getDerivedStateFromError` and
 * `componentDidCatch` have no hook equivalent. React has not shipped one, so
 * this is not legacy code awaiting a rewrite.
 *
 * ## What it does not catch
 *
 * Errors thrown in event handlers, in timers, or inside promises — React error
 * boundaries only see errors thrown while rendering. Those paths already surface
 * as visible failures in the UI that raised them (a failed mutation shows its
 * message), so this covers the case that is otherwise silent.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    // Into the local log *as well as* over the wire (#322). The immediate send
    // is the fast path and it needs a reachable server; the log needs nothing,
    // and it is also what carries the entries leading up to this one. A crash
    // while the phone is on the wrong network is not a crash we should lose.
    logError('crash', error.message)
    // Sent immediately rather than waiting for the user to write something: a
    // report with no description still says what broke, and a tester who force
    // quits instead of typing is the likely case.
    void reportClientError({ message: error.message, stack: error.stack })
  }

  render() {
    if (!this.state.error) return this.props.children
    return <CrashScreen error={this.state.error} onDismiss={() => this.setState({ error: null })} />
  }
}

/**
 * The screen shown after a crash.
 *
 * Split out of the boundary so it can use hooks — translation, and the state for
 * the description box — which a class component cannot.
 */
function CrashScreen({ error, onDismiss }: { error: Error; onDismiss: () => void }) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const [description, setDescription] = useState('')
  const [sent, setSent] = useState(false)

  const send = async () => {
    const ok = await reportClientError({
      message: error.message,
      stack: error.stack,
      description: description.trim() || null,
    })
    // Says "sent" only when it was. Claiming otherwise trains a tester to stop
    // bothering.
    setSent(ok)
  }

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
    >
      <Text style={styles.title}>{t('crash.title')}</Text>
      <Text style={styles.body}>{t('crash.body')}</Text>

      <Text style={styles.label}>{t('crash.whatHappened')}</Text>
      <TextInput
        value={description}
        onChangeText={setDescription}
        placeholder={t('crash.placeholder')}
        accessibilityLabel={t('crash.whatHappened')}
        placeholderTextColor={theme.textMuted}
        style={styles.input}
        multiline
        numberOfLines={3}
        maxLength={2000}
      />

      <View style={styles.buttons}>
        <Pressable
          onPress={() => void send()}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <Text style={styles.buttonText}>{sent ? t('crash.sent') : t('crash.send')}</Text>
        </Pressable>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryText}>{t('crash.tryAgain')}</Text>
        </Pressable>
      </View>

      {/* Present but quiet: useless to the user, and the only thing that helps
          if they are sitting next to someone who can read it. */}
      <Text style={styles.detail} numberOfLines={4}>
        {error.message}
      </Text>
    </ScrollView>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    /** The one shared press fill (#378). */
    pressed: { backgroundColor: theme.surfacePressed },
    container: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 10 },
    title: { fontSize: 20, fontWeight: '700', color: theme.text },
    body: { fontSize: 14, color: theme.textMuted, lineHeight: 20 },
    label: { fontSize: 13, fontWeight: '600', marginTop: 10, color: theme.text },
    input: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      padding: 12,
      fontSize: 15,
      minHeight: 90,
      textAlignVertical: 'top',
      color: theme.text,
    },
    buttons: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
    button: {
      backgroundColor: theme.accentSolid,
      borderRadius: 8,
      paddingVertical: 12,
      paddingHorizontal: 22,
    },
    buttonText: { color: theme.accentText, fontSize: 15, fontWeight: '600' },
    secondary: { paddingVertical: 12, paddingHorizontal: 12 },
    secondaryText: { fontSize: 15, color: theme.textMuted },
    detail: { fontSize: 11, color: theme.textMuted, opacity: 0.7, marginTop: 18 },
  })
