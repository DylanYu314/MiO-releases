import { Stack } from 'expo-router'
import { useTranslation } from 'react-i18next'

import { useTheme } from '../../../src/theme'

/**
 * A stack *inside* the Playlists tab, so opening a playlist keeps the tab bar
 * and the mini player.
 *
 * Pushing detail screens onto the root stack instead would have been a smaller
 * change, and wrong for a music app: the mini player lives in the tab bar
 * (#226), so covering the tabs also hides the transport controls — and browsing
 * a playlist is exactly when you want to skip a track.
 */
export default function PlaylistsLayout() {
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
      <Stack.Screen name="index" options={{ title: t('nav.playlists') }} />
      {/* A static title: the playlist's name depends on fetched data the layout
          has not got, and a long name truncates badly in a nav bar. The screen
          shows it as a heading instead. */}
      {/* Favourites has no screen of its own since #291 — it is `[id]` like any
          other playlist, and names itself in the body. */}
      <Stack.Screen name="[id]" options={{ title: t('nav.playlists') }} />
    </Stack>
  )
}
