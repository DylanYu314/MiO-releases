const { withDangerousMod } = require('expo/config-plugins')
const fs = require('node:fs/promises')
const path = require('node:path')

/**
 * Stop `expo-audio` building a `MediaSession` per deck (#473).
 *
 * ## What is wrong upstream
 *
 * `AudioPlayer.kt` constructs a `MediaSession` in a **field initialiser**,
 * unconditionally, whether or not lock-screen controls are ever used. Crossfade
 * needs two decks (#201), so this app always carried two sessions it never
 * asked for, each wrapping the raw ExoPlayer.
 *
 * They are invisible in the shade — `AudioControlsService` never calls
 * `addSession()` on them — so they look harmless. But the system's **media
 * button session** is arbitrated separately from the notification, and they won
 * it. Hardware and Bluetooth next/previous therefore reached a session whose
 * timeline holds one item, which advertises no next/previous and seeks instead:
 * the exact symptom #395 was about, surviving on the hardware path.
 *
 * Measured on the device 2026-08-12:
 *
 *     Media button session is dev.dylanyu.mio/…/ExpoAudioBasicMediaSession_69066270
 *     adb shell input keyevent KEYCODE_MEDIA_NEXT  →  track unchanged
 *
 * expo-audio 57.0.3 is the latest and has no option to switch this off.
 *
 * ## Why a config plugin and not `patch-package`
 *
 * `patch-package` was tried first (#478) and **silently produced an unpatched
 * APK**. The tree was right — build `8ddf5beb` came from the merge commit and
 * fingerprinted `e76a8015a2be` — and the device still showed two basic sessions
 * at launch with nothing playing, which is the field initialiser running. It
 * hangs off npm's `postinstall`, which applied the patch locally and in CI but
 * not on the build server, and the failure said nothing: 20 minutes to discover
 * silence.
 *
 * A config plugin cannot fail that way. This is a managed project with no
 * `android/` directory, so **`expo prebuild` runs on every EAS build by
 * definition**, and a dangerous mod runs with it.
 *
 * ## And it fails loudly
 *
 * {@link patchSource} throws when it finds neither the original text nor the
 * patched text — which is what an `expo-audio` upgrade moving these lines looks
 * like. A build that cannot apply this stops, rather than shipping an APK whose
 * Bluetooth buttons quietly do the wrong thing.
 */

/** Nulled rather than made lazy: every read of this field in the package is a
 *  release, and `releasePlayer()` is one of them, so a create-on-read getter
 *  would build a `MediaSession` during teardown — possibly off the main thread,
 *  which media3 forbids. */
const EDITS = [
  {
    file: 'AudioPlayer.kt',
    from: '  internal var mediaSession: MediaSession = buildBasicMediaSession(context, ref)',
    to: [
      '  // MiO (#473): not built here, and null until something needs one.',
      '  // Two decks meant two sessions nobody asked for, and they won the',
      '  // system media button arbitration away from the app’s own session.',
      '  internal var mediaSession: MediaSession? = null',
    ].join('\n'),
  },
  {
    file: 'AudioPlayer.kt',
    from: '  internal fun assignBasicMediaSession() {\n    mediaSession.release()',
    to: '  internal fun assignBasicMediaSession() {\n    mediaSession?.release()',
  },
  {
    file: 'AudioPlayer.kt',
    from: '  override fun releasePlayer() {\n    mediaSession.release()',
    to: '  override fun releasePlayer() {\n    mediaSession?.release()',
  },
  {
    file: 'service/AudioControlsService.kt',
    from: '        player.mediaSession.release()',
    to: '        player.mediaSession?.release()',
    /** Twice, and both are on expo's own lock-screen path, which this app does
     *  not take — but the field is nullable now, so both must compile. */
    all: true,
  },
]

/**
 * Apply this file's edits to one Kotlin source, idempotently.
 *
 * Throws when an edit matches neither its `from` nor its `to`, because that is
 * an upstream change and the only honest response is to stop the build. Silence
 * here is what #478 cost.
 */
function patchSource(fileName, source) {
  let next = source
  for (const edit of EDITS.filter((candidate) => candidate.file === fileName)) {
    if (next.includes(edit.from)) {
      next = edit.all ? next.split(edit.from).join(edit.to) : next.replace(edit.from, edit.to)
      continue
    }
    // Already applied — a second prebuild over the same node_modules.
    if (next.includes(edit.to)) continue
    throw new Error(
      `expo-audio has changed: ${fileName} contains neither the expected source nor the patched ` +
        `form of:\n\n${edit.from}\n\nRe-check plugins/withSinglePlayerMediaSession.js against the ` +
        `installed version before building (#473).`,
    )
  }
  return next
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

const withSinglePlayerMediaSession = (config) =>
  withDangerousMod(config, [
    'android',
    async (dangerousConfig) => {
      const root = dangerousConfig.modRequest.projectRoot
      const files = [...new Set(EDITS.map((edit) => edit.file))]

      for (const file of files) {
        const target = path.join(root, ...MODULE_ROOT, ...file.split('/'))
        const source = await fs.readFile(target, 'utf8')
        const patched = patchSource(file, source)
        if (patched !== source) await fs.writeFile(target, patched)
      }

      return dangerousConfig
    },
  ])

module.exports = withSinglePlayerMediaSession
module.exports.patchSource = patchSource
module.exports.EDITS = EDITS
