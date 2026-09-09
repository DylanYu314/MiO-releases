import AsyncStorage from '@react-native-async-storage/async-storage'
import { ACCENT_PRESETS, DEFAULT_ACCENT, type AccentName } from '@mio/shared/tokens'
import { create } from 'zustand'

export type ThemeMode = 'system' | 'light' | 'dark'

const MODE_KEY = 'mio-theme-mode'
const ACCENT_KEY = 'mio-theme-accent'

interface ThemeState {
  mode: ThemeMode
  accent: AccentName
  setMode: (mode: ThemeMode) => Promise<void>
  setAccent: (accent: AccentName) => Promise<void>
}

/**
 * The chosen theme, remembered across launches (#227).
 *
 * Mirrors `frontend/src/theme/store.ts` — the same three-way mode and the same
 * accent presets, read from the same `shared/tokens.ts` — but the reads and
 * writes differ. The web can read `localStorage` synchronously, so its store is
 * seeded with the stored value at construction. AsyncStorage cannot be, so this
 * starts at the defaults and `loadTheme()` corrects it a tick later, exactly the
 * pattern `audioSettings` and the language preference already use.
 *
 * `system` is the default because a phone has a system-wide answer and an app
 * that ignores it is the odd one out.
 */
export const useThemeStore = create<ThemeState>((set) => ({
  mode: 'system',
  accent: DEFAULT_ACCENT,

  // Set first, then persist, so the UI changes under the thumb that pressed it
  // rather than after a round trip to disk.
  setMode: async (mode) => {
    set({ mode })
    await AsyncStorage.setItem(MODE_KEY, mode)
  },

  setAccent: async (accent) => {
    set({ accent })
    await AsyncStorage.setItem(ACCENT_KEY, accent)
  },
}))

function isMode(value: string | null): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark'
}

function isAccent(value: string | null): value is AccentName {
  return value != null && value in ACCENT_PRESETS
}

/**
 * Apply the stored theme, if there is one.
 *
 * Called from the root layout alongside the other stored-state loaders, and
 * deliberately *not* awaited by the startup gate. Blocking the first paint on a
 * disk read to avoid one frame of the default theme would be the worse trade —
 * #188 holds the shell back for the install id because getting that wrong looks
 * like data loss, whereas getting this wrong looks like a flicker.
 *
 * Both keys are validated rather than cast: they come off disk, so a value from
 * an older build must not be able to produce a palette of `undefined`.
 */
export async function loadTheme(): Promise<void> {
  const [mode, accent] = await Promise.all([
    AsyncStorage.getItem(MODE_KEY),
    AsyncStorage.getItem(ACCENT_KEY),
  ])
  useThemeStore.setState({
    mode: isMode(mode) ? mode : 'system',
    accent: isAccent(accent) ? accent : DEFAULT_ACCENT,
  })
}
