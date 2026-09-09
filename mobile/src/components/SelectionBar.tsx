import { useTranslation } from 'react-i18next'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { useThemedStyles, type Theme } from '../theme'
import { Button } from '../components/ui/Button'

interface Props {
  count: number
  /** Whether every row is already chosen, so the button can offer the opposite. */
  allSelected: boolean
  onToggleAll: () => void
  onRemove: () => void
  /**
   * Move the chosen songs into a playlist. Absent on a playlist screen, where
   * the songs are already in one and the useful verb is Remove.
   */
  onMove?: () => void
  /** What Remove is called here — "Delete" in the library, "Remove" in a
   *  playlist. They are genuinely different acts and must not read alike. */
  removeLabel: string
  onCancel: () => void
  busy?: boolean
}

/**
 * What you can do with the songs you have chosen (#336).
 *
 * I asked for two verbs — *"bring up the options 'remove', 'move' (for
 * tracks in library to move to a playlist)"* — so that is what this offers, and
 * not the longer list the issue had speculated about. Adding to the queue and
 * removing-from-this-playlist can be added when they are asked for.
 *
 * ## Why a bar and not an `ActionSheet`
 *
 * `ActionSheet` is the right thing for one song: you have already pointed at
 * it, and the sheet is the list of what can be done to that thing. Selection is
 * the other way round — the verbs stay put while the *subject* changes as you
 * tick rows — so a sheet would have to be opened and dismissed for every
 * change of mind. The bar is always there, and its count is the feedback that
 * the ticking is working.
 *
 * The count is the title on purpose. "3 selected" is the one fact the user
 * needs before pressing something destructive.
 */
export function SelectionBar({
  count,
  allSelected,
  onToggleAll,
  onRemove,
  onMove,
  removeLabel,
  onCancel,
  busy = false,
}: Props) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)

  // Nothing chosen is a normal state — the mode opens that way — so the verbs
  // are disabled rather than hidden. A bar whose buttons appear and disappear
  // as you tick is harder to aim at than one whose buttons dim.
  const none = count === 0

  return (
    <View style={styles.bar} accessibilityRole="toolbar">
      <View style={styles.left}>
        <Text style={styles.count}>{t('select.count', { count })}</Text>
        <Button
          label={t(allSelected ? 'select.none' : 'select.all')}
          variant="plain"
          onPress={onToggleAll}
        />
      </View>

      <View style={styles.actions}>
        {onMove ? (
          <Pressable
            onPress={onMove}
            disabled={none || busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: none || busy }}
            style={({ pressed }) => [
              styles.action,
              (none || busy) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.actionText}>{t('select.move')}</Text>
          </Pressable>
        ) : null}

        <Pressable
          onPress={onRemove}
          disabled={none || busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: none || busy }}
          style={({ pressed }) => [
            styles.action,
            (none || busy) && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.actionText, styles.destructive]}>{removeLabel}</Text>
        </Pressable>

        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          // Never disabled, even mid-work: a bar with no way out is a trap, and
          // the work already started is not undone by leaving the mode.
        >
          <Text style={styles.actionText}>{t('select.done')}</Text>
        </Pressable>
      </View>
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    /** The one shared press fill (#378). */
    pressed: { backgroundColor: theme.surfacePressed },
    bar: {
      borderTopWidth: 1,
      borderTopColor: theme.border,
      backgroundColor: theme.surface,
      paddingHorizontal: 16,
      paddingVertical: 10,
      gap: 8,
    },
    left: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    count: { color: theme.text, fontSize: 14, fontWeight: '600' },
    actions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    action: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8 },
    actionText: { color: theme.text, fontSize: 15, fontWeight: '600' },
    destructive: { color: theme.danger },
    disabled: { opacity: 0.4 },
  })
