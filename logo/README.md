# Logo

`mio-mark.png` is the **master**: the MiO monogram in violet ramp[5]
`#8B5CF6` with a ramp[10] `#2E1065` keyline, genuinely transparent, trimmed to
its own bounding box plus the keyline (1835×1506). Every app icon under
`mobile/assets/` **and the web client's `favicon.png`** are generated from it:

```bash
cd mobile && node scripts/make-icons.mjs
```

## The keyline, and why the colours changed (#724)

Until 2026-09-07 the mark was flat `#542D7E` with no keyline. My report was
that it did not stand out on the black icon ground, and the measurement agreed:
**2.05:1**, which this file previously recorded as a deliberate look.

`scripts/make-mark.mjs` applies the treatment, so it can be re-applied to any
future export rather than being a one-off edit:

```bash
cd mobile && node scripts/make-mark.mjs ../logo/<new-export>.png ../logo/mio-mark.png
```

| | value | on black | on white |
|---|---|---|---|
| fill | `#8B5CF6` (violet ramp[5]) | **4.96:1** | **4.23:1** |
| keyline | `#2E1065` (violet ramp[10]) | — | — |

⚠️ **`#8B5CF6` is the only step on the ramp that separates on both grounds**, which
is what one mark serving the launcher (black), the web client and the download
page requires. `#542D7E` was 10.23:1 on white and 2.05:1 on black.

⚠️ **The master is two flat RGB values with the shape in alpha, and the inner
edge is hard.** That is deliberate. Building it the obvious way — stamp the
keyline, composite the fill over it — blends the two colours at their boundary,
which produced **477 distinct RGB values and a 2.5 MB file**, five times the
repo's 500 KB pre-commit limit. Dilating from a *thresholded* copy instead keeps
it at two colours and **49 KB**, and anti-aliasing comes from downsampling:
`make-icons.mjs` never draws the mark above 737 px, so every icon supersamples
this by 2.5x.

⛔ **A first attempt also made the keyline semi-transparent.** Taking a max of
the *source* alpha over a ring means a pixel mid-band often only reaches the
mark's anti-aliased edge and inherits a partial value — a washed-out keyline
over black, and 1,010,964 partial-alpha pixels against the old master's 216,214.
Threshold before dilating.

## ⚠️ Where the master came from

I supplied `Mio_Logo.png` (2296×1618, 2.8 MB) on 2026-08-20. **It is not
transparent** — every pixel is opaque and the checkerboard is *painted into the
image*, which is what a design tool's transparency preview looks like when it is
screenshotted. Dropped straight into `assets/`, the launcher icon would have been
a grey checkerboard.

The mark was recovered by keying on **colour**, not on the pattern: the
background is neutral (R = G = B) and the mark is flat `#542D7E`, so `B - G` is
0 on any grey square and 81 inside the mark, whichever checkerboard square a
pixel sits on. Anti-aliased edges fall out as partial alpha, which is why the
result has clean edges rather than a halo.

⚠️ **It is still a recovery from a screenshot.** If a vector or a truly
transparent export appears, replace `mio-mark.png` with it and re-run the
generator — nothing else has to change.

⚠️ `Mio_Logo.png` itself is **not committed**: it is 2.8 MB, over the repo's
500 KB pre-commit limit, and it is superseded by the master beside it. It is in
`.gitignore` since #724 — it sat untracked *and* unignored for weeks, one
`git add .` from being committed.

## The icon

Black ground, violet mark — my decision, 2026-08-20; the fill and keyline
changed 2026-09-07 (#724), the black ground did not.

The mark now measures **4.96:1** against black, up from 2.05:1. The monochrome
variant Android uses for themed icons reads only alpha, so it carries the
dilated silhouette — very slightly fatter than before, which is the keyline.

⛔ **Changing this master is a native change and needs a build.** Measured:
regenerating the icons moved the Android fingerprint
`681661688a2e` → `b93c7a86`, so it is not shippable over the air, and it blocks
every pending JavaScript update until a build catches up.
