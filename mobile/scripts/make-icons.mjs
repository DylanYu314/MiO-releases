/**
 * Derive every app icon from one master mark.
 *
 *   node scripts/make-icons.mjs [path-to-mark.png]
 *
 * The master is `logo/mio-mark.png`: the MiO monogram, flat brand violet on a
 * genuinely transparent background, trimmed to its own bounding box. Everything
 * under `assets/` that shows the brand is generated from it, so a re-export
 * means running this once rather than editing five files by hand.
 *
 * ## ⚠️ Where the master came from, and why that matters
 *
 * I supplied `Mio_Logo.png`, a 2296x1618 PNG that **is not transparent**:
 * every pixel is opaque and the checkerboard is *painted into the image*, which
 * is what a design tool's transparency preview looks like when it is
 * screenshotted. Dropped straight into `assets/`, the launcher icon would have
 * been a grey checkerboard.
 *
 * The mark was recovered by keying on colour rather than on the pattern. The
 * background is neutral (R=G=B) and the mark is flat `#542D7E`, so `B - G`
 * recovers coverage — 0 on any grey square, 81 inside the mark — independently
 * of which checkerboard square a pixel happens to sit on. Anti-aliased edges
 * fall out of it as partial alpha, which is why the result has clean edges
 * rather than a halo.
 *
 * ⚠️ **It is still a recovery from a screenshot.** If a vector or a truly
 * transparent export ever appears, replace `logo/mio-mark.png` with it and run
 * this again; nothing else has to change.
 *
 * ## The sizes are not arbitrary
 *
 * `FOREGROUND_FRACTION` is 0.66 because Android masks an adaptive icon's
 * foreground to a shape it does not tell you in advance — only the inner ~66% of
 * the canvas is guaranteed to survive a circular mask. The flat `icon.png` is
 * not masked, so it can use more.
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const Jimp = require('jimp-compact')

const here = dirname(fileURLToPath(import.meta.url))
const MASTER = process.argv[2] ?? resolve(here, '../../logo/mio-mark.png')
const ASSETS = resolve(here, '../assets')
/** The web client's tab icon. Generated here rather than by hand because it is
 *  the same mark from the same master, and a second copy maintained separately
 *  is a copy that goes stale — `frontend/public/favicon.svg` shipped Vite's
 *  default lightning bolt from the first commit until #724 noticed. */
const WEB_PUBLIC = resolve(here, '../../frontend/public')

/** Black, per my 2026-08-20 decision: black ground, violet mark. */
const BACKGROUND = 0x000000ff
/** Guaranteed-visible portion of an adaptive icon's foreground. */
const FOREGROUND_FRACTION = 0.66
/** The flat icon is never masked, so the mark can be larger. */
const FLAT_FRACTION = 0.72

const mark = await Jimp.read(MASTER)
mkdirSync(ASSETS, { recursive: true })

/** The mark, scaled to occupy `fraction` of a `size` square, centred. */
function placed(size, fraction) {
  const scaled = mark.clone()
  const target = Math.round(size * fraction)
  if (scaled.bitmap.width >= scaled.bitmap.height) scaled.resize(target, Jimp.AUTO)
  else scaled.resize(Jimp.AUTO, target)
  return scaled
}

/** A plain ground — no mark. The adaptive icon's background layer is only ever
 *  a colour behind the foreground; compositing the mark into it too would draw
 *  the monogram twice, once unmasked. */
async function writePlain(name, size, background) {
  const file = `${ASSETS}/${name}`
  await new Jimp(size, size, background).writeAsync(file)
  console.log(`${name.padEnd(30)} ${size}x${size}  plain`)
}

async function write(name, size, fraction, background, silhouette = false, dir = ASSETS) {
  const canvas = new Jimp(size, size, background)
  const scaled = placed(size, fraction)
  if (silhouette) {
    // Themed icons are tinted by the launcher; only the alpha is read, so the
    // colour is flattened to black rather than left brand-coloured.
    scaled.scan(0, 0, scaled.bitmap.width, scaled.bitmap.height, function (x, y, idx) {
      this.bitmap.data[idx] = 0
      this.bitmap.data[idx + 1] = 0
      this.bitmap.data[idx + 2] = 0
    })
  }
  canvas.composite(
    scaled,
    Math.round((size - scaled.bitmap.width) / 2),
    Math.round((size - scaled.bitmap.height) / 2),
  )
  const file = `${dir}/${name}`
  await canvas.writeAsync(file)
  console.log(
    `${name.padEnd(30)} ${size}x${size}  mark ${scaled.bitmap.width}x${scaled.bitmap.height}`,
  )
}

console.log(`master ${mark.bitmap.width}x${mark.bitmap.height}\n`)
await write('icon.png', 1024, FLAT_FRACTION, BACKGROUND)
await write('android-icon-foreground.png', 1024, FOREGROUND_FRACTION, 0x00000000)
await writePlain('android-icon-background.png', 1024, BACKGROUND)
await write('android-icon-monochrome.png', 1024, FOREGROUND_FRACTION, 0x00000000, true)
await write('favicon.png', 96, FLAT_FRACTION, BACKGROUND)
// The launch screen's mark (#766).
//
// ⛔ Until then this file was **`create-expo-app`'s placeholder** — a faint grey
// grid-and-circles guide graphic on white — and it shipped in v1.0.0 and v1.0.1.
// Nothing referenced it from `app.json`, so nobody looked at it, and Android
// drew it as the launch window's background on any device whose vendor does not
// add the system icon layer. Huawei is one; that is why the launch screen there
// appeared to have no logo on it.
//
// Full bleed and transparent: `expo-splash-screen` scales this to its own
// `imageWidth` and composites it onto `backgroundColor`, so padding baked in
// here would only shrink the mark twice.
await write('splash-icon.png', 1024, 1, 0x00000000)
// The web tab icon, and the bookmark icon a phone uses (#767).
//
// ⛔ **Full bleed and transparent, unlike every Android icon above.** Those are
// launcher icons: Android composites them onto its own ground and masks them to
// a shape, so they need a black square and room to be clipped. A favicon is
// none of those things. Drawn at 72% inside a black square, and with a master
// wider than it is tall, the mark landed 46x38 in a 64 px box — at the 16 px a
// browser actually renders, a black tile with something in the middle of it.
//
// ⚠️ The transparent ground is not only cosmetic: a browser tab strip is light
// or dark depending on the theme, and the mark clears 4.5:1 on both
// (4.96:1 on black, 4.23:1 on white). A black tile clears neither.
mkdirSync(WEB_PUBLIC, { recursive: true })
// 128, not 64: browsers pick this for pinned tabs and shortcuts too, and it is
// downscaled for the tab. Still under 8 KB.
await write('favicon.png', 128, 1, 0x00000000, false, WEB_PUBLIC)
// What iOS and Android use when a page is saved to the home screen. 180 is
// Apple's size; anything smaller is upscaled and looks it.
await write('apple-touch-icon.png', 180, 1, 0x00000000, false, WEB_PUBLIC)
