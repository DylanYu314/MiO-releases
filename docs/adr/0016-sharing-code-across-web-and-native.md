# ADR-016 — Sharing code between the web client and the Android app

## Status

Accepted — 2026-07-25 (Phase 5, slice P2)

## Context

Phase 5 adds `mobile/` beside the existing `frontend/`. Two things are genuinely
common to both and must not be allowed to diverge:

- **The i18n catalogue.** Wave D's whole point was that a half-translated app is
  worse than an untranslated one, and it left a parity guard
  (`frontend/src/i18n/parity.test.ts`) plus an ESLint rule banning literal JSX
  strings. Two copies of `en.json` would defeat both — the guard would compare a
  file against itself while the other platform quietly drifted.
- **The design tokens (ADR-007).** These were *claimed* to be shareable, but
  were not: the accent ramps lived in `frontend/src/theme/store.ts` as
  TypeScript, and the default ramp was **also** hardcoded as CSS custom
  properties in `frontend/src/index.css`. React Native has no CSS, so neither
  form was usable from the app, and the two web copies could already drift from
  each other.

The repo layout decision (`mobile/` + `shared/`, not npm workspaces) was made
before this slice. What remained was *how* two different bundlers — Vite and
Metro — actually resolve a directory that sits outside both projects.

## Decision

**`shared/` is a real local package, `@mio/shared`, installed by both clients
through a `file:` dependency.** Both import it by name:

```ts
import { ACCENT_PRESETS } from '@mio/shared/tokens'
import en from '@mio/shared/i18n/en.json'
```

`npm install ../shared` symlinks it into each client's `node_modules`, so it
resolves through ordinary Node module resolution and needs no bundler
configuration on either side.

It holds exactly two things: `tokens.ts` and `i18n/*.json`. Component code is
**not** shared — React DOM and React Native primitives are rebuilt per platform,
as ADR-003 and the phase plan already state.

### Why not relative imports across the root

That was tried first, and it works on the web (Vite resolves `../../../shared`
without complaint) but **fails in Metro**, which only resolves files under its
project root. The failure is worth recording because of *when* it appears:

`tsc --noEmit` passed. `jest` passed. `eslint` passed. The bundle failed:

```
Unable to resolve module ../../shared/tokens from mobile/app/index.tsx
```

Jest uses its own resolver, so it is no evidence at all about Metro. Only
`expo export` tells the truth — the same lesson P1 learned when a co-located
test file broke the bundle while every other check was green.

Adding `watchFolders` and `resolver.extraNodeModules` to `metro.config.js` did
**not** fix it. The config was confirmed loaded, and Metro's error showed it
searching the correct absolute path and still not finding the file. Rather than
keep tuning bundler internals, the `file:` dependency sidesteps the question:
a symlinked package inside `node_modules` is a path Metro already understands.

**`mobile/metro.config.js` was then deleted**, because the default Expo config
is sufficient once the package resolves normally, and a config file that is not
needed is one more thing to mislead the next reader.

### Why the CSS ramp is a test rather than a build step

`index.css` must keep its hardcoded default ramp: those values have to exist
before any JavaScript runs, or the pre-paint script in `index.html` flashes the
wrong accent. A stylesheet cannot import from TypeScript, so that one value is
unavoidably written twice.

Generating the CSS from the tokens would remove the duplication but adds a build
step to the web client for a single 11-value list. Instead
`frontend/src/theme/tokens.test.ts` reads `index.css` (via Vite's `?raw`) and
asserts it matches `ACCENT_PRESETS[DEFAULT_ACCENT].ramp` shade for shade.
Cheaper, and it fails loudly on drift — verified by changing one hex value and
watching it go red.

## Consequences

- A change to a translation key or an accent ramp lands in **one** place and
  both clients see it. The Wave-D parity guard now covers the app too.
- **Sharing cuts both ways: a change made for one client can break the other.**
  Hit for real in P4 — adding the app's library strings overwrote three keys the
  web client was already using, including one whose `{{message}}` placeholder it
  depended on. Nothing about the JSON was invalid and the EN/ZH parity guard was
  perfectly happy, because parity is about the two languages agreeing, not about
  a key keeping its meaning. What caught it was **the web test suite**, which CI
  runs on every PR regardless of which client the change was for. The working
  rule: when adding a string, add a *new* key rather than reusing a plausible
  name, and read what is already there first.
- `shared/` must stay **platform-neutral**: no DOM, no React Native, no
  browser or Expo APIs. It is data and types. Anything platform-specific
  belongs in the client that needs it — which is why language *detection*
  differs (browser/localStorage on the web, `expo-localization` on the app)
  while the catalogues do not.
- `file:` dependencies are symlinks, so an edit in `shared/` is picked up
  immediately by both clients with no rebuild or reinstall.
- Both `package-lock.json` files now reference `../shared`. A clone must run
  `npm ci` in each client as before; nothing new is required.
- This is deliberately *not* npm workspaces. Workspaces would be the tidier
  answer at more packages, and this can become that later without changing a
  single import statement — the specifier `@mio/shared` stays valid either way.

## Related

- ADR-003 — frontend architecture (what is rebuilt per platform, and why)
- ADR-007 — theme tokens and dark mode (the tokens this slice extracted)
- ADR-008 — internationalization (the catalogue and its parity guard)
- ADR-015 — Android app architecture
- The phase plan
