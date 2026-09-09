import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/**
 * The accessibility invariants, held in code rather than in a checklist (#519).
 *
 * ⚠️ **Both of these were measured wrong first.** A naive scan for
 * `<Pressable` … `>` reported *every* touchable in the app as unannotated,
 * because it stopped at the `>` inside `({ pressed }) => [...]`. Two components
 * read by hand disagreed with it, and the real number was one. The tag scanner
 * below therefore tracks braces and quotes, and a **control** asserts a
 * hand-verified component reads as annotated — if the parser breaks again, the
 * control fails rather than the suite quietly passing over nothing.
 */

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (path.endsWith('.tsx')) out.push(path)
  }
  return out
}

/**
 * The opening tag starting at `start`.
 *
 * Ends at the first `>` seen outside `{...}`, outside a string and outside a
 * comment.
 *
 * ⚠️ **All three exclusions are load-bearing and each was learned by being
 * wrong.** A style prop is routinely `({ pressed }) => [...]`, whose arrow
 * contains `>`. And a JSX comment inside a tag may contain an apostrophe —
 * `// the login URL is the backend's` — which a naive quote tracker reads as
 * an unterminated string, scans to end of file, and then reports a perfectly
 * well-labelled button as unnamed. That exact line produced this function's
 * last false positive.
 */
function openingTag(src: string, start: number): string {
  let depth = 0
  let quote: string | null = null
  let i = start
  while (i < src.length) {
    const c = src[i]
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = null
      i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl + 1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '{') depth += 1
    else if (c === '}') depth -= 1
    else if (c === '>' && depth === 0) return src.slice(start, i + 1)
    i += 1
  }
  return src.slice(start)
}

type Touchable = {
  file: string
  line: number
  hasLabel: boolean
  hasRole: boolean
  hasTextChild: boolean
}

function touchables(): Touchable[] {
  const found: Touchable[] = []
  for (const file of [...sourceFiles('src'), ...sourceFiles('app')]) {
    const src = readFileSync(file, 'utf8')
    const pattern = /<(Pressable|TouchableOpacity)\b/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(src)) !== null) {
      const tag = openingTag(src, match.index)
      const after = src.slice(match.index + tag.length, match.index + tag.length + 400)
      found.push({
        file,
        line: src.slice(0, match.index).split('\n').length,
        hasLabel: tag.includes('accessibilityLabel'),
        hasRole: tag.includes('accessibilityRole'),
        // A touchable wrapping text borrows that text as its name, which is
        // what a screen reader reads. Not a gap.
        hasTextChild: after.includes('<Text'),
      })
    }
  }
  return found
}

describe('touchables are reachable by a screen reader', () => {
  const all = touchables()

  it('parses tags correctly — the control', () => {
    // ⚠️ Without this, a broken parser makes every assertion below pass by
    // finding nothing, and the guard reports success having checked nothing.
    expect(all.length).toBeGreaterThan(50)
    expect(all.some((t) => t.hasLabel && t.hasRole)).toBe(true)
  })

  it('sees past a comment containing an apostrophe — the other control', () => {
    // The Google connect button carries `// … the backend's.` inside its
    // opening tag and a `<Text>` child immediately after it. A quote tracker
    // that treats that apostrophe as a string start scans to end of file and
    // reports this button as unnamed, which is precisely what happened.
    const button = all.find(
      (t) => t.file.endsWith('add/import/index.tsx') && t.hasRole && t.hasTextChild,
    )
    expect(button).toBeDefined()
  })

  it('gives every touchable a role', () => {
    const missing = all.filter((t) => !t.hasRole).map((t) => `${t.file}:${t.line}`)
    expect(missing).toEqual([])
  })

  it('gives every touchable a name — a label, or text to borrow one from', () => {
    // An icon-only control has nothing to borrow, so it must say what it is.
    // The ActionSheet backdrop was the one that did not (#519).
    const unnamed = all
      .filter((t) => !t.hasLabel && !t.hasTextChild)
      .map((t) => `${t.file}:${t.line}`)
    expect(unnamed).toEqual([])
  })
})

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const channel = (i: number): number => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('text is legible against the surfaces it sits on', () => {
  const src = readFileSync('src/theme/palette.ts', 'utf8')
  const themes = [...src.matchAll(/\{([^{}]*?background:\s*'#[0-9a-f]{6}'[\s\S]*?)\}/g)]
    .map((match) =>
      Object.fromEntries(
        [...match[1].matchAll(/(\w+):\s*'(#[0-9a-f]{6})'/g)].map((token) => [token[1], token[2]]),
      ),
    )
    .filter((tokens) => tokens.background && tokens.text)

  it('finds both themes — the control', () => {
    expect(themes.length).toBeGreaterThanOrEqual(2)
  })

  it.each([
    ['text', 'background'],
    ['text', 'surface'],
    ['textMuted', 'background'],
    ['textMuted', 'surface'],
  ])('keeps %s on %s at WCAG AA', (foreground, ground) => {
    for (const tokens of themes) {
      if (!tokens[foreground] || !tokens[ground]) continue
      // 4.5:1 is AA for body text. Measured 2026-08-21: the lowest real pair is
      // textMuted on surface in the dark theme, at 6.57:1 — so this has real
      // headroom and a failure means a token moved a long way.
      expect(contrast(tokens[foreground], tokens[ground])).toBeGreaterThanOrEqual(4.5)
    }
  })
})

