import { create } from 'zustand'

import { ACCENT_PRESETS, DEFAULT_ACCENT, SHADES, type AccentName } from '@mio/shared/tokens'

export type ThemeMode = 'system' | 'light' | 'dark'

// Re-exported so existing imports (the settings picker, its tests) keep working
// and only this module knows where the tokens actually live.
export { ACCENT_PRESETS }
export type { AccentName }

// Same keys the pre-paint script in index.html reads, so the two stay in step.
const MODE_KEY = 'mio-theme-mode'
const ACCENT_KEY = 'mio-theme-accent'

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function applyMode(mode: ThemeMode): void {
  const dark = mode === 'dark' || (mode === 'system' && systemPrefersDark())
  document.documentElement.classList.toggle('dark', dark)
}

function applyAccent(name: AccentName): void {
  const preset = ACCENT_PRESETS[name] ?? ACCENT_PRESETS[DEFAULT_ACCENT]
  const root = document.documentElement
  SHADES.forEach((shade, index) => {
    root.style.setProperty(`--color-accent-${shade}`, preset.ramp[index])
  })
}

function readMode(): ThemeMode {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(MODE_KEY) : null
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
}

function readAccent(): AccentName {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(ACCENT_KEY) : null
  return stored && stored in ACCENT_PRESETS ? (stored as AccentName) : DEFAULT_ACCENT
}

interface ThemeStore {
  mode: ThemeMode
  accent: AccentName
  setMode: (mode: ThemeMode) => void
  setAccent: (accent: AccentName) => void
}

export const useThemeStore = create<ThemeStore>((set) => ({
  mode: readMode(),
  accent: readAccent(),
  setMode: (mode) => {
    localStorage.setItem(MODE_KEY, mode)
    applyMode(mode)
    set({ mode })
  },
  setAccent: (accent) => {
    localStorage.setItem(ACCENT_KEY, accent)
    applyAccent(accent)
    set({ accent })
  },
}))

// Apply the stored theme at import (before render). The pre-paint script already
// set the .dark class to avoid a flash; this also applies a non-default accent.
applyAccent(readAccent())
applyMode(readMode())

// Follow the OS while in "system" mode.
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (useThemeStore.getState().mode === 'system') applyMode('system')
  })
}
