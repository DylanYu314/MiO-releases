import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * That every Kotlin file's block comments balance (#573).
 *
 * ## Why this exists
 *
 * **Kotlin block comments nest**, and Java's do not. So a literal slash-star
 * written *inside* a KDoc — which is what a mime glob like `text` + slash-star
 * looks like — opens a second comment, and the single closing delimiter at the
 * end of the KDoc then closes only that inner one. Everything after it stays
 * commented out.
 *
 * `MioShareIntentModule.kt` was written with two of them and shipped merged in
 * #597. The first build that ever compiled it failed four ways at once:
 * `sharedTextOf` unresolved twice, a missing brace, and an unclosed comment
 * reported at line 106 of a 105-line file — all one cause, because the private
 * function and the class's closing brace had been swallowed.
 *
 * Nothing could have caught it. `nativeModuleConfig.test.ts` says in its own
 * docblock that it "cannot prove the module compiles", and the Kotlin had never
 * been handed to a compiler. This is the cheap half of that gap: it cannot
 * typecheck Kotlin either, but a comment that eats the rest of the file is a
 * lexical fact, and a lexer is twelve lines.
 *
 * The same sequence bit once already in JavaScript the day before (a block
 * comment in a jest test), which is what makes this a class rather than a slip.
 */

/** Every `.kt` file under a root, found rather than listed. */
function kotlinFilesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    // `.gradle` and `build` hold generated copies; they are not sources.
    if (entry === '.gradle' || entry === 'build') continue
    const path = join(root, entry)
    if (statSync(path).isDirectory()) out.push(...kotlinFilesUnder(path))
    else if (entry.endsWith('.kt')) out.push(path)
  }
  return out
}

/**
 * The nesting depth of block comments at end of file, and where the outermost
 * unclosed one opened.
 *
 * Strings and line comments are skipped, because a slash-star inside either is
 * not a comment delimiter and flagging one would be a false alarm — the failure
 * mode that made #523's first dex check cry wolf on a correct build.
 */
function unbalancedBlockComment(source: string): { depth: number; line: number } {
  let depth = 0
  let openedAt = 0
  let line = 1
  let i = 0
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (source[i] === '\n') {
      line++
      i++
      continue
    }

    if (depth > 0) {
      if (two === '/*') {
        depth++
        i += 2
        continue
      }
      if (two === '*/') {
        depth--
        i += 2
        continue
      }
      i++
      continue
    }

    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (source.slice(i, i + 3) === '"""') {
      const end = source.indexOf('"""', i + 3)
      const chunk = source.slice(i, end === -1 ? source.length : end + 3)
      line += (chunk.match(/\n/g) ?? []).length
      i = end === -1 ? source.length : end + 3
      continue
    }
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i]
      i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++
        if (source[i] === '\n') break
        i++
      }
      i++
      continue
    }
    if (two === '/*') {
      depth++
      openedAt = line
      i += 2
      continue
    }
    i++
  }
  return { depth, line: openedAt }
}

const ROOTS = [join(__dirname, '..', 'modules'), join(__dirname, '..', 'plugins', 'kotlin')]
const FILES = ROOTS.flatMap(kotlinFilesUnder)

describe('Kotlin block comments', () => {
  it('finds Kotlin to check at all', () => {
    // Without this the suite passes vacuously if the roots ever move — an
    // instrument with no control reports "fine" when it has read nothing.
    expect(FILES.length).toBeGreaterThan(0)
  })

  it.each(FILES)('%s closes every block comment it opens', (path) => {
    const { depth, line } = unbalancedBlockComment(readFileSync(path, 'utf8'))
    // `openedAtLine` is echoed on both sides on purpose: it is not being
    // asserted, it is being *printed*, so a failure names the line the runaway
    // comment opened on instead of only saying a number was wrong.
    expect({ file: path, depth, openedAtLine: line }).toEqual({
      file: path,
      depth: 0,
      openedAtLine: line,
    })
  })
})

describe('the lexer itself', () => {
  it('counts a nested comment as Kotlin does, not as Java does', () => {
    expect(unbalancedBlockComment('/* a /* b */\nfun x() {}').depth).toBe(1)
  })

  it('accepts a balanced nested comment', () => {
    expect(unbalancedBlockComment('/* a /* b */ */\nfun x() {}').depth).toBe(0)
  })

  it('ignores a delimiter inside a string literal', () => {
    expect(unbalancedBlockComment('val t = "text/*"\nfun x() {}').depth).toBe(0)
  })

  it('ignores a delimiter inside a line comment', () => {
    expect(unbalancedBlockComment('// text/*\nfun x() {}').depth).toBe(0)
  })

  it('reports the line the unclosed comment opened on', () => {
    expect(unbalancedBlockComment('fun a() {}\n\n/* x /* y */\n').line).toBe(3)
  })
})
