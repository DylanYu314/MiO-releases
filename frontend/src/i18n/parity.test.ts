import { describe, expect, it } from 'vitest'

type Catalogue = Record<string, unknown>

/**
 * Every catalogue in `shared/i18n`, discovered rather than listed (#519).
 *
 * ⚠️ **This file used to import `en` and `zh` by name.** Adding `ja.json`
 * would then have been covered by nothing: a missing key in the new catalogue
 * would pass CI silently, which is the failure a parity guard exists to
 * prevent. Directory-driven is the same answer #561 needed, where a listing
 * built from the filesystem found an offender three device passes had missed.
 *
 * `import.meta.glob` needs a literal relative path — it is resolved by Vite at
 * build time, so the `@mio/shared` alias cannot be used here.
 */
const modules = import.meta.glob('../../../shared/i18n/*.json', { eager: true }) as Record<
  string,
  { default: Catalogue }
>

const catalogues: ReadonlyArray<readonly [string, Catalogue]> = Object.entries(modules)
  .map(([path, module]) => [/([^/]+)\.json$/.exec(path)?.[1] ?? path, module.default] as const)
  .sort(([a], [b]) => a.localeCompare(b))

/** The catalogue every other one is compared against. */
const BASE = 'en'

function catalogueFor(language: string): Catalogue {
  const found = catalogues.find(([name]) => name === language)
  if (!found) throw new Error(`No ${language}.json in shared/i18n`)
  return found[1]
}

const base = catalogueFor(BASE)
const translations = catalogues.filter(([name]) => name !== BASE)

/**
 * Plural suffixes are stripped before comparing, because CLDR plural categories
 * legitimately differ per language: English needs `_one` and `_other`, Chinese
 * has only `_other`. Comparing raw keys would demand a redundant `_one` in
 * Chinese, so the base key is what has to match.
 *
 * ⚠️ **That is true of CLDR and false of the phone (#557).** Hermes does not
 * give i18next a usable `Intl.PluralRules`, and i18next's fallback for a code
 * with no region is `dummyRule` — `count === 1 ? 'one' : 'other'`, English's
 * shape applied to every language (`i18next.js`, `getRule`). So on Android a
 * Chinese string with a count of exactly **1** asks for `_one`, does not find
 * it, and falls back to the English catalogue. It shipped: 29 keys did this,
 * including the import screen's own download button.
 *
 * Hence {@link pluralFormsMissingIn} below, which requires the redundant
 * form this comment once argued against. The redundancy is the price of the
 * runtime being wrong, and a guard is what keeps it from silently returning.
 */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

function collectKeys(node: unknown, prefix = ''): Set<string> {
  const keys = new Set<string>()
  if (node === null || typeof node !== 'object') return keys

  for (const [key, value] of Object.entries(node as Catalogue)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object') {
      for (const nested of collectKeys(value, path)) keys.add(nested)
    } else {
      keys.add(path.replace(PLURAL_SUFFIX, ''))
    }
  }
  return keys
}

/** Every plural key must carry the `_other` category, which every language has. */
function pluralBasesMissingOther(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return []

  const missing: string[] = []
  const entries = Object.entries(node as Catalogue)
  const bases = new Set<string>()

  for (const [key, value] of entries) {
    if (value !== null && typeof value === 'object') {
      missing.push(...pluralBasesMissingOther(value, prefix ? `${prefix}.${key}` : key))
    } else if (PLURAL_SUFFIX.test(key)) {
      bases.add(key.replace(PLURAL_SUFFIX, ''))
    }
  }

  const present = new Set(entries.map(([key]) => key))
  for (const base of bases) {
    if (!present.has(`${base}_other`)) {
      missing.push(prefix ? `${prefix}.${base}` : base)
    }
  }
  return missing
}

/**
 * Every plural form the base catalogue defines must exist in a translation.
 *
 * Not a CLDR requirement — a Hermes one. See the note on {@link PLURAL_SUFFIX}.
 * Compared against *the base's* forms rather than a fixed list, so a key that
 * gains `_zero` or `_few` later is covered without editing this.
 */
function pluralFormsMissingIn(e: unknown, z: unknown, prefix = ''): string[] {
  if (e === null || typeof e !== 'object') return []

  const missing: string[] = []
  const zNode = (z ?? {}) as Catalogue
  for (const [key, value] of Object.entries(e as Catalogue)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object') {
      missing.push(...pluralFormsMissingIn(value, zNode[key], path))
    } else if (PLURAL_SUFFIX.test(key) && !(key in zNode)) {
      missing.push(path)
    }
  }
  return missing
}

