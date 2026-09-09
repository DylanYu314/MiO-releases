import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'

import { useOnboarding } from '../onboarding/store'
import { useThemedStyles, type Theme } from '../theme'
import { Button } from '../components/ui/Button'

/**
 * The tour steps, in order. Each maps to `onboarding.<step>.{title,body}`.
 *
 * `gestures` (#502) sits straight after `listen`, because it is about the list
 * that step has just introduced — and before `add`, so it is seen while there
 * is still nothing in the library to be distracted by.
 *
 * ⚠️ **This array is mobile-only.** The web tour reads the same catalogue and
 * has its own `STEPS`; these gestures do not exist there, so adding the key to
 * `shared/i18n` deliberately does not add the step to the web.
 */
const STEPS = ['welcome', 'listen', 'gestures', 'add', 'personalize'] as const

/**
 * The first-run tour (#323).
 *
 * *"introduction and features introduction when user first boot the
 * app."* Before this a first run landed straight on an empty library with no
 * explanation — `app/setup.tsx` is the invite-key screen, not a tour, and it
 * barely ever appears because a server address ships in `app.json`.
 *
 * **The copy is not new.** All four steps already existed in `shared/i18n` in
 * both languages for the web tour, and mobile loads the same catalogue, so this
 * is a port of the presentation only.
 *
 * ## Mounted only while unfinished
 *
 * The root layout renders this conditionally rather than passing it a `visible`
 * prop, which is what keeps `useState(0)` honest: replaying from Settings
 * unmounts and remounts it, so it always opens at step 0 with no reset logic of
 * its own. The web does exactly the same thing for the same reason.
 *
 * `onRequestClose` is wired to finish rather than ignored — on Android that is
 * the hardware back button, and a tour that traps someone behind it is worse
 * than one they can leave.
 */
export function OnboardingOverlay() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const complete = useOnboarding((state) => state.complete)
  const [step, setStep] = useState(0)

  const key = STEPS[step]
  const isFirst = step === 0
  const isLast = step === STEPS.length - 1

  return (
    <Modal visible transparent animationType="fade" onRequestClose={complete}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header">
              {t(`onboarding.${key}.title`)}
            </Text>
            <Button label={t('onboarding.skip')} variant="plain" onPress={complete} />
          </View>

          <Text style={styles.body}>{t(`onboarding.${key}.body`)}</Text>

          {/* Decorative: the same information is in "step N of M" on the
              buttons either side, so a screen reader announcing four dots
              would only be noise. */}
          <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no">
            {STEPS.map((name, index) => (
              <View key={name} style={[styles.dot, index === step && styles.dotActive]} />
            ))}
          </View>

          <View style={styles.buttons}>
            {/* Hidden rather than disabled on the first step: a disabled
                control on a phone is a target that swallows a tap and says
                nothing. */}
            {isFirst ? (
              <View />
            ) : (
              <Pressable
                onPress={() => setStep((value) => value - 1)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>{t('onboarding.back')}</Text>
              </Pressable>
            )}

            <Pressable
              onPress={() => (isLast ? complete() : setStep((value) => value + 1))}
              accessibilityRole="button"
              style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            >
              <Text style={styles.buttonText}>
                {isLast ? t('onboarding.getStarted') : t('onboarding.next')}
              </Text>
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
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    card: {
      width: '100%',
      maxWidth: 420,
      borderRadius: 16,
      backgroundColor: theme.surface,
      padding: 22,
      gap: 14,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 16,
    },
    title: { flex: 1, fontSize: 19, fontWeight: '700', color: theme.text },
    skip: { fontSize: 14, color: theme.textMuted },
    body: { fontSize: 15, lineHeight: 22, color: theme.textMuted },
    dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 2 },
    dot: {
      height: 6,
      width: 6,
      borderRadius: 999,
      backgroundColor: theme.border,
    },
    dotActive: { width: 18, backgroundColor: theme.accentSolid },
    buttons: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    button: {
      backgroundColor: theme.accentSolid,
      borderRadius: 8,
      paddingVertical: 12,
      paddingHorizontal: 22,
    },
    buttonText: { color: theme.accentText, fontSize: 15, fontWeight: '600' },
    secondary: { paddingVertical: 12, paddingHorizontal: 12 },
    secondaryText: { fontSize: 15, color: theme.textMuted },
  })
