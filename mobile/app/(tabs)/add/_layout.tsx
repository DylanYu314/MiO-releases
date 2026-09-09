import { Stack } from 'expo-router'
import { useTranslation } from 'react-i18next'

import { useTheme } from '../../../src/theme'

/**
 * A stack inside the Add tab, for the same reason as the Playlists one: a screen
 * pushed here keeps the tab bar and the mini player.
 *
 * The chooser at `index` has no header — the tab label already says "Add", and a
 * second "Add" directly under it is noise. Everything it pushes does, because
 * those need a back button.
 */
export default function AddLayout() {
  const { t } = useTranslation()
  const theme = useTheme()

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.surface },
        headerTintColor: theme.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.background },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="link" options={{ title: t('nav.addLink') }} />
      <Stack.Screen name="search" options={{ title: t('nav.search') }} />
      {/* The one door that touches no network at all (#325). */}
      <Stack.Screen name="local" options={{ title: t('localAdd.title') }} />
      {/* The server route, given its own page by #320 so add-link can be purely
          on-device. Reached from the chooser, and from add-link when what was
          pasted is not a YouTube link. */}
      <Stack.Screen name="import/index" options={{ title: t('nav.import') }} />
      <Stack.Screen name="import/[id]" options={{ title: t('nav.import') }} />
      <Stack.Screen name="import/spotify" options={{ title: t('spotify.title') }} />
      <Stack.Screen name="import/google" options={{ title: t('google.title') }} />
      <Stack.Screen name="import/bilibili" options={{ title: t('bilibiliFav.title') }} />
      <Stack.Screen name="import/netease" options={{ title: t('netease.title') }} />
      <Stack.Screen name="import/qq" options={{ title: t('qq.title') }} />
      <Stack.Screen name="import/kugou" options={{ title: t('kugou.title') }} />
    </Stack>
  )
}
