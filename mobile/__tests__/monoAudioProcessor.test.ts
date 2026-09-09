import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../plugins/withMonoAudioProcessor') as {
  patchSource: (file: string, source: string) => string
  ANCHOR: string
  PATCHED: string
  FILES: string[]
  INJECTED: string
}

/**
 * Mono, which lives in the audio sink rather than in an effect (#482).
 *
 * ## What can and cannot be tested here
 *
 * The Kotlin is not compiled by anything in this repository — it is copied into
 * `expo-audio`'s package at prebuild — and jest cannot run it. So this file
 * proves two things that *are* checkable from here, and both of them are where
 * the design would break silently:
 *
 * 1. **the patch still applies to the installed dependency.** A fixture would
 *    repeat #478's mistake in a new place: it would keep passing while
 *    `expo-audio` moved underneath it. So the transform runs against the real
 *    source, and CI fails the moment an upgrade moves those lines.
 * 2. **the processor keeps the format constant.** That is the whole reason it
 *    does not use media3's own `ChannelMixingAudioProcessor`: a format change,
 *    or an `isActive()` that depends on the toggle, forces the sink to
 *    reconfigure — and a switch in a settings panel cannot do that. Neither
 *    fault would fail a build; both would ship a switch that does nothing until
 *    the next track, or drops audio when pressed.
 *
 * Everything past that needs the device. Nothing here says mono *sounds* right.
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

const installed = (file: string) => readFileSync(join(MODULE_ROOT, file), 'utf8')

/** Comments stripped: #303 shipped a source-reading guard that passed against
 *  broken code because the word it looked for survived in a docblock. */
const processor = readFileSync(join(__dirname, '..', 'plugins', 'kotlin', plugin.INJECTED), 'utf8')
const code = processor
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')
  .replace(/^\s*\*.*$/gm, '')

describe.each(plugin.FILES)('patching %s', (file) => {
  const source = installed(file)

  it('still finds the player construction it edits', () => {
    // The failure this catches is an expo-audio upgrade. It has to be loud:
    // a silently skipped patch is a mono switch that does nothing, and #478
    // cost twenty minutes discovering exactly that shape of silence.
    expect(source).toContain(plugin.ANCHOR)
  })

  it('adds the renderers factory before the player is built', () => {
    const patched = plugin.patchSource(file, source)

    expect(patched).toContain('.setRenderersFactory(MioMonoRenderersFactory(context))')
    // Order matters and the anchor is what guarantees it: a call inserted after
    // `.build()` is not a compile error in a chain of builders returning
    // themselves — it is a factory the player never sees.
    expect(patched.indexOf('.setRenderersFactory')).toBeLessThan(patched.indexOf('.build()'))
  })

  it('is idempotent, because prebuild runs over the same node_modules twice', () => {
    const once = plugin.patchSource(file, source)

    expect(plugin.patchSource(file, once)).toBe(once)
    expect(once.match(/setRenderersFactory/g)).toHaveLength(1)
  })

  it('throws rather than skipping when the dependency has moved', () => {
    expect(() => plugin.patchSource(file, 'class Something')).toThrow(/expo-audio has changed/)
  })
})

