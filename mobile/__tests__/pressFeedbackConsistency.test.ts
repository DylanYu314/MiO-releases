import fs from 'node:fs'
import path from 'node:path'

/**
 * One pressed colour, across the whole app (#378).
 *
 * The issue's own diagnosis: *"Doing it screen by screen is how the app ended up
 * inconsistent."* `Button` and `Chip` cannot drift, because a screen cannot
 * restyle them. Rows and icon buttons can — each screen keeps its own
 * `StyleSheet`, and a `pressed:` entry there is one careless edit away from
 * being a hand-picked grey again.
 *
 * So this reads the source, the way `nativeModuleConfig.test.ts` reads
 * `modules/`: a list written by hand is exactly how the next screen gets missed.
 */

const ROOTS = ['app', 'src']

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith('.tsx') || entry.name.endsWith('.ts') ? [full] : []
  })
}

/** Every `pressed: { backgroundColor: … }` declared in a screen's stylesheet. */
function pressedFills(): { file: string; colour: string }[] {
  return ROOTS.flatMap(sourceFiles).flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8')
    return [...source.matchAll(/\bpressed: \{ backgroundColor: ([^}]+) \}/g)].map((match) => ({
      file,
      colour: match[1].trim(),
    }))
  })
}

describe('the pressed fill', () => {
  it('is the shared token everywhere it is declared', () => {
    const wrong = pressedFills().filter((entry) => entry.colour !== 'theme.surfacePressed')

    // Named in the failure, because "one of them is wrong" is not actionable.
    expect(wrong.map((entry) => `${entry.file}: ${entry.colour}`)).toEqual([])
  })

  it('is declared by many screens, so the check above cannot pass vacuously', () => {
    // A regex that matched nothing would satisfy the first test forever. This is
    // the mutation that would otherwise survive.
    expect(pressedFills().length).toBeGreaterThan(15)
  })
})
