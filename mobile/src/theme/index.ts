import { useMemo } from 'react'
import { useColorScheme } from 'react-native'

import { buildTheme, type Theme } from './palette'
import { useThemeStore } from './store'

export { buildTheme } from './palette'
export type { Theme } from './palette'
export { loadTheme, useThemeStore, type ThemeMode } from './store'
export { ACCENT_PRESETS, DEFAULT_ACCENT, type AccentName } from '@mio/shared/tokens'

/**
 * One `Theme` object per distinct (mode, accent) pair, for the whole app.
 *
 * Memoizing inside the hook instead would give every component its own `Theme`
 * for the same colours, which defeats the style cache below: two screens asking
 * for the same palette would build two identical `StyleSheet`s. There are at
 * most a dozen entries — two modes times six accents — so the map never needs
 * evicting.
 */
const themeCache = new Map<string, Theme>()

function cachedTheme(isDark: boolean, accent: string): Theme {
  const key = `${isDark ? 'dark' : 'light'}:${accent}`
  let theme = themeCache.get(key)
  if (!theme) {
    theme = buildTheme(isDark, accent as never)
    themeCache.set(key, theme)
  }
  return theme
}

/**
 * The palette for right now.
 *
 * A hook rather than a React context, which is what the web's equivalent would
 * suggest. There is nothing for a provider to provide: both inputs are already
 * global — a Zustand store and React Native's own `useColorScheme` — so a
 * context would add a wrapper, a second place to forget, and the "used outside
 * its provider" failure mode, in exchange for nothing.
 */
export function useTheme(): Theme {
  const mode = useThemeStore((state) => state.mode)
  const accent = useThemeStore((state) => state.accent)
  // Null while the OS has not answered yet; light is the safer assumption, since
  // a light flash on a dark phone is briefer and less alarming than the reverse.
  const scheme = useColorScheme()

  const isDark = mode === 'dark' || (mode === 'system' && scheme === 'dark')
  return cachedTheme(isDark, accent)
}

/**
 * Per-factory, per-theme cache of built stylesheets.
 *
 * A `WeakMap` on the factory so a screen that unmounts for good takes its entry
 * with it; a plain `Map` on the theme inside, because the themes are the cached
 * singletons above and are meant to outlive everything.
 */
const styleCache = new WeakMap<object, Map<Theme, unknown>>()

/**
 * Build a screen's `StyleSheet` from the current palette.
 *
 * Screens used to call `StyleSheet.create` at module scope, which is why none of
 * them could have a dark mode: a module-scope constant is evaluated once, before
 * anything knows what the theme is. This is the replacement, and it keeps the
 * property that made the old way attractive — **the object identity is stable**.
 *
 * That matters more than it looks. `SongRow` is `React.memo`'d and a library can
 * hold thousands of them; a fresh style object per render would change nothing
 * visible and defeat every memo in the list. Caching on (factory, theme) means
 * every component sharing a palette also shares one built stylesheet, and it
 * only rebuilds when the palette actually changes.
 *
 * The factory must be defined at module scope, so its identity is stable — an
 * inline arrow would miss the cache on every render.
 */
export function useThemedStyles<T>(factory: (theme: Theme) => T): T {
  const theme = useTheme()
  return useMemo(() => {
    let byTheme = styleCache.get(factory)
    if (!byTheme) {
      byTheme = new Map()
      styleCache.set(factory, byTheme)
    }
    let styles = byTheme.get(theme)
    if (!styles) {
      styles = factory(theme)
      byTheme.set(theme, styles)
    }
    return styles as T
  }, [factory, theme])
}
