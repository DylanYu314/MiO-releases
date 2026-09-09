import AsyncStorage from '@react-native-async-storage/async-storage'
import { ATTENUATE_ONLY, TARGET_LUFS, normalizationGain } from '@mio/shared/loudness'

import { loadAudioSettings, useAudioSettings } from '../src/player/audioSettings'

/**
 * The shared formula is covered on the web side too
 * (`frontend/src/player/normalization.test.ts`). What is tested *here* is the
 * part that only exists on Android: the `ATTENUATE_ONLY` cap, which exists
 * because `expo-audio` clamps volume to 0..1 and would otherwise discard a
 * boost without saying so.
 */

/** dB equivalent of a linear gain, which is the readable way to assert here. */
const toDb = (gain: number) => 20 * Math.log10(gain)

describe('normalizationGain under the Android volume cap', () => {
  it('attenuates a track louder than the target, exactly as the web client does', () => {
    // -8 LUFS is 6 dB above the -14 target, so it should come down 6 dB. This is
    // the common case: 82% of the reference library is louder than target.
    expect(toDb(normalizationGain(-8, -3, true, ATTENUATE_ONLY))).toBeCloseTo(-6, 5)
    expect(normalizationGain(-8, -3, true, ATTENUATE_ONLY)).toBeCloseTo(
      normalizationGain(-8, -3, true),
      10,
    )
  })

  it('never boosts, because the platform would silently discard it', () => {
    // A -24 LUFS track "wants" +10 dB. On the web it gets it; here it must be
    // reported as unity rather than as a gain that cannot be applied.
    expect(normalizationGain(-24, -20, true)).toBeGreaterThan(1)
    expect(normalizationGain(-24, -20, true, ATTENUATE_ONLY)).toBe(1)
  })

  it('caps at unity across the whole plausible loudness range', () => {
    for (let lufs = -40; lufs <= 0; lufs += 0.5) {
      for (const peak of [-20, -6, -1, 0, 4.3]) {
        const gain = normalizationGain(lufs, peak, true, ATTENUATE_ONLY)
        expect(gain).toBeLessThanOrEqual(1)
        expect(gain).toBeGreaterThan(0)
      }
    }
  })

  it('still pulls down a track that already clips', () => {
    // peak_dbfs goes as high as +4.3 in the real library. Even when its loudness
    // alone would ask for a boost, the ceiling has to win.
    const gain = normalizationGain(-20, 4.3, true, ATTENUATE_ONLY)
    expect(toDb(gain)).toBeCloseTo(-1 - 4.3, 5)
    expect(gain).toBeLessThan(1)
  })

  it('leaves a track alone when switched off or never measured', () => {
    expect(normalizationGain(-8, -3, false, ATTENUATE_ONLY)).toBe(1)
    expect(normalizationGain(null, null, true, ATTENUATE_ONLY)).toBe(1)
    expect(normalizationGain(undefined, -3, true, ATTENUATE_ONLY)).toBe(1)
  })

  it('does nothing to a track already at the target', () => {
    expect(normalizationGain(TARGET_LUFS, -6, true, ATTENUATE_ONLY)).toBeCloseTo(1, 5)
  })
})

describe('useAudioSettings', () => {
  beforeEach(async () => {
    await AsyncStorage.clear()
    useAudioSettings.setState({ normalizeLoudness: true })
  })

  it('defaults to on', () => {
    expect(useAudioSettings.getState().normalizeLoudness).toBe(true)
  })

  it('persists a change and restores it on the next launch', async () => {
    await useAudioSettings.getState().setNormalizeLoudness(false)
    expect(useAudioSettings.getState().normalizeLoudness).toBe(false)

    // Simulate a cold start: the store is back at its default until storage answers.
    useAudioSettings.setState({ normalizeLoudness: true })
    await loadAudioSettings()
    expect(useAudioSettings.getState().normalizeLoudness).toBe(false)
  })

  it('leaves the default alone when nothing was ever stored', async () => {
    await loadAudioSettings()
    expect(useAudioSettings.getState().normalizeLoudness).toBe(true)
  })

  it('restores an explicit on as well as an explicit off', async () => {
    await useAudioSettings.getState().setNormalizeLoudness(true)
    useAudioSettings.setState({ normalizeLoudness: false })
    await loadAudioSettings()
    expect(useAudioSettings.getState().normalizeLoudness).toBe(true)
  })
})
