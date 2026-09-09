# ADR-007: Theme tokens and a class-based dark mode

## Status

Accepted — 2026-07-23

## Context

The Enhancement Track (a pre-Phase-5 UX pass) needs users to be able to change
the app's accent colour and switch light/dark themes. The current frontend
supports neither, and the reasons are structural:

- `src/index.css` is a single line, `@import 'tailwindcss';`. There is no
  design-token layer. The accent colour is the literal utility `indigo-*`
  repeated in ~65 places (primary buttons, links, active nav, progress fills,
  slider accents, current-row borders). Changing the accent means editing 65
  sites, and nothing can change it at runtime.
- Dark mode is driven entirely by `@media (prefers-color-scheme: dark)` — the
  default behaviour of Tailwind's `dark:` variant. It follows the operating
  system and the user cannot override it in the app.

Both of these have to change before a settings-based theme picker (a later PR)
is even possible. This ADR covers the foundation only; the picker UI comes
later.

A hard requirement: **no visual change on first load.** This is a large,
mechanical change touching a lot of markup, and it must be provably neutral so
the risky part (the token wiring) is separable from the cosmetic part (my
future brand palette).

## Decision

**Semantic accent tokens via Tailwind v4 `@theme`.** `src/index.css` defines an
`accent` colour ramp (`--color-accent-50` … `--color-accent-950`) inside an
`@theme` block, which makes Tailwind generate `accent-*` utilities backed by CSS
custom properties. The ramp's initial values are exactly Tailwind's `indigo`
palette, so the app looks identical. Because the utilities compile to
`var(--color-accent-600)` etc., a later settings screen can re-theme the whole
app by overriding those variables at runtime — no rebuild, no per-component
edits.

**Class-based dark mode.** A `@custom-variant dark (&:where(.dark, .dark *))`
switches every existing `dark:` utility from the `prefers-color-scheme` media
query to a `.dark` class on the root element. This is what makes a manual
light/dark toggle possible.

**A pre-paint script preserves current behaviour and avoids a flash.** A tiny
inline script in `index.html` runs before the stylesheet paints. It reads the
stored preference (defaulting to `"system"`) and, for `"system"`, applies `.dark`
when the OS prefers dark. So a user on a dark-themed OS still sees dark on first
load — no regression — and any future stored choice is honoured without a
flash of the wrong theme (the classic FOUC that appears when theme is applied by
React after hydration).

**The ~65 `indigo-*` utilities become `accent-*`** in one mechanical pass. The
two slider cases (`accent-indigo-600`, the CSS `accent-color` utility) become
`accent-accent-600`, which is correct if ugly (`accent-color: var(--color-accent-600)`).

## Consequences

**Good:**

- The accent colour is one place (the token ramp), changeable at runtime — the
  precondition for the user-facing theme picker.
- Dark mode can be toggled and persisted, rather than being dictated by the OS.
- Shipping with indigo values means this large diff is provably cosmetic-neutral;
  My brand palette is a later one-line swap of the ramp values.
- The pre-paint script means no flash of the wrong theme, and no first-load
  regression for dark-OS users.

**Trade-offs / risks:**

- The `@theme` / `@custom-variant` syntax is specific to Tailwind v4; it is
  pinned here (v4.3) and would need revisiting on a major upgrade.
- A missed `indigo-*` occurrence would leave a stray hardcoded accent that the
  theme picker can't reach — the rename is grep-verified to catch this.
- Switching to a `.dark` class means the root element's class is now
  load-bearing; the pre-paint script must set it correctly or dark-OS users
  regress to light. This is why it defaults to `"system"`.
- User-chosen accents must stay within a curated, contrast-checked set (a later
  PR) rather than a free colour wheel, to keep text legible on both themes.

## Related

- ADR-003: Frontend architecture (Tailwind v4, CSS-first)
- The Enhancement Track plan (A1 foundation; A6 builds the picker on top)
