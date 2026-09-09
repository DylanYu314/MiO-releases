import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * That every package a config plugin patches is actually compiled from source
 * (#523).
 *
 * ## Why this exists
 *
 * Expo SDK 54+ ships many of its own modules as **prebuilt AARs**. A module
 * that declares `android.publication` in its `expo-module.config.json` is
 * linked as a Maven dependency on that AAR — `ExpoAutolinkingPlugin.kt` does
 * `dependencies.add("api", "<groupId>:<artifactId>:<version>")` for it — and
 * its `android/src/**` is never handed to the Kotlin compiler.
 *
 * `expo-audio` is such a module, and **both** of this project's config plugins
 * patch its Kotlin at prebuild:
 *
 * - `withSinglePlayerMediaSession.js` (#473) — one media session, not one per deck
 * - `withMonoAudioProcessor.js` (#482) — the renderers factory mono needs
 *
 * So on 2026-08-14 prebuild patched the source correctly, Gradle linked the
 * prebuilt AAR, and the APK built, installed and ran with **neither** patch in
 * it: mono answered `mono.refused no_processor` and Bluetooth next/previous
 * went to expo-audio's own session. Nothing failed. That is the whole danger —
 * the plugins' own "throw if the source moved" guards protect against not
 * *applying*, and this is a failure to be *compiled*, one layer further out.
 *
 * The opt-out is `expo.autolinking.buildFromSource` in `package.json`, which
 * `SettingsManager.configurePublication` matches against the project name
 * before deciding to use the publication.
 *
 * This test does not need updating when a third plugin arrives: it reads
 * `plugins/` for the packages being patched and `node_modules` for which of
 * them are precompiled, the same way `nativeModuleConfig.test.ts` reads
 * `modules/`.
 *
 * ⚠️ It cannot prove the patched code reached the binary — only that Gradle was
 * asked to compile it. `scripts/build-local.sh` greps the APK's dex for that,
 * because a build that succeeds is not a build that contains your code.
 */

const MOBILE_ROOT = join(__dirname, '..')
const PLUGINS_DIR = join(MOBILE_ROOT, 'plugins')
const NODE_MODULES = join(MOBILE_ROOT, 'node_modules')

/**
 * The package each config plugin reaches into.
 *
 * Both plugins address it as a `MODULE_ROOT` path array beginning
 * `'node_modules', '<package>'`, which is the one spelling worth matching: a
 * plugin that patches a dependency has to name it that way to find it.
 */
function patchedPackages(): string[] {
  const found = new Set<string>()
  for (const file of readdirSync(PLUGINS_DIR).filter((n) => n.endsWith('.js'))) {
    const source = readFileSync(join(PLUGINS_DIR, file), 'utf8')
    for (const [, pkg] of source.matchAll(/'node_modules',\s*'([^']+)'/g)) {
      found.add(pkg)
    }
  }
  return [...found].sort()
}

/** Whether a package is shipped as a prebuilt AAR rather than as source. */
function isPrecompiled(pkg: string): boolean {
  const config = join(NODE_MODULES, pkg, 'expo-module.config.json')
  if (!existsSync(config)) return false
  const parsed = JSON.parse(readFileSync(config, 'utf8'))
  return parsed?.android?.publication != null
}

function buildFromSource(): string[] {
  const pkg = JSON.parse(readFileSync(join(MOBILE_ROOT, 'package.json'), 'utf8'))
  return pkg?.expo?.autolinking?.buildFromSource ?? []
}

describe('config plugins patch packages that are compiled from source', () => {
  // Guards the discovery itself: if this ever finds nothing, every assertion
  // below would pass vacuously and the check would be silently gone.
  it('finds the packages the config plugins patch', () => {
    expect(patchedPackages()).toContain('expo-audio')
  })

  // The premise. Without this the assertion below passes for whichever reason
  // comes first, and a change that stopped `isPrecompiled` detecting anything
  // would read as green. If Expo ever ships expo-audio as source again this
  // fails, which is the right moment to drop the opt-out rather than keep it
  // for a reason that has expired.
  it('expo-audio is shipped as a prebuilt AAR, which is what makes the opt-out necessary', () => {
    expect(isPrecompiled('expo-audio')).toBe(true)
  })

  it.each(patchedPackages())('%s is not linked as a prebuilt AAR', (pkg) => {
    if (!isPrecompiled(pkg)) return // built from source already; nothing to opt out of

    expect(buildFromSource()).toContain(pkg)
  })
})
