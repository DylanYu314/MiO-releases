import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every Add screen is registered in the navigator with a title (#561).
 *
 * ## Why this is a test and not a review note
 *
 * `expo-router` does not require a `Stack.Screen` entry — a route without one
 * still works, and simply shows its **file path** in the header. So #559 and
 * #560 shipped screens whose headers read `import/qq` and `import/kugou`, in an
 * otherwise fully translated app, and every unit test passed: nothing renders
 * the navigator, so nothing could see it.
 *
 * It is not catchable by the i18n parity guard either, because the strings
 * existed — `qq.title` and `kugou.title` were both defined and both correct.
 * What was missing was the line that *uses* them.
 *
 * ## Directory-driven on purpose
 *
 * It reads the routes off disk rather than checking a list, so the next import
 * source inherits the guard wherever it lands — the same argument
 * `externalFetchersAvoidAudio.test.ts` and `nativeModuleConfig.test.ts` make.
 * A hand-written list is exactly how the second one would inherit nothing.
 */

const ADD_ROOT = join(__dirname, '..', 'app', '(tabs)', 'add')
const LAYOUT = join(ADD_ROOT, '_layout.tsx')

/** Route names expo-router derives from the files under `add/`. */
function routeNames(): string[] {
  const routes: string[] = []

  for (const entry of readdirSync(ADD_ROOT, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue

    if (entry.isDirectory()) {
      for (const nested of readdirSync(join(ADD_ROOT, entry.name))) {
        if (!nested.endsWith('.tsx')) continue
        routes.push(`${entry.name}/${nested.replace(/\.tsx$/, '')}`)
      }
      continue
    }
    if (entry.name.endsWith('.tsx')) routes.push(entry.name.replace(/\.tsx$/, ''))
  }

  // `index` is the chooser itself and is titled by the tab, not by the stack.
  return routes.filter((route) => route !== 'index').sort()
}

describe('the Add navigator', () => {
  const layout = readFileSync(LAYOUT, 'utf8')

  it.each(routeNames())('gives %s a title, so its header is not a file path', (route) => {
    const registered = new RegExp(`name=["']${route.replace(/[[\]]/g, '\\$&')}["']`)
    expect(layout).toMatch(registered)

    // Registered *and* titled: an entry with no `title` shows the path too, so
    // asserting only the name would let the actual bug straight through.
    const withTitle = new RegExp(
      `name=["']${route.replace(/[[\]]/g, '\\$&')}["'][^\\n]*title:\\s*t\\(`,
    )
    expect(layout).toMatch(withTitle)
  })

  it('finds the routes it is meant to be checking', () => {
    // A guard that silently enumerated nothing would pass forever. Named
    // explicitly so an `it.each` over an empty list cannot look like success.
    const routes = routeNames()
    expect(routes).toEqual(expect.arrayContaining(['import/qq', 'import/kugou', 'import/netease']))
    expect(routes.length).toBeGreaterThanOrEqual(8)
  })
})
