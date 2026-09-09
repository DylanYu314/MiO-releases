import { useTranslation } from 'react-i18next'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native'

import { useThemedStyles, type Theme } from '../theme'

export interface SheetAction {
  key: string
  label: string
  onPress: () => void
  /** A picture for the thing this action picks (#312). Optional: most actions
   *  are verbs and have nothing to show. */
  thumbnail?: string | null
  /** Renders in red. For actions that remove something. */
  destructive?: boolean
  /**
   * This action swaps one sheet for another rather than finishing.
   *
   * Ordinarily the sheet closes *before* running an action, so a modal it opens
   * does not stack on top of a still-open one — Android renders the older of two
   * transparent modals on top. But "close" here means calling the owner's
   * `onClose`, and an owner that unmounts the sheet on close would tear down the
   * component that was about to show the next view: the action never runs, or
   * runs against an unmounted tree.
   *
   * So an action that replaces the sheet says so, and is responsible for making
   * this one invisible itself — normally by flipping the state that drives
   * `visible`, which achieves the same no-stacking result.
   */
  replacesSheet?: boolean
}

interface Props {
  visible: boolean
  title: string
  subtitle?: string
  /** Cover art for the header, when the subject has any (#229). A local
   *  `file://` path — see `SongRow` for why it can only ever be local. */
  artworkUri?: string | null
  actions: readonly SheetAction[]
  onClose: () => void
}

/**
 * A bottom sheet of actions.
 *
 * ## Why this exists instead of `Alert.alert`
 *
 * The song long-press menu used to be an `Alert`, and that had a hard ceiling
 * nobody had hit yet: React Native's Android implementation does
 * `buttons.slice(0, 3)` (`Libraries/Alert/Alert.js`), because an Android
 * `AlertDialog` has exactly three slots — neutral, negative, positive. The menu
 * already had three (play next, queue, cancel), so **adding a fourth action
 * would have silently not appeared** rather than failing in a way anyone would
 * notice.
 *
 * A sheet also reads better on a phone: the actions sit under the thumb rather
 * than in the middle of the screen, and there is room for a real label than
 * "OK".
 *
 * Built rather than installed. It is a `Modal`, a backdrop and a column of
 * `Pressable`s; an action-sheet package would be a dependency for that.
 */
export function ActionSheet({ visible, title, subtitle, artworkUri, actions, onClose }: Props) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const insets = useSafeAreaInsets()

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      // Android's back button. Without this the sheet is a trap: there is no
      // gesture to dismiss a transparent modal, and the backdrop is the only
      // other way out.
      accessibilityViewIsModal
    >
      <Pressable
        style={({ pressed }) => [styles.backdrop, pressed && styles.pressed]}
        onPress={onClose}
        accessibilityRole="button"
        // ⚠️ Without a label this is the one control in the app a screen
        // reader cannot name (#519): it has no text child to borrow from, so
        // TalkBack announces a bare "button" occupying the whole screen. The
        // sheet is `accessibilityViewIsModal`, so this is also the first thing
        // reached inside it.
        accessibilityLabel={t('common.dismiss')}
      />
      <View
        testID="action-sheet"
        style={[styles.sheet, { paddingBottom: SHEET_PADDING_BOTTOM + insets.bottom }]}
      >
        <View style={styles.header}>
          {/* The sheet says which song it is about. Without it, a menu raised
              from a long list is a menu with no subject — and the 3-dot makes
              that more likely, not less, because it is easier to hit the wrong
              row's button than to long-press the wrong row. */}
          {artworkUri ? <Image source={{ uri: artworkUri }} style={styles.artwork} /> : null}
          <View style={styles.headerText}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        </View>
        {actions.map((action) => (
          <Pressable
            key={action.key}
            onPress={() => {
              // Close first: leaving the sheet up while the next modal opens
              // stacks two transparent modals, and Android renders the older one
              // on top. An action that *replaces* this sheet opts out and hides
              // it itself — see `replacesSheet`.
              if (!action.replacesSheet) onClose()
              action.onPress()
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            {action.thumbnail ? (
              <Image
                testID={`sheet-thumbnail-${action.key}`}
                source={{ uri: action.thumbnail }}
                style={styles.actionThumbnail}
                accessibilityElementsHidden
                importantForAccessibility="no"
              />
            ) : null}
            <Text
              style={[
                styles.actionText,
                action.destructive && styles.destructive,
                // Only when there is a picture, so every other sheet in the app
                // is laid out exactly as it was.
                action.thumbnail ? styles.actionTextBeside : null,
              ]}
            >
              {action.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, styles.cancel, pressed && styles.pressed]}
        >
          <Text style={styles.cancelText}>{t('common.cancel')}</Text>
        </Pressable>
      </View>
    </Modal>
  )
}

/** The fixed part of the sheet's bottom padding. Every sheet in the app is
 *  this component, so the gesture bar is handled once, here (#305). */
const SHEET_PADDING_BOTTOM = 24

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    // A fixed scrim in both themes. It dims whatever is behind the sheet, and
    // the thing behind it is the app, not the palette — a light scrim on a dark
    // screen would brighten the backdrop instead of pushing it back.
    backdrop: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.45)' },
    sheet: {
      backgroundColor: theme.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingBottom: SHEET_PADDING_BOTTOM,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 20,
      paddingTop: 18,
      paddingBottom: 10,
    },
    headerText: { flex: 1, minWidth: 0 },
    artwork: { width: 44, height: 44, borderRadius: 6, backgroundColor: theme.surfaceMuted },
    title: { fontSize: 16, fontWeight: '700', color: theme.text },
    subtitle: { fontSize: 13, color: theme.textMuted, marginTop: 2 },
    action: {
      paddingHorizontal: 20,
      paddingVertical: 15,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    actionThumbnail: {
      width: 44,
      height: 44,
      borderRadius: 6,
      backgroundColor: theme.surfaceMuted,
    },
    actionTextBeside: { flex: 1, minWidth: 0 },
    pressed: { backgroundColor: theme.surfacePressed },
    actionText: { fontSize: 16, color: theme.accentOnSurface },
    destructive: { color: theme.danger },
    cancel: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      marginTop: 6,
    },
    cancelText: { fontSize: 16, color: theme.textMuted },
  })
