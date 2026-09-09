import { useTranslation } from 'react-i18next'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'

import { showToast } from './Toast'
import { logWarn } from '../diagnostics/log'
import { useThemedStyles, type Theme } from '../theme'

/**
 * Where a donation goes, and what it must never do (#517).
 *
 * ⛔ **the project's ground rules: a donation grants *nothing*.** No key,
 * no tier, no entitlement, no feature, no removed limit. A donation route that
 * gives something back is a sale by another name and is out of bounds — which
 * is why this file has no state, reads nothing about whether anyone has given,
 * and cannot: it is a link.
 *
 * It also means no payment code and no personal information enter this repo.
 * Ko-fi is the whole payment system; MiO opens a URL.
 */
export const KOFI_URL = 'https://ko-fi.com/mio_music'

/**
 * An ask, shown in two places (my call): the bottom of the player screen,
 * where someone is actually enjoying the app, and Settings, where someone who
 * went looking can find it.
 *
 * ## The wording is deliberately plain
 *
 * My own line was warmer and funnier in English. It ships to **seven**
 * languages, five of them machine-translated (#519), and register does not
 * survive that — a joke about being broke lands as either meaningless or crude
 * in Japanese, Korean and Russian. So the copy states the facts that make
 * someone want to give (it is free, nothing is locked, it is one student's
 * project) and asks once, which travels intact.
 *
 * ⚠️ **`compact` is not a smaller ask, it is a quieter one.** The player screen
 * is somewhere a user goes many times a day, so the card there is short. The
 * Settings one carries the full explanation.
 */
export function DonateCard({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)

  const open = () => {
    // Never `void` alone: an Android with no browser at all throws here, and a
    // dead button that says nothing is worse than a button that admits it.
    Linking.openURL(KOFI_URL).catch((error: unknown) => {
      logWarn('donate.openFailed', String(error))
      showToast(t('donate.failed'))
    })
  }

  return (
    <View style={[styles.card, compact && styles.cardCompact]}>
      <Text style={styles.heart}>♥</Text>
      <Text style={styles.title}>{t('donate.title')}</Text>
      <Text style={styles.body}>{compact ? t('donate.bodyShort') : t('donate.body')}</Text>

      <Pressable
        onPress={open}
        accessibilityRole="link"
        accessibilityLabel={t('donate.action')}
        accessibilityHint={t('donate.hint')}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      >
        <Text style={styles.buttonLabel}>{t('donate.action')}</Text>
      </Pressable>

      {/* Said on the card rather than only in a policy: the one thing a user
          needs to know before tapping is that nothing changes if they don't. */}
      <Text style={styles.note}>{t('donate.grantsNothing')}</Text>
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      backgroundColor: theme.accentBg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.accentBorder,
      padding: 20,
      alignItems: 'center',
      gap: 8,
      marginTop: 16,
    },
    cardCompact: { padding: 16, marginTop: 24 },
    heart: { fontSize: 28, color: theme.accentOnBg },
    title: { fontSize: 18, fontWeight: '700', color: theme.text, textAlign: 'center' },
    body: { fontSize: 14, color: theme.text, textAlign: 'center', lineHeight: 20 },
    button: {
      // 48 dp, the same minimum #696 measured on a device for every other
      // control. This one is deliberately larger than the floor.
      minHeight: 52,
      alignSelf: 'stretch',
      borderRadius: 999,
      backgroundColor: theme.accentSolid,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 20,
      marginTop: 6,
    },
    buttonPressed: { backgroundColor: theme.accentSolidPressed },
    buttonLabel: { fontSize: 16, fontWeight: '700', color: theme.accentText },
    note: { fontSize: 12, color: theme.textMuted, textAlign: 'center' },
  })