describe('the injected processor', () => {
  it('is written into expo-audio’s own package', () => {
    // Not our own module: Gradle cannot resolve `:expo-audio` from a local
    // module — that was tried for the equaliser and failed — so the patched
    // line can only name a class in the package it lives in.
    expect(code).toContain('package expo.modules.audio')
  })

  it('never changes the audio format, so the toggle needs no reconfiguration', () => {
    // The single most important line in the file. `ChannelMixingAudioProcessor`
    // returns a format with the matrix's output channel count; this returns the
    // input format unchanged, which is what lets mono be switched mid-track.
    const onConfigure = /fun onConfigure\([\s\S]*?\n  \}/.exec(code)?.[0] ?? ''

    expect(onConfigure).toContain('return inputAudioFormat')
    // The only other answer is "bypass me", for audio it cannot mix at all.
    expect(onConfigure).toContain('AudioProcessor.AudioFormat.NOT_SET')
  })

  /*
   * The empty first buffer (#531).
   *
   * `replaceOutputBuffer(0)` returns `AudioProcessor.EMPTY_BUFFER` itself —
   * `BaseAudioProcessor.buffer` starts as that singleton and the method only
   * allocates when `capacity() < count` — and an empty input is the same
   * object, so `put` throws `IllegalArgumentException: The source buffer is
   * this buffer`. ExoPlayer turns that into a playback error on the *first*
   * buffer of every fresh player: every track stuck at buffering.
   *
   * ⚠️ `code` is comment-stripped, and that matters here more than usual: the
   * paragraph explaining this fix contains the very words the fix is made of.
   * #303's guard passed against broken code for exactly that reason.
   */
  it('returns before touching a buffer when there are no frames', () => {
    const queueInput = /fun queueInput\([\s\S]*?\n  \}/.exec(code)?.[0] ?? ''

    expect(queueInput).toMatch(/if\s*\(frames == 0\)\s*return/)
    // Before the call that hands back EMPTY_BUFFER, or the guard is decoration.
    expect(queueInput.indexOf('if (frames == 0) return')).toBeLessThan(
      queueInput.indexOf('replaceOutputBuffer'),
    )
  })

  it('does not decide activity from the toggle', () => {
    // `isActive()` false drops the processor from the chain, and it is read
    // when the sink is configured — not per buffer. A processor that switched
    // itself off would stay off until the next track.
    expect(code).not.toMatch(/fun isActive/)
    // The flag is read where it can take effect immediately instead.
    expect(/fun queueInput\([\s\S]*?\n  \}/.exec(code)?.[0] ?? '').toContain(
      'MioMono.enabled.get()',
    )
  })

  it('passes the audio through untouched when mono is off', () => {
    const queueInput = /fun queueInput\([\s\S]*?\n  \}/.exec(code)?.[0] ?? ''

    // Not "mix with an identity matrix": off must cost a copy, not arithmetic
    // on every sample of every track for a feature nobody has switched on.
    expect(queueInput).toMatch(
      /if \(!MioMono\.enabled\.get\(\)\)[\s\S]*?outputBuffer\.put\(inputBuffer\)/,
    )
  })

  it('mixes with media3’s own utility rather than hand-rolled arithmetic', () => {
    // Byte order and encoding are exactly where a hand-rolled version would be
    // quietly wrong, and `AudioMixingUtil` handles 16-bit and float and clips.
    expect(code).toContain('AudioMixingUtil.mix(')
    expect(code).toContain('ChannelMixingMatrix(2, 2, floatArrayOf(0.5f, 0.5f, 0.5f, 0.5f))')
  })

  it('exposes the flag as a static field, which is what the app reflects on', () => {
    // A Kotlin `object` property without `@JvmField` is reached through
    // `INSTANCE` and a getter; the app looks the field up directly.
    expect(code).toMatch(/@JvmField\s+val enabled = AtomicBoolean\(false\)/)
    expect(code).toContain('object MioMono')
  })
})

describe('the native module’s side of it', () => {
  const kotlin = readFileSync(
    join(
      __dirname,
      '..',
      'modules',
      'mio-equalizer',
      'android',
      'src',
      'main',
      'java',
      'dev',
      'dylanyu',
      'mio',
      'equalizer',
      'MioEqualizerModule.kt',
    ),
    'utf8',
  )

  it('names the class and field the plugin actually injects', () => {
    // Two files that have to agree on a string, with no compiler between them.
    expect(kotlin).toContain('const val MONO_CLASS = "expo.modules.audio.MioMono"')
    expect(kotlin).toContain('const val MONO_FIELD = "enabled"')
    expect(code).toContain('object MioMono')
    expect(code).toMatch(/val enabled = AtomicBoolean/)
  })

  it('reports mono support by looking the flag up, not by assuming', () => {
    // A binary built before the config plugin has the module and not the
    // processor. `isSupported` would say yes and the switch would do nothing.
    expect(kotlin).toContain('"hasMono" to (monoFlag() != null)')
  })
})
