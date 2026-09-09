const { withDangerousMod } = require('expo/config-plugins')
const fs = require('node:fs/promises')
const path = require('node:path')

/**
 * Give `expo-audio`'s players an audio processor, so mono is possible (#482).
 *
 * ## Why a processor and not an effect
 *
 * Mono is a **sum of the channels**. `DynamicsProcessing` — already attached
 * per audio session for the ten-band EQ and for balance — is per channel at
 * every stage and has nothing that combines two into one (read from
 * `android.jar`, API 35, in #482). Channel mixing lives in the audio *sink*,
 * which means an `AudioProcessor`, which means the `RenderersFactory` the
 * player is built with.
 *
 * `expo-audio` builds its own `ExoPlayer` and passes no renderers factory, so
 * there is nothing to configure from the outside — the same shape as #473, and
 * the same answer: patch the construction at prebuild.
 *
 * ## What it does
 *
 * 1. copies `plugins/kotlin/MioMonoAudioProcessor.kt` into `expo-audio`'s own
 *    package, because that is the only classpath the patched line can name —
 *    Gradle cannot resolve `:expo-audio` from a local module, which is why
 *    `MioEqualizerModule` reflects rather than imports;
 * 2. adds `.setRenderersFactory(MioMonoRenderersFactory(context))` to both
 *    player constructors.
 *
 * The toggle itself is a process-wide `AtomicBoolean` in that file, read per
 * buffer and flipped by the app through reflection. Nothing here has to run
 * again when the setting changes.
 *
 * ## Why a config plugin, and why it throws
 *
 * `patch-package` was tried for #473 and **silently produced an unpatched
 * APK** (#478): it hangs off npm's `postinstall`, which ran locally and in CI
 * and not on the build server. This is a managed project with no `android/`
 * directory, so `expo prebuild` runs on every EAS build by definition, and a
 * dangerous mod runs with it.
 *
 * {@link patchSource} throws when it finds neither the original text nor the
 * patched text — an `expo-audio` upgrade moving these lines stops the build
 * rather than shipping an APK whose mono switch quietly does nothing.
 */

/**
 * Inserted directly after the builder is constructed, so it cannot land after
 * `.build()`. Both files construct it identically.
 */
const ANCHOR = '  player = ExoPlayer.Builder(context)\n    .setLooper(context.mainLooper)'

const PATCHED = [
  '  player = ExoPlayer.Builder(context)',
  '    // MiO (#482): the default renderers factory plus one audio processor,',
  '    // which is the only place a channel sum can happen.',
  '    .setRenderersFactory(MioMonoRenderersFactory(context))',
  '    .setLooper(context.mainLooper)',
].join('\n')

/** Both players. `AudioPlaylist` is not used by this app (#395) and is patched
 *  anyway: leaving one construction site unmixed would make mono depend on
 *  which player a future change happened to pick. */
const FILES = ['AudioPlayer.kt', 'AudioPlaylist.kt']

/** Written into `expo-audio`'s package rather than compiled from ours. */
const INJECTED = 'MioMonoAudioProcessor.kt'

function patchSource(fileName, source) {
  if (source.includes(PATCHED)) return source // already applied
  if (!source.includes(ANCHOR)) {
    throw new Error(
      `expo-audio has changed: ${fileName} contains neither the expected player construction nor ` +
        `the patched form of:\n\n${ANCHOR}\n\nRe-check plugins/withMonoAudioProcessor.js against ` +
        `the installed version before building (#482).`,
    )
  }
  return source.replace(ANCHOR, PATCHED)
}

const MODULE_ROOT = [
  'node_modules',
  'expo-audio',
  'android',
  'src',
  'main',
  'java',
  'expo',
  'modules',
  'audio',
]

const withMonoAudioProcessor = (config) =>
  withDangerousMod(config, [
    'android',
    async (dangerousConfig) => {
      const root = dangerousConfig.modRequest.projectRoot
      const packageDir = path.join(root, ...MODULE_ROOT)

      // The processor first: a patched constructor naming a class that is not
      // there yet is a build that fails on the second file rather than the
      // first, which is a worse error message for the same fault.
      await fs.copyFile(
        path.join(root, 'plugins', 'kotlin', INJECTED),
        path.join(packageDir, INJECTED),
      )

      for (const file of FILES) {
        const target = path.join(packageDir, file)
        const source = await fs.readFile(target, 'utf8')
        const patched = patchSource(file, source)
        if (patched !== source) await fs.writeFile(target, patched)
      }

      return dangerousConfig
    },
  ])

module.exports = withMonoAudioProcessor
module.exports.patchSource = patchSource
module.exports.ANCHOR = ANCHOR
module.exports.PATCHED = PATCHED
module.exports.FILES = FILES
module.exports.INJECTED = INJECTED
