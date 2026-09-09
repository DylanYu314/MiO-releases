import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * That the local native modules are *shaped* like native modules (#202, #371).
 *
 * ## Why this exists
 *
 * `modules/` is Kotlin, so nothing here can compile it and jest
 * cannot run it. The feedback loop for "did I write the Gradle file correctly"
 * is a **twenty-minute cloud build** — and it was spent three times over on
 * three different omissions in that one file:
 *
 * 1. `apply plugin: 'kotlin-android'` instead of `id 'expo-module-gradle-plugin'`
 * 2. `implementation project(':expo-audio')`, which a local module cannot resolve
 * 3. no `defaultConfig { versionCode; versionName }`, which autolinking reads
 *
 * Each was invisible until a build failed, and each is plainly visible in every
 * working module's own `build.gradle`. So this compares against those: whatever
 * *every* Expo module in `node_modules` declares, this one must declare too.
 *
 * It cannot prove the module compiles. It can stop the same class of mistake
 * costing another twenty minutes, which is the whole of its ambition.
 */

/**
 * Every local module, discovered rather than listed.
 *
 * `mio-foreground-task` (#371) is the second one, and a hand-written list is
 * how the second module gets none of the checks the first one paid three cloud
 * builds to learn. Reading the directory means a third is covered on the day it
 * is created.
 */
const MODULES_DIR = join(__dirname, '..', 'modules')
const MODULE_NAMES = readdirSync(MODULES_DIR).filter((name) =>
  existsSync(join(MODULES_DIR, name, 'expo-module.config.json')),
)
const NODE_MODULES = join(__dirname, '..', 'node_modules')

function readGradle(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Every `node_modules` package that is an Android Expo module. The reference
 *  set — these are known to build, because the app currently runs. */
function referenceModules(): string[] {
  return readdirSync(NODE_MODULES)
    .filter((name) => name.startsWith('expo-'))
    .filter((name) => existsSync(join(NODE_MODULES, name, 'android', 'build.gradle')))
    .filter((name) => existsSync(join(NODE_MODULES, name, 'expo-module.config.json')))
}

/** A module's gradle file with its comments removed. Half of each explains the
 *  three failed builds, and a comment naming a mistake is not a declaration of
 *  it — without this, the "no expo project dependency" check matched the
 *  sentence saying there isn't one. */
function gradleOf(name: string): string {
  return readGradle(join(MODULES_DIR, name, 'android', 'build.gradle')).replace(/\/\/.*$/gm, '')
}

describe('every local module is built the way every Expo module is', () => {
  it('found the local modules to check', () => {
    // Guards the guard, the same way the reference set below is guarded: a
    // glob that matches nothing would make every `it.each` under it vacuous.
    expect(MODULE_NAMES).toEqual(expect.arrayContaining(['mio-equalizer', 'mio-foreground-task']))
  })

  it('has reference modules to compare against', () => {
    // Guards the guard: if the filter above ever matches nothing, every
    // assertion below would pass vacuously and this file would be theatre.
    expect(referenceModules().length).toBeGreaterThan(5)
  })

  /** How many reference modules declare something. */
  function referencesDeclaring(pattern: RegExp): number {
    return referenceModules().filter((name) =>
      pattern.test(readGradle(join(NODE_MODULES, name, 'android', 'build.gradle'))),
    ).length
  }

  /**
   * Declared by **every** module, so ours must declare it too.
   *
   * `versionName` is the one the third failed build died on
   * (`'android.defaultConfig.versionName' is not defined`), and it is 20 out of
   * 20 here — which is exactly why leaving it out was a mistake rather than a
   * style choice.
   */
  it.each([
    ['a group', /^group\s*=/m],
    ['a version', /^version\s*=/m],
    ['a namespace', /namespace\s+['"]/],
    ['a versionCode', /versionCode\s+\d+/],
    ['a versionName', /versionName\s+['"]/],
  ])('declares %s, as every module does', (_what, pattern) => {
    // The premise is asserted first, so a pattern that has gone stale fails as
    // "the reference set changed" rather than as "our file is wrong". That is
    // not hypothetical: writing this test the first time, two patterns were
    // simply not universal and this line is what said so.
    expect(referencesDeclaring(pattern)).toBe(referenceModules().length)

    for (const name of MODULE_NAMES) expect(gradleOf(name)).toMatch(pattern)
  })

  /**
   * Declared by most, not all — 17 of 20 at the time of writing.
   *
   * The three that do not are older or are not Kotlin modules at all, so "all"
   * would be a false claim. A clear majority is still the pattern to follow,
   * and following the minority is what the *first* failed build did.
   */
  it.each([
    ['the android library plugin', /id ['"]com\.android\.library['"]/],
    ["Expo's module gradle plugin", /id ['"]expo-module-gradle-plugin['"]/],
  ])('declares %s, as the great majority do', (_what, pattern) => {
    const references = referenceModules()
    expect(referencesDeclaring(pattern) / references.length).toBeGreaterThan(0.75)

    for (const name of MODULE_NAMES) expect(gradleOf(name)).toMatch(pattern)
  })

  it('depends on no other Expo module by project path', () => {
    // The second failed build. A local module cannot resolve a sibling Expo
    // module this way, and the fix was to stop needing to — see
    // MioEqualizerModule.kt on `SharedRef<*>`.
    for (const name of MODULE_NAMES) expect(gradleOf(name)).not.toMatch(/project\(['"]:expo-/)
    // …and the comment explaining why is still there, since stripping comments
    // is what makes the check above meaningful.
    expect(readGradle(join(MODULES_DIR, 'mio-equalizer', 'android', 'build.gradle'))).toContain(
      'expo-audio',
    )
  })
})

describe.each(MODULE_NAMES)('%s can be found at all', (name) => {
  const dir = join(MODULES_DIR, name)

  it('has a package.json naming itself after its directory', () => {
    // Autolinking names a local module from `packageJson.name`. Without one it
    // falls back to the directory name, and the build can succeed while
    // shipping nothing — the worst of the three failures, because it looks
    // like the feature simply does not work.
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
    expect(pkg.name).toBe(name)
  })

  it('names a Kotlin class that exists on disk', () => {
    const config = JSON.parse(readFileSync(join(dir, 'expo-module.config.json'), 'utf8')) as {
      android?: { modules?: string[] }
    }

    const classes = config.android?.modules ?? []
    expect(classes).toHaveLength(1)

    // A typo here is another build's worth of feedback: autolinking would
    // register a class that does not exist.
    const path = join(dir, 'android', 'src', 'main', 'java', ...classes[0].split('.'))
    expect(existsSync(`${path}.kt`)).toBe(true)
  })

  it('declares the package its Kotlin file is actually in, and the name JS asks for', () => {
    const config = JSON.parse(readFileSync(join(dir, 'expo-module.config.json'), 'utf8')) as {
      android?: { modules?: string[] }
    }
    const declared = (config.android?.modules ?? [])[0]
    const source = readFileSync(
      join(dir, 'android', 'src', 'main', 'java', `${declared.split('.').join('/')}.kt`),
      'utf8',
    )

    const packageName = declared.slice(0, declared.lastIndexOf('.'))
    expect(source).toMatch(new RegExp(`^package ${packageName.replace(/\./g, '\\.')}$`, 'm'))

    /*
     * The name JavaScript asks for, checked against what `index.ts` asks for
     * rather than against a literal repeated here.
     *
     * `requireOptionalNativeModule('…')` returning null is indistinguishable
     * from an old binary, so a mismatch would look like "you need to rebuild"
     * forever — which is the single most expensive failure mode this file has,
     * because the answer to it is a twenty-minute build that changes nothing.
     */
    const index = readFileSync(join(dir, 'index.ts'), 'utf8')
    const asked = /requireOptionalNativeModule<[^>]*>\(['"]([^'"]+)['"]\)/.exec(index)?.[1]
    expect(asked).toBeDefined()
    expect(source).toMatch(new RegExp(`Name\\(["']${asked}["']\\)`))
  })
})
