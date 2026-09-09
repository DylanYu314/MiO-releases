import AsyncStorage from '@react-native-async-storage/async-storage'
import { act, render, screen } from '@testing-library/react-native'
import { Text, useColorScheme } from 'react-native'

import { ACCENT_PRESETS, DEFAULT_ACCENT, type AccentName } from '@mio/shared/tokens'
import { buildTheme, loadTheme, useTheme, useThemedStyles, useThemeStore } from '../src/theme'

/**
 * The theme layer (#227).
 *
 * Mobile had none: every screen read `ACCENT_PRESETS[DEFAULT_ACCENT]` at module
 * scope, which is evaluated once, before anything knows what the theme is —
 * which is *why* there was no dark mode, not merely why there was no picker.
 */

jest.mock('react-native/Libraries/Utilities/useColorScheme')
const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>

beforeEach(async () => {
  await AsyncStorage.clear()
  mockScheme.mockReturnValue('light')
  useThemeStore.setState({ mode: 'system', accent: DEFAULT_ACCENT })
})

describe('buildTheme', () => {
  it('gives dark mode a lighter accent for text than light mode uses', () => {
    const ramp = ACCENT_PRESETS.indigo.ramp

    expect(buildTheme(false, 'indigo').accentOnSurface).toBe(ramp[6])
    // The mid-ramp shades are picked to carry white text on a light page. As
    // text on a dark page they fall below a readable contrast, so dark mode
    // reaches for the ramp's lighter end.
    expect(buildTheme(true, 'indigo').accentOnSurface).toBe(ramp[3])
  })

  /*
   * ⛔ The bug this exists to stop coming back (#722).
   *
   * `DonateCard` painted `accent[1]` — a raw ramp shade — as its surface while
   * its text used `theme.text`. `accent[1]` is the same near-white tint in both
   * modes and `theme.text` flips, so in dark mode the card was light text on a
   * light fill: **1.00:1 on indigo**, measured. Invisible, not merely poor.
   *
   * ⚠️ Nothing else could have caught it. `tsc` is happy — `accent` is a plain
   * string array — eslint has no opinion about colour, and a render test only
   * proves the component drew *something*. The failure is arithmetic between
   * two tokens, so the assertion has to be arithmetic too.
   *
   * Asserted across every preset in both modes, because a bug that is fine on
   * indigo and broken on amber is exactly what a single-preset test ships.
   */
  const relativeLuminance = (hex: string) => {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: string, b: string) => {
    const [x, y] = [relativeLuminance(a), relativeLuminance(b)]
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }

  it('keeps text readable on the accent-tinted panel, in both modes, on every preset', () => {
    const presets = Object.keys(ACCENT_PRESETS) as AccentName[]
    // The control: if this list ever empties, every loop below passes vacuously
    // and the guard reports success having asserted nothing.
    expect(presets.length).toBe(6)

    for (const accent of presets) {
      for (const isDark of [false, true]) {
        const theme = buildTheme(isDark, accent)
        const where = `${accent} ${isDark ? 'dark' : 'light'}`

        // Body text on the card. AA is 4.5:1; these measure 11.9–16.0:1.
        expect({ where, ratio: contrast(theme.text, theme.accentBg) >= 4.5 }).toEqual({
          where,
          ratio: true,
        })
        // The caption under the button, which is the smallest text on it.
        expect({ where, ratio: contrast(theme.textMuted, theme.accentBg) >= 4.5 }).toEqual({
          where,
          ratio: true,
        })
        // The accent-coloured glyph. Measured ≥4.51:1, so it clears the body
        // threshold and not merely the 3:1 one a 28px glyph would need.
        expect({ where, ratio: contrast(theme.accentOnBg, theme.accentBg) >= 4.5 }).toEqual({
          where,
          ratio: true,
        })

        /*
         * ⛔ **The pair #519 never enumerated** (#734): `accentText` on
         * `accentSolid`. That sweep reported "passes AA everywhere, worst pair
         * 6.57:1" while white on `ramp[5]` was failing on all six presets —
         * 2.15:1 on amber. It was looking at text on `background` and
         * `surface`, and a measurement is only as good as the pairs it lists.
         *
         * This is every filled `Button`, every selected `Chip`, the progress
         * fill and the donate card's button.
         *
         * ⚠️ **4.5:1, not 3:1.** `Button`'s label is 15px/600 and
         * `DonateCard`'s is 16px/700; WCAG's large-text exemption needs
         * ≥18.66px bold or ≥24px, so neither qualifies.
         */
        expect({ where, ratio: contrast(theme.accentText, theme.accentSolid) >= 4.5 }).toEqual({
          where,
          ratio: true,
        })
        /*
         * And the pressed state, which carries the same white label. This is
         * what forces dark mode's press to *deepen* rather than lighten: one
         * step lighter than `accentSolid` is ramp[6], which measures 3.77:1 on
         * emerald and 3.19:1 on amber.
         */
        expect({
          where,
          ratio: contrast(theme.accentText, theme.accentSolidPressed) >= 4.5,
        }).toEqual({ where, ratio: true })
      }
    }
  })

  it('never lets the accent panel be a raw light tint in dark mode', () => {
    /*
     * The specific regression, stated directly: `accentBg` must differ between
     * modes. The contrast test above would also catch it, but this says *why*
     * in one line when it fails, and it is the shape a future component
     * reaching for `accent[1]` would reintroduce.
     */
    for (const accent of Object.keys(ACCENT_PRESETS) as AccentName[]) {
      const ramp = ACCENT_PRESETS[accent].ramp
      expect(buildTheme(false, accent).accentBg).toBe(ramp[1])
      expect(buildTheme(true, accent).accentBg).not.toBe(ramp[1])
    }
  })

  it('falls back to the default accent rather than producing undefined colours', () => {
    // The accent comes off disk, so a value written by an older build must not
    // be able to crash the app on launch.
    const theme = buildTheme(false, 'chartreuse' as never)

    expect(theme.accentSolid).toBe(ACCENT_PRESETS[DEFAULT_ACCENT].ramp[7])
  })

  it('reads its ramps from the shared tokens the web client uses', () => {
    // The point of `shared/tokens.ts`: picking Rose on the phone and Rose in the
    // browser must mean the same colour, or "matching the web" is a claim
    // nobody checked.
    expect(buildTheme(false, 'rose').accent).toEqual(ACCENT_PRESETS.rose.ramp)
  })
})

