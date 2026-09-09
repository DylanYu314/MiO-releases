/**
 * Per-track loudness correction, shared by the web client and the Android app.
 *
 * The expensive half of this feature is the *measurement*, and that already
 * happened: `backend/app/loudness.py` runs ffmpeg's `ebur128` filter once at
 * import and stores integrated LUFS and true peak on the song row (G4). All a
 * client has to do is turn those two numbers into a gain.
 *
 * It lives in `shared/` rather than in either client because the alternative is
 * two copies of the same formula. If the web client targeted -14 LUFS and the
 * app targeted -16, the same library would sound different on a phone than in a
 * browser — and nothing would look broken, which is the worst kind of bug.
 * Wave D existed to fix exactly this class of drift in the i18n catalogue.
 *
 * What is *not* shared is everything else Wave G built. Crossfade, the ten-band
 * EQ, mono downmix and balance are all Web Audio graph nodes (ADR-012) with no
 * React Native equivalent. This one function is the portable part.
 */

/**
 * The loudness every track is brought towards, in LUFS.
 *
 * -14 is where the streaming services have settled, so a library normalised to
 * it sits at a familiar level next to anything else the listener plays.
 */
export const TARGET_LUFS = -14

/** True peak is never allowed above this, so lifting a quiet track cannot
 *  clip it. */
export const CLIP_CEILING_DBFS = -1

/**
 * The largest gain a player that can only attenuate is able to apply.
 *
 * Android's `expo-audio` clamps hard — `Playable.kt` does
 * `volume?.coerceIn(0f, 1f)` before touching ExoPlayer — so any value above 1
 * is silently discarded and a quiet track would simply stay quiet while the
 * caller believed it had been corrected. Passing this as `maxGain` makes the
 * limit explicit at the one place that has it, instead of leaving a lie in the
 * return value.
 *
 * The web client has no such limit: a `GainNode` amplifies happily, so it
 * passes nothing and keeps the full correction.
 */
export const ATTENUATE_ONLY = 1

/**
 * The playback gain for one track, as a linear multiplier.
 *
 * Returns 1 — no change — whenever there is nothing to go on: normalization
 * switched off, or a track that was never analysed. Guessing would be worse
 * than leaving it alone.
 *
 * The peak ceiling is what stops a quiet-but-peaky track being boosted into
 * clipping: a track measured at -24 LUFS "wants" +10 dB, but if it already
 * peaks at -3 dBFS it only gets +2.
 *
 * `maxGain` caps the result for players that cannot amplify (see
 * `ATTENUATE_ONLY`). Capping is a real compromise but a small one on a library
 * like this: measured across the 158 songs in the reference library, 82% are
 * *louder* than the -14 target and so need attenuation, which every player can
 * do. Only the remaining 18% lose anything, and they stay exactly as loud as
 * they are today rather than getting worse. Attenuating the loud end is also
 * where most of the benefit is — it cut the spread of that library from 19.4 dB
 * to 9.7 dB.
 */
export function normalizationGain(
  loudnessLufs: number | null | undefined,
  peakDbfs: number | null | undefined,
  enabled: boolean,
  maxGain: number = Number.POSITIVE_INFINITY,
): number {
  if (!enabled || loudnessLufs == null || !Number.isFinite(loudnessLufs)) return 1

  let gainDb = TARGET_LUFS - loudnessLufs
  if (peakDbfs != null && Number.isFinite(peakDbfs)) {
    gainDb = Math.min(gainDb, CLIP_CEILING_DBFS - peakDbfs)
  }
  return Math.min(10 ** (gainDb / 20), maxGain)
}
