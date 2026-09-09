/**
 * Design tokens (ADR-007), in a platform-neutral form.
 *
 * These live here rather than in the web client because React Native has no
 * CSS: the web reads them as custom properties, the Android app reads the same
 * values as plain JavaScript. Neither platform owns them.
 *
 * This is also the single source of truth for a value that was previously
 * written down twice — the default indigo ramp appeared both here and hardcoded
 * in `frontend/src/index.css`. A test in the web client asserts the two still
 * agree (`src/theme/tokens.test.ts`).
 */

/** Tailwind's shade scale, in the order every `ramp` below is written. */
export const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const


/** Curated accent presets — a full 50→950 ramp each. The picker only exposes
 *  these (not a free colour wheel) so text stays legible on both themes. The
 *  order of shades matches SHADES above. */
export const ACCENT_PRESETS = {
  indigo: {
    label: 'Indigo',
    ramp: [
      '#eef2ff',
      '#e0e7ff',
      '#c7d2fe',
      '#a5b4fc',
      '#818cf8',
      '#6366f1',
      '#4f46e5',
      '#4338ca',
      '#3730a3',
      '#312e81',
      '#1e1b4b',
    ],
  },
  blue: {
    label: 'Blue',
    ramp: [
      '#eff6ff',
      '#dbeafe',
      '#bfdbfe',
      '#93c5fd',
      '#60a5fa',
      '#3b82f6',
      '#2563eb',
      '#1d4ed8',
      '#1e40af',
      '#1e3a8a',
      '#172554',
    ],
  },
  violet: {
    label: 'Violet',
    ramp: [
      '#f5f3ff',
      '#ede9fe',
      '#ddd6fe',
      '#c4b5fd',
      '#a78bfa',
      '#8b5cf6',
      '#7c3aed',
      '#6d28d9',
      '#5b21b6',
      '#4c1d95',
      '#2e1065',
    ],
  },
  emerald: {
    label: 'Emerald',
    ramp: [
      '#ecfdf5',
      '#d1fae5',
      '#a7f3d0',
      '#6ee7b7',
      '#34d399',
      '#10b981',
      '#059669',
      '#047857',
      '#065f46',
      '#064e3b',
      '#022c22',
    ],
  },
  rose: {
    label: 'Rose',
    ramp: [
      '#fff1f2',
      '#ffe4e6',
      '#fecdd3',
      '#fda4af',
      '#fb7185',
      '#f43f5e',
      '#e11d48',
      '#be123c',
      '#9f1239',
      '#881337',
      '#4c0519',
    ],
  },
  amber: {
    label: 'Amber',
    ramp: [
      '#fffbeb',
      '#fef3c7',
      '#fde68a',
      '#fcd34d',
      '#fbbf24',
      '#f59e0b',
      '#d97706',
      '#b45309',
      '#92400e',
      '#78350f',
      '#451a03',
    ],
  },
}


export type AccentName = keyof typeof ACCENT_PRESETS

/** The accent used when nothing is stored, and the ramp baked into the web
 *  client's stylesheet as its pre-paint default. */
export const DEFAULT_ACCENT: AccentName = 'indigo'
