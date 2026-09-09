import { describe, expect, it } from 'vitest'

import { ACCENT_PRESETS, DEFAULT_ACCENT, SHADES } from '@mio/shared/tokens'
// `?raw` gives the stylesheet as a string, so this needs no Node APIs and stays
// inside the browser tsconfig.
import css from '../index.css?raw'

/**
 * `src/index.css` hardcodes the default accent ramp inside Tailwind's `@theme`
 * block, because those values must exist before any JavaScript runs — the
 * pre-paint script in index.html would otherwise flash the wrong accent.
 *
 * That makes the ramp the one token written down in two places. The stylesheet
 * cannot import from TypeScript, so a test is what keeps them honest: change
 * the shared ramp without changing the CSS and this fails.
 */
describe('index.css accent tokens', () => {
  it('matches the shared default accent ramp shade for shade', () => {
    const expected = ACCENT_PRESETS[DEFAULT_ACCENT].ramp

    const actual = SHADES.map((shade) => {
      const match = css.match(new RegExp(`--color-accent-${shade}:\\s*(#[0-9a-fA-F]{3,8});`))
      return match?.[1]?.toLowerCase()
    })

    expect(actual).toEqual(expected.map((colour) => colour.toLowerCase()))
  })

  it('defines every shade the theme store will try to set', () => {
    for (const shade of SHADES) {
      expect(css).toContain(`--color-accent-${shade}:`)
    }
  })
})