/**
 * Touch targets on the app's shared controls.
 *
 * ⛔ **Deliberately narrow, because the wide version was tried and failed.**
 * Scanning every component for a size returned progress-bar fills and
 * pagination dots (#519): source cannot tell a 4 dp meter from a 4 dp button.
 * So this asserts only the three primitives a **device pass measured**, each
 * with the number it came back with:
 *
 * | control | measured | effective now |
 * |---|---|---|
 * | `Chip` | 35.8 dp | 48 dp (`minHeight`) |
 * | `Button` filled/outlined | 43.8 dp | 48 dp (`MIN_TARGET`) |
 * | accent swatch | 40x40 dp | 48x48 dp (40 + `hitSlop` 4 a side) |
 *
 * `SongRow`'s 32x40 icons are **not** here and are not a defect: `hitSlop={8}`
 * makes them 48x56, and they are visually small on purpose — they sit inside
 * the row's own Pressable, where a generous box would steal the row's taps.
 * That is the case this guard must not "fix".
 */
describe('shared controls meet the 48 dp minimum touch target', () => {
  const MIN_DP = 48
  const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8')

  // ⚠️ The control. Every assertion below is a regex over a file; if a file
  // were renamed or emptied they would all throw or vacuously miss. This
  // asserts the sources are present and non-trivial first.
  it('finds the three sources — the control', () => {
    for (const path of [
      'src/components/ui/Chip.tsx',
      'src/components/ui/Button.tsx',
      'app/(tabs)/settings.tsx',
    ]) {
      expect(read(path).length).toBeGreaterThan(500)
    }
  })

  it('gives Chip a minHeight of at least 48', () => {
    // Not hitSlop: chip rows set `gap: 8` and wrap, so the slack needed would
    // overlap the row beneath.
    const match = /minHeight:\s*(\d+)/.exec(read('src/components/ui/Chip.tsx'))
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(MIN_DP)
  })

  it("uses Android's 48 dp for Button, not Apple's 44", () => {
    const match = /const MIN_TARGET = (\d+)/.exec(read('src/components/ui/Button.tsx'))
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(MIN_DP)
  })

  it('gives the accent swatch enough hitSlop to reach 48', () => {
    const src = read('app/(tabs)/settings.tsx')
    const size = /swatch:\s*\{[^}]*?width:\s*(\d+)/s.exec(src)
    const slop = /hitSlop=\{(\d+)\}/.exec(src)
    expect(size).not.toBeNull()
    expect(slop).not.toBeNull()
    // hitSlop applies to every side, so it counts twice per axis.
    expect(Number(size?.[1]) + 2 * Number(slop?.[1])).toBeGreaterThanOrEqual(MIN_DP)
  })
})
