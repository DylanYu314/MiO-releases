import { useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useAppUpdates } from '../updates/useAppUpdates'
import { useThemedStyles, type Theme } from '../theme'
import { Button } from './ui/Button'

/**
 * "There is a newer MiO than this one" — the only way a user finds out (#665).
 *
 * Two different messages, because there are two different updates and the user
 * has to do different things about them:
 *
 * - **A JavaScript fix** is already downloaded and applies on the next launch.
 *   `expo-updates` handles it silently, so the only gap is that the user waits
 *   an extra launch without knowing why. One button closes that.
 * - **A new APK** cannot arrive by itself at all. The user has to go and
 *   download it, so the banner points at where.
 *
 * ## Why it is mounted at the root
 *
 * Beside `Toast`, outside the navigator, for the reason #379 gives: a message
 * that matters has to survive the screen that raised it. Someone who has just
 * hit the YouTube breakage is not going to go looking in Settings.
 *
 * ## ⚠️ Dismissal is deliberately for this launch only
 *
 * There is no persisted "don't show again". A user who dismisses and then
 * restarts sees it again — which is right, because the reason they restarted is
 * usually that the app is misbehaving, and this banner is the fix. Persisting
 * the dismissal would hide the answer at exactly the moment it is wanted.
 */
export function UpdateBanner() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const insets = useSafeAreaInsets()
  const { jsUpdateReady, apkUpdate, restart } = useAppUpdates()
  const [dismissed, setDismissed] = useState<string | null>(null)

  // The APK is the more consequential of the two, so it wins when both are
  // true: a pending JS bundle cannot fix native code, and telling someone to
  // restart when they need to reinstall would be actively misleading.
  const kind = apkUpdate !== null ? 'apk' : jsUpdateReady ? 'js' : null
  if (kind === null || dismissed === kind) return null

  const isApk = kind === 'apk'

  return (
    <View
      style={[styles.wrap, { paddingTop: insets.top + 8 }]}
      accessibilityLiveRegion="polite"
      testID="update-banner"
    >
      <Text style={styles.title}>{isApk ? t('updates.apkTitle') : t('updates.readyTitle')}</Text>
      <Text style={styles.body}>
        {isApk
          ? (apkUpdate?.notes ?? t('updates.apkBody', { version: apkUpdate?.versionName ?? '' }))
          : t('updates.readyBody')}
      </Text>
      <View style={styles.actions}>
        <Button variant="plain" label={t('updates.dismiss')} onPress={() => setDismissed(kind)} />
        <Button
          label={isApk ? t('updates.apkAction') : t('updates.restart')}
          onPress={() => {
            if (isApk) {
              if (apkUpdate !== null) void Linking.openURL(apkUpdate.url)
              // Dismiss too: the download happens in a browser, and leaving the
              // banner up over the app they have just left looks like it failed.
              setDismissed(kind)
            } else {
              void restart()
            }
          }}
        />
      </View>
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    wrap: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      paddingHorizontal: 16,
      paddingBottom: 12,
      backgroundColor: theme.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
      gap: 4,
    },
    title: { color: theme.text, fontSize: 15, fontWeight: '600' },
    body: { color: theme.textMuted, fontSize: 13 },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  })
