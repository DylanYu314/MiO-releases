import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import { useThemedStyles, useTheme, type Theme } from '../theme'

/** The backend's `PlaylistCreate.name` is `max_length=300`. Matching it here
 *  means a too-long name is prevented rather than rejected by a 422. */
const MAX_NAME = 300

interface Props {
  title: string
  /** Pre-filled — for renaming, where the current name is the obvious starting
   *  point. */
  initialValue?: string
  confirmLabel: string
  busy?: boolean
  error?: string | null
  onConfirm: (name: string) => void
  onClose: () => void
}

/**
 * Ask for a playlist name.
 *
 * A real modal because **`Alert.prompt` is iOS-only** — there is no
 * one-line way to collect text on Android, so the alternative to this component
 * is no naming at all.
 *
 * ## Mount it to open it; there is no `visible` prop
 *
 * The obvious shape — a permanently-mounted modal with `visible` — needs the
 * field cleared whenever it opens, and the only place to do that is an effect
 * watching the prop. `react-hooks/set-state-in-effect` rejects that, correctly:
 * it is a cascading render, and the React docs say to reset state with a
 * remount instead.
 *
 * So callers render this conditionally and `useState` does the reset for free.
 * The cost is the fade-out animation, which nobody will miss.
 *
 * Whitespace-only input is treated as empty: the backend requires
 * `min_length=1`, and a playlist called " " is a playlist with no name that
 * looks like a rendering bug.
 */
export function NamePrompt({
  title,
  initialValue = '',
  confirmLabel,
  busy = false,
  error = null,
  onConfirm,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const [value, setValue] = useState(initialValue)

  const trimmed = value.trim()
  const canSubmit = trimmed.length > 0 && !busy

  const submit = () => {
    if (!canSubmit) return
    onConfirm(trimmed)
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={({ pressed }) => [styles.backdrop, pressed && styles.pressed]}
        onPress={onClose}
        accessibilityRole="button"
      />
      <View style={styles.centering} pointerEvents="box-none">
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            placeholder={t('playlists.namePlaceholder')}
            accessibilityLabel={title}
            placeholderTextColor={theme.textMuted}
            style={styles.input}
            maxLength={MAX_NAME}
            autoFocus
            // Enter submits, which is what the on-screen keyboard's action key
            // does on a single-field form.
            returnKeyType="done"
            onSubmitEditing={submit}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.buttons}>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryText}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              onPress={submit}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSubmit }}
              disabled={!canSubmit}
              style={({ pressed }) => [
                styles.button,
                !canSubmit && styles.buttonDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.buttonText}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    /** The one shared press fill (#378). */
    pressed: { backgroundColor: theme.surfacePressed },
    // Fills the modal so a tap anywhere outside the card dismisses; the card sits
    // above it in `centering`, which is `pointerEvents: box-none`.
    backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(15, 23, 42, 0.45)' },
    centering: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    card: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: theme.surface,
      borderRadius: 14,
      padding: 20,
      gap: 12,
    },
    title: { fontSize: 17, fontWeight: '700', color: theme.text },
    input: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      // Without this the text is the platform default (near-black) whatever the
      // background is, so a dark theme gets black-on-navy input.
      color: theme.text,
    },
    error: { fontSize: 13, color: theme.danger },
    buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
    button: {
      backgroundColor: theme.accentSolid,
      borderRadius: 8,
      paddingVertical: 11,
      paddingHorizontal: 20,
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: theme.accentText, fontSize: 15, fontWeight: '600' },
    secondary: { borderRadius: 8, paddingVertical: 11, paddingHorizontal: 16 },
    secondaryText: { fontSize: 15, color: theme.textMuted },
  })
