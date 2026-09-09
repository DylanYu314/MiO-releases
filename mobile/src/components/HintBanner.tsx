import { useTranslation } from 'react-i18next'
import { StyleSheet, Text, View } from 'react-native'

import { shouldShowHint, useOnboarding, type HintId } from '../onboarding/store'
import { useThemedStyles, type Theme } from '../theme'
import { Button } from './ui/Button'

/**
 * A one-time inline hint for a gesture nothing on screen advertises (#502).
 *
 * after the device pass: *"some of the feature user might not know, like
 * swipe track right to add to user queue."* The tour gained a step for the same
 * reason, but a tour is seen once and forgotten. This appears **where the
 * gesture lives**, which is the part that actually teaches.
 *
 * ## It retires itself when the gesture is used, not when a button is pressed
 *
 * That is the issue's requirement and it is the right one: the hint exists to
 * cause a first use, so a first use is what it should cost. `useHintDismissal`
 * below is the hook the gesture's own handler calls.
 *
 * ## It also has a dismiss button, which is a deliberate departure
 *
 * The issue says "not on a button press". Shipped literally, that leaves
 * someone who does not want the gesture — or cannot perform it — with a banner
 * pinned to the top of their library forever. That is exactly #430: I had a
 * download error that could not be closed, and the lesson written down from it is
 * that a message the user cannot get rid of is one they have to live with. So
 * the gesture is the *intended* exit and the × is the escape hatch, rather than
 * the × being the only way out.
 *
 * ## Never at the same time as the tour
 *
 * `shouldShowHint` requires the tour to be finished. The tour is a `Modal` and
 * would cover this anyway, so a hint teaching a gesture that cannot be reached
 * is the only thing overlapping could produce.
 */
export function HintBanner({ id, messageKey }: { id: HintId; messageKey: string }) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const visible = useOnboarding((state) => shouldShowHint(state, id))
  const dismissHint = useOnboarding((state) => state.dismissHint)

  if (!visible) return null

  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.text}>{t(messageKey)}</Text>
      <Button
        label="×"
        variant="plain"
        onPress={() => dismissHint(id)}
        accessibilityLabel={t('common.dismiss')}
      />
    </View>
  )
}

/**
 * The other half: retire a hint because its gesture was just used.
 *
 * A hook rather than a bare `useOnboarding.getState().dismissHint` at the call
 * site, so the screens that own these gestures do not each reach into the store
 * differently. Calling it when the hint is already gone is a no-op — the
 * gesture fires every time, not only the first.
 */
export function useHintDismissal(id: HintId): () => void {
  const dismissHint = useOnboarding((state) => state.dismissHint)
  return () => dismissHint(id)
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: 16,
      marginBottom: 8,
      paddingVertical: 8,
      paddingLeft: 12,
      paddingRight: 4,
      borderRadius: 10,
      backgroundColor: theme.surface,
      borderLeftWidth: 3,
      borderLeftColor: theme.accentSolid,
    },
    text: { flex: 1, fontSize: 13, lineHeight: 18, color: theme.textMuted },
  })
