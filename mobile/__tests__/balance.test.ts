import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { gainAt } from '../src/components/EqualizerPanel'
import { normalizeBalance } from '../src/player/audioSettings'

/**
 * Left/right balance (#380).
 *
 * The arithmetic lives on both sides of the bridge — the store decides what a
 * position *means*, the Kotlin decides what it *does* — so both are checked
 * here, the second by reading the source the way `equalizerThreadSafety` does.
 *
 * ADR-012's P8 update judged this to need a native module. It needed native
 * *code*, in a module that already existed: `DynamicsProcessing` carries
 * per-channel input gain, and one is already attached to every deck for the ten
 * bands. this repo's conventions now records "needs a native module" as wrong three times.
 */

describe('normalizeBalance', () => {
  it('keeps the ends and the centre', () => {
    expect(normalizeBalance(-1)).toBe(-1)
    expect(normalizeBalance(0)).toBe(0)
    expect(normalizeBalance(1)).toBe(1)
  })

  it('clamps past the ends rather than letting them through', () => {
    expect(normalizeBalance(-4)).toBe(-1)
    expect(normalizeBalance(4)).toBe(1)
  })

  /**
   * A slider cannot be dropped on exactly zero, and a permanent third of a
   * decibel of tilt is worse than a control that admits a dead zone.
   */
  it('snaps a near-centre position to true centre', () => {
    expect(normalizeBalance(0.01)).toBe(0)
    expect(normalizeBalance(-0.01)).toBe(0)
  })

  it('leaves a deliberate small offset alone', () => {
    // The other edge of the dead zone. Without this the test would pass on a
    // version that snapped *everything* to centre — #392's mistake exactly.
    expect(normalizeBalance(0.05)).toBe(0.05)
    expect(normalizeBalance(-0.05)).toBe(-0.05)
  })

  /**
   * A corrupt stored value must read as centred, not reach the native side as
   * `NaN` — where it would become a gain of `NaN` dB on a real audio session.
   *
   * Infinity is centred too, rather than clamped to an end. "Anything that is
   * not a real number means centred" is one rule; "NaN is centred but Infinity
   * is hard right" is two, and the second is a worse thing to be wrong about,
   * because it turns a corrupt read into a silent channel.
   */
  it('treats any non-finite value as centred', () => {
    expect(normalizeBalance(Number.NaN)).toBe(0)
    expect(normalizeBalance(Number.POSITIVE_INFINITY)).toBe(0)
    expect(normalizeBalance(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

/**
 * The meter is shared with the equaliser at a hundredth of its scale, so the
 * drag maths is `gainAt` and needs no second copy — but the *reuse* is the
 * claim, and it is worth pinning.
 */
describe('the balance meter reuses the band meter', () => {
  it('reads whole percent across the bar', () => {
    expect(gainAt(0, 200, 100)).toBe(-100)
    expect(gainAt(100, 200, 100)).toBe(0)
    expect(gainAt(200, 200, 100)).toBe(100)
    expect(gainAt(150, 200, 100)).toBe(50)
  })

  it('still reads decibels for the bands', () => {
    expect(gainAt(0, 200)).toBe(-12)
    expect(gainAt(200, 200)).toBe(12)
  })
})

/**
 * The Kotlin half, read rather than run — there is no jest, no ExoPlayer and no
 * phone here, and the property is structural.
 */
describe('the native side', () => {
  const source = readFileSync(
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

  /**
   * The exact spelling, because the SDK's own casing is inconsistent —
   * `setInputGainbyChannel` sets and `getInputGainByChannelIndex` reads — and a
   * wrong name is a twenty-minute build to discover. Read from `android.jar`
   * with `javap` rather than recalled.
   */
  it('uses the per-channel input gain setter that actually exists', () => {
    expect(source).toContain('setInputGainbyChannel(')
  })

  /**
   * `setChannelTo` would replace the whole `Channel`, including the post-EQ the
   * ten bands live in — so moving the balance would silently wipe the
   * equaliser. The narrow setter is the point, not an incidental choice.
   */
  it('does not replace the whole channel, which would wipe the bands', () => {
    expect(source).not.toContain('setChannelTo(')
  })

  /** Attenuate-only, the same trade loudness normalisation makes: boosting the
   *  louder side would clip material already mastered near full scale. */
  it('never asks for a positive gain', () => {
    expect(source).toContain('const val SILENT_DB = -60f')
    expect(source).toContain('fun channelGainsDb(')
  })

  /**
   * ⚠️ **The regression this file did not catch.**
   *
   * Until 2026-08-13 these two expressions were swapped, so a negative balance
   * attenuated the *left* channel and dragging the slider left moved the sound
   * right. Every layer above agreed that negative meant left — the store's
   * docblock, the slider, the `balanceLeft` label — and the only assertion
   * about this function was that it existed. It took a device to find.
   *
   * Asserting on source text is weaker than running the code, and it is what
   * jest can do: the real arithmetic was verified by compiling this function
   * with `kotlinc` and running it (the PR has the harness), which printed
   * `balance=-1 → L=0.00 dB, R=-60.00 dB`. What this guards is the swap coming
   * back, which is the failure that actually happened.
   */
  it('attenuates the RIGHT channel when balance is negative', () => {
    expect(source).toContain('val left = (1.0 - maxOf(clamped, 0.0)).toFloat()')
    expect(source).toContain('val right = (1.0 + minOf(clamped, 0.0)).toFloat()')
  })
})
