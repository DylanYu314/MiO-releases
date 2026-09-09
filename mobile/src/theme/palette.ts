import { ACCENT_PRESETS, DEFAULT_ACCENT, type AccentName } from '@mio/shared/tokens'

/**
 * The colours a screen is allowed to use (#227).
 *
 * Before this, every screen imported `ACCENT_PRESETS[DEFAULT_ACCENT]` at module
 * scope and hardcoded its own `#cbd5e1` besides — twenty-four separate copies of
 * one border colour, and no dark mode possible at all, because a module-scope
 * constant cannot react to anything.
 *
 * The shape mirrors the web client's, but the mechanism cannot: the web sets CSS
 * custom properties on `<html>` and lets the cascade do the work (ADR-007), and
 * React Native has no cascade. So the values are resolved here and handed down
 * through a hook instead.
 *
 * **Semantic names, not shades.** `theme.border`, not `theme.slate[300]`. A
 * screen that asks for a shade has to know which shade is right in dark mode,
 * which is exactly the knowledge this file exists to hold in one place.
 */
export interface Theme {
  /** Whether dark values are in force — for the status bar and the odd case
   *  where a component genuinely needs to branch rather than pick a token. */
  isDark: boolean

  /** The page behind everything. */
  background: string
  /** Raised surfaces: headers, the tab bar, the mini player, cards. */
  surface: string
  /** A subtle fill on top of a surface: progress tracks, inactive chips. */
  surfaceMuted: string
  /** Hairlines, input outlines, chip outlines. */
  border: string

  /**
   * The fill under a finger (#378).
   *
   * Every control that is not a filled button says "I heard you" with this:
   * rows, plain text buttons, icon buttons, chips. One token rather than a
   * per-screen guess is the whole point — the app got inconsistent by deciding
   * this thirty times.
   *
   * Sits between `surface` and `surfaceMuted` so it reads on both the page and
   * a raised card, neither of which it must be mistaken for at rest.
   */
  surfacePressed: string
  /** The same, for a control already filled with `accentSolid`. */
  accentSolidPressed: string

  /** Body text. */
  text: string
  /** Secondary text: hints, timestamps, captions. */
  textMuted: string

  /** The full 50→950 accent ramp, for the rare bespoke case. */
  accent: readonly string[]
  /** Accent as a filled background — buttons, active chips, the progress fill. */
  accentSolid: string
  /** Text and glyphs *on* `accentSolid`. */
  accentText: string
  /** Accent as text on `background` or `surface` — links, active labels. */
  accentOnSurface: string

  /** An accent-tinted panel: fill, outline, and the accent-coloured content on
   *  it. The same trio as `danger`/`dangerBg`/`dangerBorder` below, and it
   *  exists for the same reason (#722).
   *
   *  ⛔ Before this, `DonateCard` painted `accent[1]` — a raw ramp shade — as
   *  its surface. `accent[1]` is the same near-white tint in *both* modes while
   *  `text` flips, so in dark mode the card was light text on a light fill:
   *  **1.00–1.11:1 across all six presets**, measured. Not "hard to read";
   *  invisible.
   *
   *  Which is exactly what the note at the top of this interface forbids — a
   *  screen that asks for a shade has to know which shade is right in dark
   *  mode, and that knowledge belongs here. */
  accentBg: string
  accentBorder: string
  /** Accent-coloured glyphs and text *on* `accentBg`. Measured ≥4.51:1 on every
   *  preset in both modes, so it is safe for body text and not only glyphs. */
  accentOnBg: string

  /** Error text. */
  danger: string
  /** Error panel fill and outline. */
  dangerBg: string
  dangerBorder: string

  /** Success text, and its panel. */
  success: string
  successBg: string
  successBorder: string

  /** A caution that is not a failure — a retry pending, a partial result. */
  warning: string
}

/**
 * Build the palette for a mode and an accent.
 *
 * A plain function of its two inputs, so it is trivially testable and holds no
 * state; `useTheme` memoizes the result.
 */
export function buildTheme(isDark: boolean, accentName: AccentName): Theme {
  // Fall back rather than throw: the accent comes off disk, and a value written
  // by an older build should not be able to crash the app on launch.
  const ramp = (ACCENT_PRESETS[accentName] ?? ACCENT_PRESETS[DEFAULT_ACCENT]).ramp

  if (isDark) {
    return {
      isDark: true,
      background: '#0b1120',
      surface: '#151d2e',
      surfaceMuted: '#243044',
      border: '#334155',
      // Lighter than the surfaces above it: on a dark page a press reads as the
      // control being lit, not shaded.
      surfacePressed: '#2c3a52',
      /*
       * ⚠️ **Darker, not lighter — the exception to the line above** (#734).
       * A press on a *filled* control still carries white text, so it is bound
       * by the same 4.5:1 as the resting state. One step lighter than
       * `accentSolid` is ramp[6], which measures 3.77:1 on emerald and 3.19:1
       * on amber. No lighter shade passes, so the press has to deepen here even
       * though every unfilled surface lightens.
       */
      accentSolidPressed: ramp[8],
      text: '#e2e8f0',
      textMuted: '#94a3b8',
      accent: ramp,
      accentSolid: ramp[7],
      accentText: '#ffffff',
      // A lighter shade than light mode uses. The mid-ramp colours are chosen to
      // carry white text on a light page; as text on a dark page they fall below
      // a readable contrast, and the ramp's own lighter end is already the right
      // hue.
      accentOnSurface: ramp[3],
      // The dark end of the ramp, so the card reads as a tinted panel against
      // `surface` rather than as a hole. `text` on it measures 11.9–13.0:1.
      accentBg: ramp[10],
      accentBorder: ramp[7],
      accentOnBg: ramp[3],
      danger: '#f87171',
      dangerBg: '#2b1113',
      dangerBorder: '#7f1d1d',
      success: '#4ade80',
      successBg: '#0c2417',
      successBorder: '#166534',
      warning: '#fbbf24',
    }
  }

  return {
    isDark: false,
    background: '#ffffff',
    surface: '#f8fafc',
    surfaceMuted: '#e2e8f0',
    border: '#cbd5e1',
    // Darker than the surfaces above it — the mirror of dark mode, where a
    // press is the control being pressed *into* a light page.
    surfacePressed: '#dbe3ec',
    // A step *up* the ramp, not down: ramp[8] is darker than ramp[7], which is
    // what a filled button being pushed should look like in both modes.
    accentSolidPressed: ramp[8],
    text: '#0f172a',
    textMuted: '#475569',
    accent: ramp,
    accentSolid: ramp[7],
    accentText: '#ffffff',
    accentOnSurface: ramp[6],
    accentBg: ramp[1],
    accentBorder: ramp[4],
    // A step darker than `accentOnSurface` uses, because this sits on the tint
    // rather than on `surface`: ramp[6] bottoms out at 2.86:1 on amber, ramp[7]
    // holds 4.51:1 across all six.
    accentOnBg: ramp[7],
    danger: '#b91c1c',
    dangerBg: '#fef2f2',
    dangerBorder: '#fecaca',
    success: '#15803d',
    successBg: '#f0fdf4',
    successBorder: '#bbf7d0',
    warning: '#b45309',
  }
}
