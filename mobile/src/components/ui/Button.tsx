import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native'

import { useTheme, useThemedStyles, type Theme } from '../../theme'

/**
 * A button that looks like one, and reacts to being held (#378).
 *
 * *"For all the options that display in text that can be pressed, make
 * them a button. and for all the button in all pages, give them effect of being
 * pressing or pressed."* Two separate jobs — **affordance** before the press,
 * **feedback** during it — and before this the app did neither consistently:
 * 129 `Pressable`s, 16 of which showed any pressed state at all, and 30 uses of
 * a per-screen `styles.link` that was accent-coloured text and nothing more.
 *
 * The pressed colours are `theme.surfacePressed` / `theme.accentSolidPressed`,
 * defined once in the palette. That is the point of doing this as one pass:
 * the app became inconsistent by answering this question separately on every
 * screen, and a component that cannot be styled per screen is what stops it
 * happening again.
 *
 * ## Why `plain` is still a button
 *
 * The obvious reading of "make pressable text a button" is to give everything a
 * border. That would be wrong for the places a sentence ends in an action —
 * *"Add your invite key"*, *"Change server"* — where a boxed button in the flow
 * of prose reads as heavier than the thing it does.
 *
 * `plain` keeps the text appearance and fixes what was actually broken: it has
 * a real hit area (`MIN_TARGET`, padding, and `hitSlop`), and it visibly fills
 * while held. Nothing on screen is now pressable without saying so.
 */

export type ButtonVariant = 'filled' | 'outlined' | 'plain'

/** Android's own minimum touch target. Several of the text links this replaces
 *  were a 13 px line of text and nothing else — about half of it.
 *
 *  ⚠️ **This was 44, and the comment above it was wrong.** 44 is Apple's
 *  figure (44 pt, HIG); Android and Material 3 both say **48 dp**, and a
 *  device pass measured the Settings buttons at 43.8 dp — under the minimum
 *  the constant was named after (#519). `filled` and `outlined` carry no
 *  `hitSlop`, so those 4 dp were the whole target. */
const MIN_TARGET = 48

export interface ButtonProps {
  label: string
  onPress: () => void
  variant?: ButtonVariant
  disabled?: boolean
  /** Shows a spinner in the label's place and refuses presses. Kept separate
   *  from `disabled` so the reason a button is inert stays legible to a screen
   *  reader — "busy" and "unavailable" are different sentences. */
  busy?: boolean
  /** Layout only — margins and widths. Colours come from the variant. */
  style?: StyleProp<ViewStyle>
  accessibilityLabel?: string
  /** Rendered before the label, for the few buttons that carry a glyph. */
  icon?: ReactNode
  testID?: string
}

export function Button({
  label,
  onPress,
  variant = 'filled',
  disabled = false,
  busy = false,
  style,
  accessibilityLabel,
  icon,
  testID,
}: ButtonProps) {
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const inert = disabled || busy

  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inert, busy }}
      testID={testID}
      // A plain button has no box to aim at, so it takes the slack outside its
      // own bounds instead.
      hitSlop={variant === 'plain' ? 8 : undefined}
      // No `&& !inert` on the pressed style: `disabled` above already stops the
      // Pressable becoming the responder, so `pressed` cannot be true while it
      // is inert. The guard was there and no mutation could distinguish it,
      // which is what dead code looks like.
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        pressed && styles[`${variant}Pressed`],
        inert && styles.inert,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator
          size="small"
          color={variant === 'filled' ? theme.accentText : theme.accentOnSurface}
        />
      ) : (
        <View style={styles.content}>
          {icon}
          <Text style={[styles.label, styles[`${variant}Label`]]}>{label}</Text>
        </View>
      )}
    </Pressable>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    base: {
      minHeight: MIN_TARGET,
      borderRadius: 8,
      paddingHorizontal: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    content: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    label: { fontSize: 15, fontWeight: '600' },

    filled: { backgroundColor: theme.accentSolid },
    filledPressed: { backgroundColor: theme.accentSolidPressed },
    filledLabel: { color: theme.accentText },

    outlined: { borderWidth: 1, borderColor: theme.border },
    outlinedPressed: { backgroundColor: theme.surfacePressed },
    outlinedLabel: { color: theme.text },

    // No horizontal padding to fight with a paragraph it sits under, but a real
    // height and a fill while held.
    plain: { paddingHorizontal: 8, alignSelf: 'flex-start' },
    plainPressed: { backgroundColor: theme.surfacePressed },
    plainLabel: { color: theme.accentOnSurface },

    inert: { opacity: 0.5 },
  })