function Probe() {
  const theme = useTheme()
  return <Text>{`${theme.isDark ? 'dark' : 'light'}:${theme.background}`}</Text>
}

describe('useTheme', () => {
  it('follows the OS while the mode is system', async () => {
    mockScheme.mockReturnValue('dark')

    await render(<Probe />)

    expect(screen.getByText(/^dark:/)).toBeTruthy()
  })

  it('overrides the OS when a mode is chosen', async () => {
    mockScheme.mockReturnValue('dark')
    await render(<Probe />)

    await act(async () => {
      await useThemeStore.getState().setMode('light')
    })

    // The whole reason the mode is three-way rather than a boolean: "follow the
    // system" and "light" are different answers, and only one of them ignores a
    // phone that just went dark.
    expect(screen.getByText(/^light:/)).toBeTruthy()
  })

  /**
   * Load-bearing, not an optimisation.
   *
   * `SongRow` is `React.memo`'d and a library can hold thousands of them. If
   * every render built a fresh stylesheet, the memo would be defeated by a style
   * object that changed identity while representing the same colours.
   */
  it('hands out the same object for the same palette, so styles stay stable', async () => {
    const first = buildTheme(false, 'indigo')
    const second = buildTheme(false, 'indigo')
    // `buildTheme` itself is a plain function and does *not* cache — the cache
    // lives behind `useTheme`, which is what components call.
    expect(first).not.toBe(second)

    let a: unknown
    let b: unknown
    function StyleProbe({ sink }: { sink: (styles: unknown) => void }) {
      sink(useThemedStyles(makeProbeStyles))
      return null
    }
    await render(<StyleProbe sink={(s) => (a = s)} />)
    await render(<StyleProbe sink={(s) => (b = s)} />)

    expect(a).toBe(b)
  })
})

const makeProbeStyles = () => ({ box: { flex: 1 } })

describe('loadTheme', () => {
  it('applies what was stored', async () => {
    await AsyncStorage.setItem('mio-theme-mode', 'dark')
    await AsyncStorage.setItem('mio-theme-accent', 'rose')

    await loadTheme()

    expect(useThemeStore.getState().mode).toBe('dark')
    expect(useThemeStore.getState().accent).toBe('rose')
  })

  it('ignores a stored value it does not recognise', async () => {
    // Written by a build that had an accent this one does not, or by a bug.
    // Either way the app must start, not render a palette of `undefined`.
    await AsyncStorage.setItem('mio-theme-mode', 'sepia')
    await AsyncStorage.setItem('mio-theme-accent', 'chartreuse')

    await loadTheme()

    expect(useThemeStore.getState().mode).toBe('system')
    expect(useThemeStore.getState().accent).toBe(DEFAULT_ACCENT)
  })

  it('remembers a choice across a restart', async () => {
    await act(async () => {
      await useThemeStore.getState().setAccent('emerald')
    })

    // Simulate a cold start: the store is back at its defaults, and only what
    // reached disk survives.
    useThemeStore.setState({ accent: DEFAULT_ACCENT })
    await loadTheme()

    expect(useThemeStore.getState().accent).toBe('emerald')
  })
})
