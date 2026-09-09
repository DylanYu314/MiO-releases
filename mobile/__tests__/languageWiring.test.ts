import i18n, { MACHINE_TRANSLATED, SUPPORTED_LANGUAGES } from '../src/i18n'

/**
 * Every language the picker offers must actually be loaded.
 *
 * ⚠️ **Nothing caught this before, and it was measured rather than assumed
 * (#519).** Removing `ja: { translation: ja }` from `i18n.init`'s `resources`
 * while leaving `{ code: 'ja' }` in {@link SUPPORTED_LANGUAGES} produced:
 * `tsc --noEmit` clean, eslint clean apart from an unused-import **warning**,
 * and **2113 of 2113 tests passing**. The app would list 日本語 in Settings,
 * and render English when you chose it.
 *
 * That is #557's failure exactly — a language silently falling back — one
 * level up: #557 was a missing plural *form*, this is a missing whole
 * *catalogue*. `resources` is a free-form object, so the type system has
 * nothing to check it against, and the parity guard in
 * `frontend/src/i18n/parity.test.ts` reads catalogue *files* and never looks
 * at the wiring. Both halves passed while the join was missing (#655).
 *
 * The picker is the list a user sees, so it is the list that has to be true.
 */
describe('language wiring', () => {
  /*
   * ⚠️ The control, and it must come first. Every assertion below is a loop
   * over `SUPPORTED_LANGUAGES`; if that list were ever empty they would all
   * pass having checked nothing. This is the assertion an empty list cannot
   * satisfy.
   */
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
      // `nav.library` is translated in every catalogue, so an English answer
      // for a non-English language means the bundle was not reached. Read
      // through i18next rather than off the JSON, because the fallback is
      // i18next's behaviour and reading the file would step around it.
      const value = i18n.getFixedT(code)('nav.library')
      const english = i18n.getFixedT('en')('nav.library')
      expect(typeof value).toBe('string')
      expect(value).not.toBe('')
      if (code !== 'en') expect(value).not.toBe(english)
    },
  )

  it('names only supported languages as machine-translated', () => {
    const codes = new Set<string>(SUPPORTED_LANGUAGES.map((language) => language.code))
    // A code left behind after a language is removed would put an unexplained
    // note under the picker for nobody, or none for somebody.
    for (const code of MACHINE_TRANSLATED) expect(codes).toContain(code)
    // English and Chinese are my own languages and are not machine work.
    expect(MACHINE_TRANSLATED.has('en')).toBe(false)
    expect(MACHINE_TRANSLATED.has('zh')).toBe(false)
  })
})
