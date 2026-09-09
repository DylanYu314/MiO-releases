import { describe, expect, it } from 'vitest'

import { CLIP_CEILING_DBFS, TARGET_LUFS, normalizationGain } from '@mio/shared/loudness'

/** dB equivalent of a linear gain, which is the readable way to assert here. */
const toDb = (gain: number) => 20 * Math.log10(gain)

describe('normalizationGain', () => {
  it('leaves a track alone when normalization is off', () => {
    expect(normalizationGain(-24, -3, false)).toBe(1)
  })

  it('leaves an unanalysed track alone rather than guessing', () => {
    // Every song imported before G4 has no measurement, and a silent file
    // legitimately has none either.
    expect(normalizationGain(null, null, true)).toBe(1)
    expect(normalizationGain(undefined, undefined, true)).toBe(1)
  })

  it('lifts a quiet track towards the target', () => {
    // -24 LUFS wants +10 dB, and a peak of -20 leaves ample room for it.
    expect(toDb(normalizationGain(-24, -20, true))).toBeCloseTo(10, 5)
  })

  it('pulls a loud track down towards the target', () => {
    expect(toDb(normalizationGain(-8, -0.5, true))).toBeCloseTo(-6, 5)
  })

  it('does nothing to a track already at the target', () => {
    expect(normalizationGain(TARGET_LUFS, -6, true)).toBeCloseTo(1, 5)
  })

  it('will not boost a peaky track into clipping', () => {
    // -24 LUFS "wants" +10 dB, but it already peaks at -3 dBFS, so it may only
    // have +2 before it would exceed the ceiling.
    const gainDb = toDb(normalizationGain(-24, -3, true))

    expect(gainDb).toBeCloseTo(CLIP_CEILING_DBFS - -3, 5)
    expect(gainDb).toBeLessThan(10)
    // The whole point: peak after gain lands exactly on the ceiling, not above.
    expect(-3 + gainDb).toBeCloseTo(CLIP_CEILING_DBFS, 5)
  })

  it('never lets peak plus gain exceed the ceiling, across the range', () => {
    for (let lufs = -40; lufs <= -5; lufs += 0.5) {
      for (let peak = -30; peak <= 0; peak += 0.5) {
        const gainDb = toDb(normalizationGain(lufs, peak, true))
        expect(peak + gainDb).toBeLessThanOrEqual(CLIP_CEILING_DBFS + 1e-9)
      }
    }
  })

  it('refuses to boost when the peak is unknown', () => {
    // The backend records 0 dBFS when it cannot read a peak — assume the worst
    // rather than risk an overshoot. A track that "wants" +10 dB gets -1.
    expect(toDb(normalizationGain(-24, 0, true))).toBeCloseTo(CLIP_CEILING_DBFS, 5)
  })

  it('takes the target when it asks for more attenuation than the ceiling', () => {
    // A loud track at -8 LUFS wants -6 dB; the ceiling would only have
    // demanded -1, so the target is what binds. The gain is the stricter of
    // the two, not whichever was computed last.
    expect(toDb(normalizationGain(-8, 0, true))).toBeCloseTo(-6, 5)
  })

  it('ignores a peak it cannot use', () => {
    expect(toDb(normalizationGain(-24, null, true))).toBeCloseTo(10, 5)
  })

  it('ignores a non-finite measurement', () => {
    expect(normalizationGain(Number.NEGATIVE_INFINITY, -3, true)).toBe(1)
    expect(normalizationGain(Number.NaN, -3, true)).toBe(1)
  })
})
