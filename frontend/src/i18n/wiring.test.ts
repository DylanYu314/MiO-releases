import { describe, expect, it } from 'vitest'

import i18n, { SUPPORTED_LANGUAGES } from './index'

/**
 * Every language the switcher offers must actually be loaded.
 *
 * The web mirror of `mobile/__tests__/languageWiring.test.ts`, and the reason
 * is the same: `resources` is a free-form object, so dropping one entry while
 * leaving the language in {@link SUPPORTED_LANGUAGES} typechecks clean and
 * renders English (#519, measured on the mobile side). `parity.test.ts` next
 * door reads the catalogue *files* and never looks at the wiring — both halves
 * passing while the join is missing is #655's shape.
 */
describe('language wiring', () => {
  // The control: every check below loops over SUPPORTED_LANGUAGES, so an empty
  // list would make them all pass having read nothing.
  it('offers more than one language, without which the checks below are vacuous', () => {
    expect(SUPPORTED_LANGUAGES.length).toBeGreaterThanOrEqual(2)
    expect(SUPPORTED_LANGUAGES.map((language) => language.code)).toContain('en')
  })

  it.each(SUPPORTED_LANGUAGES.map((language) => [language.code, language.label]))(
    'has a loaded catalogue for %s (%s)',
    (code) => {
      const bundle = i18n.getResourceBundle(code, 'translation') as
        Record<string, unknown> | undefined
      expect(bundle).toBeDefined()
      expect(Object.keys(bundle ?? {}).length).toBeGreaterThan(0)
    },
  )

  it.each(SUPPORTED_LANGUAGES.map((language) => [language.code]))(
    'resolves %s from its own catalogue rather than falling back to English',
    (code) => {
      const value = i18n.getFixedT(code)('nav.library')
      const english = i18n.getFixedT('en')('nav.library')
      expect(value).not.toBe('')
      if (code !== 'en') expect(value).not.toBe(english)
    },
  )

  it('declares every offered language as supported to i18next', () => {
    // `supportedLngs` is what stops i18next resolving a language it has no
    // bundle for; i18next appends 'cimode', which is its own dev switch.
    const declared = new Set(i18n.options.supportedLngs || [])
    for (const { code } of SUPPORTED_LANGUAGES) expect(declared).toContain(code)
  })
})