/**
 * Every plural category *this language* has, for a base English pluralises.
 *
 * The mirror of {@link pluralFormsMissingIn}, which only demands the forms
 * English itself has. That is enough for Chinese, Spanish, French, Japanese
 * and Korean, whose categories are a subset of English's — and **not** enough
 * for Russian, which adds `few` (2–4) and `many` (0, 5–20).
 *
 * ⚠️ **A missing category does not degrade to `_other`; it degrades to
 * English.** i18next builds `[key, key + suffix]` and pops from the end, so a
 * lookup for `songCount_few` that misses tries the bare `songCount`, misses
 * again, and moves on to the next language in the resolve hierarchy — the
 * fallback (`i18next.js`, `resolve()`). Measured, with a control: with
 * `_few`/`_many` stripped, `ru` renders "2 songs" and "5 songs"; with them,
 * "2 песни" and "5 песен".
 *
 * Nothing enforced this before, and #519's mutation pass found it — deleting
 * `songCount_few` killed no test while breaking the web app. A documented
 * invariant that nothing enforces is not an invariant.
 */
function cldrFormsMissingIn(language: string, base: Catalogue, catalogue: Catalogue): string[] {
  const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories
  const missing: string[] = []

  const walk = (englishNode: unknown, node: unknown, prefix = ''): void => {
    if (englishNode === null || typeof englishNode !== 'object') return
    const other = (node ?? {}) as Catalogue
    const bases = new Set<string>()
    for (const [key, value] of Object.entries(englishNode as Catalogue)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (value !== null && typeof value === 'object') walk(value, other[key], path)
      else if (PLURAL_SUFFIX.test(key)) bases.add(key.replace(PLURAL_SUFFIX, ''))
    }
    for (const pluralBase of bases) {
      for (const category of categories) {
        const key = `${pluralBase}_${category}`
        if (!(key in other)) missing.push(prefix ? `${prefix}.${key}` : key)
      }
    }
  }

  walk(base, catalogue)
  return missing
}

describe('translation catalogues', () => {
  /*
   * ⚠️ The control, and it has to come first. Every test below is `it.each`
   * over a discovered list — so if the glob ever resolves to nothing, they all
   * pass **vacuously** and the guard reports success while checking no files
   * at all. This is the assertion that cannot be satisfied by an empty set.
   */
  it('discovers the catalogues on disk, including the base', () => {
    const names = catalogues.map(([name]) => name)
    expect(names).toContain(BASE)
    expect(names.length).toBeGreaterThanOrEqual(2)
  })

  /*
   * ⚠️ The second control. `cldrFormsMissingIn` asks `Intl.PluralRules` which
   * categories a language has; an environment answering `['other']` for
   * everything would make that test pass against any catalogue at all. Node's
   * `Intl` is complete — this is the assertion that says so out loud, and it
   * is the one runtime difference #557 was about, pointing the other way.
   */
  it('has a complete Intl.PluralRules, without which the CLDR check is vacuous', () => {
    expect(new Intl.PluralRules('ru').resolvedOptions().pluralCategories.sort()).toEqual([
      'few',
      'many',
      'one',
      'other',
    ])
    expect(new Intl.PluralRules('ja').resolvedOptions().pluralCategories).toEqual(['other'])
  })

  it.each(translations)(
    'gives %s every plural category its own language has, not only English\u2019s',
    (name, catalogue) => {
      // Russian needs `_few` and `_many`; without them the web renders the
      // English string, not the `_other` one. See cldrFormsMissingIn.
      expect(cldrFormsMissingIn(name, base, catalogue)).toEqual([])
    },
  )

  it.each(translations)('has a %s translation for every English key', (_name, catalogue) => {
    const baseKeys = collectKeys(base)
    const keys = collectKeys(catalogue)
    const missing = [...baseKeys].filter((key) => !keys.has(key)).sort()
    expect(missing).toEqual([])
  })

  it.each(translations)('has no %s keys that English is missing', (_name, catalogue) => {
    const baseKeys = collectKeys(base)
    const keys = collectKeys(catalogue)
    const extra = [...keys].filter((key) => !baseKeys.has(key)).sort()
    expect(extra).toEqual([])
  })

  it.each(catalogues)('gives every plural key an _other form in %s', (_name, catalogue) => {
    expect(pluralBasesMissingOther(catalogue)).toEqual([])
  })

  it.each(translations)(
    'gives %s every plural form English has, so the phone cannot fall back',
    (_name, catalogue) => {
      // A count of exactly 1 asks for `_one` on Android whatever CLDR says.
      // Without this, 29 Chinese strings rendered in English and every test
      // passed — Node's `Intl.PluralRules` is complete, so jest cannot see it
      // (#557).
      expect(pluralFormsMissingIn(base, catalogue)).toEqual([])
    },
  )

  it.each(catalogues)('has no empty strings in %s', (_name, catalogue) => {
    const empties: string[] = []
    const walk = (node: unknown, prefix = ''): void => {
      if (node === null || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node as Catalogue)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (value !== null && typeof value === 'object') walk(value, path)
        else if (typeof value === 'string' && value.trim() === '') empties.push(path)
      }
    }
    walk(catalogue)
    expect(empties).toEqual([])
  })
})
