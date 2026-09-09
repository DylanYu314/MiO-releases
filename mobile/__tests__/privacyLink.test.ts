import { readFileSync } from 'fs'
import { join } from 'path'

import { PRIVACY_URL } from '../src/legal'

const SETTINGS = join(__dirname, '..', 'app', '(tabs)', 'settings.tsx')
const LANGS = ['en', 'zh', 'es', 'fr', 'ja', 'ko', 'ru'] as const

/**
 * #513 asked for the published privacy policy to be reachable from inside the
 * app. It was published on the web on 2026-08-21 and **linked from nowhere** —
 * a grep of `mobile/` for the domain returned no hits at all for twelve days.
 *
 * ⚠️ These read source rather than rendering, deliberately. Rendering Settings
 * needs the theme store, the player store, the updates hook and the onboarding
 * store, so a failure there is ambiguous; and the property that matters is not
 * "a button appears" but "the app points at the real published page in every
 * language it ships". Source is where that is decidable.
 */
describe('the privacy policy is reachable from the app (#513)', () => {
  const settings = readFileSync(SETTINGS, 'utf8')

  it('points at the published policy, not a placeholder', () => {
    expect(PRIVACY_URL).toBe('https://mio.dlany.uk/privacy/')
  })

  it('is linked from Settings', () => {
    // The import and the use, separately: importing the constant without
    // rendering it would satisfy a laxer check while linking nothing.
    expect(settings).toContain("from '../../src/legal'")
    expect(settings).toContain('PRIVACY_URL')
    expect(settings).toContain("t('settings.openPrivacyPolicy')")
  })

  it('does not open the link with a bare void', () => {
    // ⚠️ An Android with no browser throws. DonateCard's first version used a
    // bare `void` and would have shipped a silently dead button; the same trap
    // is one keystroke away here.
    expect(settings).toContain("logWarn('privacy.openFailed'")
    expect(settings).toContain("showToast(t('settings.linkFailed'))")
  })

  it.each(LANGS)('has all four strings in %s', (lang) => {
    const cat = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'shared', 'i18n', `${lang}.json`), 'utf8'),
    ) as { settings: Record<string, string> }

    for (const key of ['privacy', 'privacyDescription', 'openPrivacyPolicy', 'linkFailed']) {
      expect(typeof cat.settings[key]).toBe('string')
      expect(cat.settings[key].length).toBeGreaterThan(0)
    }

    // ⚠️ Control. Without it this passes just as well against a catalogue that
    // copied English into every language — which is exactly the #557/#695
    // failure, where the app silently rendered English and every tool agreed.
    if (lang !== 'en') {
      const en = JSON.parse(
        readFileSync(join(__dirname, '..', '..', 'shared', 'i18n', 'en.json'), 'utf8'),
      ) as { settings: Record<string, string> }
      expect(cat.settings.openPrivacyPolicy).not.toBe(en.settings.openPrivacyPolicy)
    }
  })
})
