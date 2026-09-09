# ADR-008: Internationalization with i18next

## Status

Accepted — 2026-07-23

## Context

The Enhancement Track needs the UI to support multiple languages (English,
Chinese, Russian, Spanish over time). Today every string is hardcoded English
inline in JSX, and there is no i18n library.

The order of operations matters more than the choice of library. If i18n lands
*late*, every string written between now and then accrues as untranslated
English that must be found and externalized in one painful pass. If it lands
*early*, each new string is externalized as it is written. So this is a Wave-A
foundation, deliberately ahead of the feature PRs that will add most of the new
copy.

The decision on scope was made when planning the track: **scaffold now and ship
English + Chinese**; Russian and Spanish become catalogue fill-in later. A2 (this
PR) proves the pipeline by externalizing the nav labels and the import/match
status maps — not the whole app.

## Decision

**`i18next` + `react-i18next` + the browser language detector.** This is the
dominant React i18n stack; `react-i18next` gives components a `useTranslation()`
hook returning `t()`, and i18next handles fallback, interpolation and plural
rules (which matter for counts like "N songs" — done through i18next plurals,
never string concatenation).

**Resources are bundled, not fetched.** The `en` and `zh` catalogues are
imported as JSON and passed to `init()` directly, so initialization is
synchronous. Components — and tests — can call `t()` immediately with no loading
state or Suspense boundary. (When the app later warrants code-splitting, the
catalogues can move to lazily-loaded namespaces; that is a bundle optimisation,
not a correctness change.)

**Language is detected, then persisted.** The detector reads `localStorage`
first, then the browser's `navigator` language, and writes the choice back to
`localStorage` so it survives reload. A base-language fallback
(`nonExplicitSupportedLngs`) maps e.g. `en-GB` → `en`. The chosen language is
mirrored onto `<html lang>` for accessibility and CSS.

**A single default namespace with nested keys** (`nav.*`, `importStatus.*`,
`matchStatus.*`, …) rather than many namespaces. It keeps call sites simple
(`t('nav.library')`) and, since resources are bundled anyway, namespace-splitting
would buy nothing yet.

**English catalogue values are the exact current strings**, so externalizing
them is behaviour-neutral and the existing tests (which assert on English copy)
keep passing.

## Consequences

**Good:**

- Every string added from here on is externalized at birth — no retro-translation
  pass.
- Adding Russian and Spanish later is a pure content task: new `locales/*.json`
  files, no code change.
- Language persists across reloads and drives `<html lang>` correctly.
- Synchronous, bundled init means no async/Suspense complexity in components or
  tests.

**Trade-offs / risks:**

- i18next adds ~55 KB (gzip) to the bundle. Acceptable for the reach; revisit
  with code-splitting if it matters.
- Bundling all catalogues means every language ships to every user. Fine at two
  languages; a lazy-namespace split is the escape hatch when it grows.
- Externalization is incremental — until every string is migrated, some inline
  English remains. New PRs must not add inline copy (a track convention), and
  existing strings are converted as their components are touched.
- A stray untranslated string renders as its key (e.g. `nav.library`), which is
  visible but not fatal — the fallback returns the key, not a blank.

## Related

- ADR-003: Frontend architecture
- The Enhancement Track plan (A2 scaffold; A6 moves the language switcher into
  the settings page)
