import { BottomTabBar, Tabs, type BottomTabBarProps } from 'expo-router/js-tabs'
import { useTranslation } from 'react-i18next'
import { View, type ColorValue } from 'react-native'

import { ImportProgressPanel } from '../../src/components/ImportProgressPanel'
import { MiniPlayer } from '../../src/components/MiniPlayer'
import { TabGlyph, type TabGlyphName } from '../../src/components/TabGlyph'
import { useTheme } from '../../src/theme'

/**
 * The four destinations, and what got folded into them (#226).
 *
 * Navigation was a row of six text links at the foot of the library, with a
 * seventh destination reachable only from the empty state. Seven candidates do
 * not fit a tab bar, and two of them collapsed on inspection:
 *
 * - **Favourites is not a tab.** It is already pinned at the top of the playlist
 *   list, deliberately (see `playlists/index.tsx`) — it is a playlist with a
 *   fixed identity, and a tab would give the same list two front doors.
 * - **Add link, Search and Import are one job.** Three doors onto "get music
 *   into the library", and since #246 three doors onto the same mechanism: the
 *   device fetches the bytes in all three. They share a gate story too (a link
 *   needs no key, the other two do, ADR-009), which is worth explaining once
 *   rather than discovering three times. `add/index.tsx` is that explanation.
 *
 * Four rather than five — Search being the obvious fifth — because Android
 * starts eliding tab labels as they crowd, and the labels are load-bearing here:
 * the icons are hand-drawn shapes, not a recognised icon set.
 */
const TABS: { name: string; glyph: TabGlyphName; labelKey: string }[] = [
  { name: 'index', glyph: 'library', labelKey: 'nav.library' },
  { name: 'playlists', glyph: 'playlists', labelKey: 'nav.playlists' },
  { name: 'add', glyph: 'add', labelKey: 'nav.add' },
  { name: 'settings', glyph: 'settings', labelKey: 'nav.settings' },
]

export default function TabsLayout() {
  const { t } = useTranslation()
  const theme = useTheme()

  return (
    <Tabs
      /**
       * The whole point of #226's `PlayerHost` split.
       *
       * The mini player has to be *above* the tab bar, and only the tab
       * navigator knows where the tab bar is — it applies the safe-area inset
       * itself, so anything positioned by hand ends up either overlapping the
       * gesture bar or floating above it. Rendering the bar as part of the tab
       * bar puts it exactly where it belongs, and means a tab change re-renders
       * the screen without touching the player.
       *
       * The audio is elsewhere and unaffected; see `MiniPlayer`.
       */
      tabBar={(props: BottomTabBarProps) => (
        <View style={{ backgroundColor: theme.surface }}>
          {/* Above the player: an import is something the app is doing for you,
              and belongs next to the other thing it is doing for you. Renders
              nothing when nothing is importing (#182). */}
          <ImportProgressPanel />
          <MiniPlayer />
          <BottomTabBar {...props} />
        </View>
      )}
      screenOptions={{
        headerStyle: { backgroundColor: theme.surface },
        headerTintColor: theme.text,
        headerShadowVisible: false,
        tabBarActiveTintColor: theme.accent[theme.isDark ? 4 : 6],
        tabBarInactiveTintColor: theme.textMuted,
        tabBarStyle: {
          backgroundColor: theme.surface,
          borderTopColor: theme.border,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      {TABS.map(({ name, glyph, labelKey }) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title: t(labelKey),
            // The stack tabs draw their own headers, so a header here as well
            // would stack two. The leaf tabs have no stack and keep theirs.
            headerShown: name === 'index' || name === 'settings',
            tabBarIcon: ({ color }: { color: ColorValue }) => (
              <TabGlyph name={glyph} color={color} size={24} />
            ),
          }}
        />
      ))}
    </Tabs>
  )
}
