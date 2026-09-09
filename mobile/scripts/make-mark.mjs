/** Re-cut the master mark as treatment E (#724): violet ramp[5] fill with a
 *  ramp[10] keyline.
 *
 *  ⚠️ Written as **two flat RGB values with the shape in alpha**, exactly like
 *  the mark it replaces. The obvious build — stamp the keyline, composite the
 *  fill over it — blends the two at their boundary and produced 477 distinct
 *  RGB values and a 2.5 MB file, five times the repo's 500 KB limit. The old
 *  master is 294 KB because it has *one* colour and varies only alpha.
 *
 *  So the inner boundary is hard here, and anti-aliasing comes from
 *  downsampling: `make-icons.mjs` scales this to at most 737 px, so a 1-px
 *  master edge lands as ~2.5 px of blend in every icon.
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const Jimp = require('jimp-compact')

const [SRC, DEST] = process.argv.slice(2)
const FILL = [0x8b, 0x5c, 0xf6] // violet ramp[5] — 4.96:1 on black, 4.23:1 on white
const KEYLINE = [0x2e, 0x10, 0x65] // violet ramp[10]
const KEYLINE_FRACTION = 0.0135

const mark = await Jimp.read(SRC)
const w = mark.bitmap.width
const h = mark.bitmap.height
const width = Math.max(2, Math.round(Math.max(w, h) * KEYLINE_FRACTION))
const pad = width + 2
const W = w + pad * 2
const H = h + pad * 2

/** Source alpha at (x, y) in the padded canvas, 0 outside it. */
const src = mark.bitmap.data
const alphaAt = (x, y) => {
  const sx = x - pad
  const sy = y - pad
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return 0
  return src[(sy * w + sx) * 4 + 3]
}

/*
 * ⚠️ The keyline is dilated from a **thresholded** copy, not from the source's
 * own alpha.
 *
 * Taking a max of the source alpha over a ring means a pixel in the middle of
 * the band often only reaches the source's *anti-aliased edge*, so it inherits
 * a partial value. That is wrong twice: it makes the keyline semi-transparent —
 * visibly washed out over black — and it left 1,010,964 partial-alpha pixels
 * against the old master's 216,214, which is why the file came out at 1.2 MB.
 *
 * Thresholding first makes the band uniformly opaque. The edges are then hard
 * at this resolution and resolve by downsampling: `make-icons.mjs` never draws
 * the mark above 737 px, so every icon supersamples this by 2.5x.
 */
const solid = (x, y) => (alphaAt(x, y) >= 128 ? 255 : 0)

const ring = []
for (let i = 0; i < 96; i++) {
  const a = (i / 96) * Math.PI * 2
  ring.push([Math.round(Math.cos(a) * width), Math.round(Math.sin(a) * width)])
}

const out = new Jimp(W, H, 0x00000000)
const dst = out.bitmap.data
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const inner = solid(x, y)
    let covered = inner === 255
    if (!covered) {
      for (const [dx, dy] of ring) {
        if (solid(x + dx, y + dy) === 255) {
          covered = true
          break
        }
      }
    }
    if (!covered) continue
    const i = (y * W + x) * 4
    const c = inner === 255 ? FILL : KEYLINE
    dst[i] = c[0]
    dst[i + 1] = c[1]
    dst[i + 2] = c[2]
    dst[i + 3] = 255
  }
}

out.deflateLevel(9)
await out.writeAsync(DEST)

const seen = new Set()
out.scan(0, 0, W, H, function (x, y, i) {
  if (this.bitmap.data[i + 3] > 0)
    seen.add((this.bitmap.data[i] << 16) | (this.bitmap.data[i + 1] << 8) | this.bitmap.data[i + 2])
})
console.log(`${W}x${H}  keyline ${width}px  distinct RGB ${seen.size}`)
