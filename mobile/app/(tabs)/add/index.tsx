import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useTheme } from '../../../src/theme'
import { useGuardedRouter } from '../../../src/navigation/useGuardedRouter'

/** The fixed parts of the padding; the insets are added at the point of use. */
const CONTAINER_PADDING = 20
const CONTAINER_PADDING_TOP = 28

/**
 * The head of the Add tab: the ways to get music into the library.
 *
 * #226 folded Add-link, Search and Import into one tab, because they are doors
 * onto one job — and since #246, doors onto the same mechanism: the phone
 * fetches the audio itself, and the server never touches the bytes. Two have
 * been added since and each is an exception to one half of that. **Bilibili**
 * (#320) is the one route where the *server* downloads, because there is no
 * on-device path. **Files on this phone** (#325) is the opposite exception:
 * there is no download at all, because the user already has the music.
 *
 * The screen exists rather than the tab opening straight onto one of them
 * because they are four genuinely different ways in, and a chooser says so in
 * one tap.
 *
 * **The "no key needed" badge is gone (#721), and so is the distinction it
 * reported.** It existed because some doors were gated by an access key and
 * some were not (ADR-009). None are now: #353 moved search onto the device,
 * #325 made local files reach no server at all, and #611/#612 did the same for
 * every playlist import. A badge that is true of every row tells a user
 * nothing.
 */
export default function AddScreen() {
  const { t } = useTranslation()
  const router = useGuardedRouter()
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const options = [
    {
      href: '/add/link',
      title: t('addChooser.link'),
      hint: t('addChooser.linkHint'),
    },
    { href: '/add/search', title: t('addChooser.search'), hint: t('addChooser.searchHint') },
    // Reaches no server at all, not even YouTube. Music the user already has is
    // the most local-first thing on this tab (#325).
    { href: '/add/local', title: t('addChooser.local'), hint: t('addChooser.localHint') },
    { href: '/add/import', title: t('addChooser.import'), hint: t('addChooser.importHint') },
  ]

  return (
    <ScrollView
      testID="add-chooser-scroll"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[
        styles.container,
        {
          // `headerShown: false` at both levels, so this is the top of the
          // screen and 28 points is not a status bar (#305).
          paddingTop: CONTAINER_PADDING_TOP + insets.top,
          paddingLeft: CONTAINER_PADDING + insets.left,
          paddingRight: CONTAINER_PADDING + insets.right,
        },
      ]}
    >
      <Text style={[styles.title, { color: theme.text }]}>{t('addChooser.title')}</Text>
      <Text style={[styles.subtitle, { color: theme.textMuted }]}>{t('addChooser.subtitle')}</Text>

      {options.map(({ href, title, hint }) => (
        <Pressable
          key={href}
          onPress={() => router.push(href)}
          accessibilityRole="button"
          accessibilityLabel={title}
          style={({ pressed }) => [
            styles.card,
            { backgroundColor: theme.surface, borderColor: theme.border },
            pressed && { backgroundColor: theme.surfaceMuted },
          ]}
        >
          <View style={styles.cardText}>
            <Text style={[styles.cardTitle, { color: theme.text }]}>{title}</Text>
            <Text style={[styles.cardHint, { color: theme.textMuted }]}>{hint}</Text>
          </View>
          {/* A chevron from two borders — the same no-icon-dependency approach
              the transport controls and the tab glyphs use. */}
          <View style={[styles.chevron, { borderColor: theme.textMuted }]} />
        </Pressable>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { padding: CONTAINER_PADDING, paddingTop: CONTAINER_PADDING_TOP, gap: 12 },
  title: { fontSize: 24, fontWeight: '700' },
  subtitle: { fontSize: 14, lineHeight: 20, marginBottom: 8 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  // Without a zero minimum a flex child will not shrink, so a long hint pushes
  // the chevron off the screen instead of wrapping.
  cardText: { flex: 1, minWidth: 0, gap: 3 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  cardHint: { fontSize: 13, lineHeight: 18 },
  chevron: {
    width: 9,
    height: 9,
    borderRightWidth: 2,
    borderTopWidth: 2,
    transform: [{ rotate: '45deg' }],
    opacity: 0.6,
  },
  link: { fontSize: 14, marginTop: 8, textAlign: 'center' },
})
