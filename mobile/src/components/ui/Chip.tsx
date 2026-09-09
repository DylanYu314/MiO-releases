import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native'

import { useThemedStyles, type Theme } from '../../theme'

/**
 * A small selectable pill — the app's third control, after buttons and rows.
 *
 * Eight screens had grown their own `chip` / `chipActive` pair (#378): theme,
 * language and crossfade in Settings, the diagnostics level filter, search
 * platforms, the EQ presets, the library sort, the queue's shuffle and repeat,
 * the review filter, the picker's tabs. They were near-identical and none of
 * them reacted to a finger.
 *
 * A chip is not a `Button` with a rounder corner: it carries **selected state**,
 * which changes both what it looks like at rest and what a screen reader says.
 * Pressing a selected chip is also a normal thing to do, so the pressed colour
 * has to work on both fills — hence two, rather than one applied blindly.
 */
export interface ChipProps {
  label: string
  onPress: () => void
  selected?: boolean
  disabled?: boolean
  /** When the visible label is a shape or a colour rather than a word — the
   *  accent swatches, for one. */
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
  testID?: string
}

export function Chip({
  label,
  onPress,
  selected = false,
  disabled = false,
  accessibilityLabel,
  style,
  testID,
}: ChipProps) {
  const styles = useThemedStyles(makeStyles)

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      // Kept exactly as the screens had it: this is what a screen reader uses to
      // say a filter is on, and it is asserted in several suites.
      accessibilityState={{ selected, disabled }}
      testID={testID}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.selected,
        pressed && !disabled && (selected ? styles.selectedPressed : styles.chipPressed),
        disabled && styles.disabled,
        style,
      ]}
    >
      <Text style={[styles.label, selected && styles.selectedLabel]}>{label}</Text>
    </Pressable>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    chip: {
      // ⚠️ **48, and it is a touch target rather than a look.** Measured on a
      // device at 35.8 dp tall (#519) — the padding and the 13 px label were
      // the whole of it, and nothing set a floor. Android's minimum is 48 dp,
      // and `hitSlop` could not reach it here: every chip row sets `gap: 8`
      // and wraps, so the ~6 dp a side needed would overlap the row beneath
      // and make the seam between them ambiguous.
      //
      // So the pill itself grows. `justifyContent` keeps the label centred in
      // the taller box, which is the only visible consequence.
      minHeight: 48,
      justifyContent: 'center',
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.border,
    },
    chipPressed: { backgroundColor: theme.surfacePressed },
    selected: { backgroundColor: theme.accentSolid, borderColor: theme.accentSolid },
    selectedPressed: {
      backgroundColor: theme.accentSolidPressed,
      borderColor: theme.accentSolidPressed,
    },
    label: { fontSize: 13, color: theme.text },
    selectedLabel: { color: theme.accentText, fontWeight: '600' },
    disabled: { opacity: 0.5 },
  })
