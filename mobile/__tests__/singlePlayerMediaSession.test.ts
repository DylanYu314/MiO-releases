import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../plugins/withSinglePlayerMediaSession') as {
  patchSource: (file: string, source: string) => string
  EDITS: { file: string; from: string; to: string; all?: boolean }[]
}

/**
 * The plugin that stops `expo-audio` building a `MediaSession` per deck (#473).
 *
 * ## Why this runs against the real dependency
 *
 * The previous attempt used `patch-package` and **silently produced an
 * unpatched APK** (#478): it hangs off npm's `postinstall`, which ran locally
 * and in CI but not on the build server, and nothing said so. The device found
 * it — two `ExpoAudioBasicMediaSession_*` at launch with nothing playing — 20
 * minutes after the build started.
 *
 * A fixture would repeat that mistake in a new place: it would keep passing
 * while the dependency moved underneath it. So the transform is applied to the
 * **installed** `expo-audio` source, and CI fails the moment an upgrade changes
 * the lines it depends on.
 *
 * The plugin itself runs in `expo prebuild`, which EAS performs on every build
 * of a managed project — there is no `android/` directory here — so unlike a
 * `postinstall` hook it cannot be skipped.
 */
const MODULE_ROOT = join(
  __dirname,
  '..',
  'node_modules',
  'expo-audio',
  'android',
  'src',
  'main',
  'java',
  'expo',
  'modules',
  'audio',
)

const read = (file: string) => readFileSync(join(MODULE_ROOT, ...file.split('/')), 'utf8')

const FILES = [...new Set(plugin.EDITS.map((edit) => edit.file))]

describe.each(FILES)('%s', (file) => {
  const source = read(file)

  it('still contains what the plugin expects to change', () => {
    // The upgrade guard. Asserted before any transform, so a moved line reads as
    // "expo-audio changed" rather than as a broken plugin.
    for (const edit of plugin.EDITS.filter((candidate) => candidate.file === file)) {
      expect(source.includes(edit.from) || source.includes(edit.to)).toBe(true)
    }
  })

  it('leaves no eagerly built session behind', () => {
    const patched = plugin.patchSource(file, source)

    for (const edit of plugin.EDITS.filter((candidate) => candidate.file === file)) {
      expect(patched).toContain(edit.to)
      expect(patched).not.toContain(edit.from)
    }
  })

  /** Prebuild can run twice over the same `node_modules`, and the second run
   *  must not throw or double-apply. */
  it('is idempotent', () => {
    const once = plugin.patchSource(file, source)

    expect(plugin.patchSource(file, once)).toBe(once)
  })
})

/**
 * The half that matters most, and the one #478 lacked: the plugin must **stop
 * the build** rather than ship an APK whose Bluetooth buttons quietly do the
 * wrong thing.
 */
it('throws when expo-audio no longer looks how it expects', () => {
  expect(() =>
    plugin.patchSource('AudioPlayer.kt', 'class AudioPlayer { /* rewritten */ }'),
  ).toThrow(/expo-audio has changed/)
})

/**
 * The declaration is the property, not a word in the file. #303's guard asserted
 * a word was present and passed against broken code, because the word survived
 * in the docblock explaining it — and the comment this plugin inserts says
 * "MediaSession" too.
 */
it('makes the field nullable rather than merely mentioning it', () => {
  const patched = plugin.patchSource('AudioPlayer.kt', read('AudioPlayer.kt'))

  expect(patched).toContain('internal var mediaSession: MediaSession? = null')
  expect(patched).not.toContain('internal var mediaSession: MediaSession = buildBasicMediaSession')
})

/** Registered, or it never runs. A plugin nobody lists is a file. */
it('is listed in app.json', () => {
  const { expo } = require('../app.json') as { expo: { plugins: (string | unknown[])[] } }

  expect(expo.plugins).toContain('./plugins/withSinglePlayerMediaSession')
})
