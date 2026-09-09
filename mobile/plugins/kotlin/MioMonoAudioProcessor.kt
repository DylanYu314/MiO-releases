package expo.modules.audio

import android.content.Context
import androidx.media3.common.audio.AudioMixingUtil
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Mono / channel mixing for MiO (#482) — injected into `expo-audio` at prebuild
 * by `plugins/withMonoAudioProcessor.js`. **This file is not compiled from the
 * repository**; it is copied into the package that owns the player, because
 * that is the only classpath the patched constructor can name.
 *
 * ## Why this exists at all
 *
 * Mono is a **sum of the channels**, and channel mixing lives in the audio sink
 * rather than in an effect. `DynamicsProcessing` — which the app already
 * attaches for the ten-band EQ and for balance — is per-channel at every stage
 * (`setInputGainbyChannel`, `setPreEqByChannelIndex`, …) and has nothing that
 * combines two channels into one. Attenuating one side is balance, not mono.
 *
 * ## Why it does not use `ChannelMixingAudioProcessor`, which media3 ships
 *
 * That class **changes the channel count** — its `onConfigure` returns an
 * `AudioFormat` with the matrix's output channel count, and returns `NOT_SET`
 * (which means "bypass me") when the matrix is the identity. Both halves are
 * wrong for a *toggle*: a format change forces the sink to reconfigure, and a
 * processor that goes inactive is dropped from the chain entirely. Flipping
 * either at runtime would need the player rebuilt around it.
 *
 * So this keeps the stream **stereo throughout** and writes the same mixed
 * sample to both channels. The format never changes, `isActive()` is therefore
 * constant, and {@link MioMono} can be flipped between two buffers — which is
 * what a settings switch has to be able to do.
 *
 * The mixing itself is still media3's: `AudioMixingUtil.mix` is public, handles
 * 16-bit and float PCM, and clips float output. Hand-rolling that would be a
 * second implementation of arithmetic that already exists and is tested
 * upstream — and the byte-order and encoding details are exactly where a
 * hand-rolled version would be quietly wrong.
 *
 * ## What has actually been run
 *
 * This file was **compiled and executed** against media3 1.9.0's own jars and
 * `android.jar` (API 35) before it was ever built — the harness is in PR #493.
 * Not a reading: real 16-bit stereo frames through the real `queueInput`.
 *
 *     configured stereo/16-bit  → isActive() true
 *     configured 5.1            → isActive() false   (bypassed, as intended)
 *     off  (100, 200) (1000, −1000) (32767, 32767) (−32768, 0)  → unchanged
 *     on   → (150, 150) (0, 0) (32767, 32767) (−16384, −16384)
 *
 * Out-of-phase channels cancelling to silence is correct and is what mono
 * means; the full-scale pair does not overflow.
 *
 * ⚠️ **None of that is the device.** It says the arithmetic and the format
 * contract are right. It does not say the processor is reached inside a real
 * `DefaultAudioSink` — audio offload bypasses the processor chain entirely —
 * nor that the config plugin runs on EAS.
 *
 * ⚠️ **And every one of those frames was non-empty**, which is exactly the case
 * that worked. The first buffer a real sink delivers is empty, and that threw
 * (#531) — the harness tested the arithmetic and never the edges around it. A
 * fixture chosen to exercise the interesting path can miss the one that runs
 * first.
 */
@UnstableApi
object MioMono {
  /**
   * Whether both channels should carry the sum.
   *
   * A process-wide flag rather than per player, and deliberately: crossfade
   * means two decks (#201) and both must be mixed identically or a transition
   * would pan. It also survives a player being rebuilt, so nothing has to
   * re-apply it per track.
   *
   * `@JvmField` on an `AtomicBoolean` so the app's own module can reach it by
   * reflection — the same route `MioEqualizerModule` already takes into this
   * package, and for the same reason: Gradle cannot resolve `:expo-audio` from
   * a local module.
   */
  @JvmField
  val enabled = AtomicBoolean(false)
}

/**
 * Sums the channels into both, when {@link MioMono} says so.
 *
 * Always in the chain, never changing the format. Reading the flag per buffer
 * costs one volatile read per ~20 ms of audio.
 */
@UnstableApi
class MioMonoAudioProcessor : BaseAudioProcessor() {
  /**
   * Two in, two out, every coefficient a half: each output channel is
   * `(L + R) / 2`.
   *
   * A half rather than the ~0.707 of a constant-*power* downmix, because the
   * two channels of a stereo song are correlated — the same material, not two
   * independent sources — so a constant-gain sum is what keeps the level the
   * listener already had. `createForConstantGain` would build the 2→1 form;
   * this is 2→2 on purpose, so the format cannot change.
   */
  private val mixToBoth = ChannelMixingMatrix(2, 2, floatArrayOf(0.5f, 0.5f, 0.5f, 0.5f))

  override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
    // `NOT_SET` means "bypass me", which is the right answer for anything this
    // cannot mix: mono content is already mono, and `canMix` is media3's own
    // test for 16-bit or float PCM at a known rate.
    if (inputAudioFormat.channelCount != 2 || !AudioMixingUtil.canMix(inputAudioFormat)) {
      return AudioProcessor.AudioFormat.NOT_SET
    }
    // Unchanged, which is the whole design: same rate, same channels, same
    // encoding, so switching mono on and off never reconfigures the sink.
    return inputAudioFormat
  }

  override fun queueInput(inputBuffer: ByteBuffer) {
    val frames = inputBuffer.remaining() / inputAudioFormat.bytesPerFrame

    /*
     * An empty input must return before touching a buffer (#531).
     *
     * `replaceOutputBuffer(0)` hands back **`AudioProcessor.EMPTY_BUFFER`
     * itself**: `BaseAudioProcessor.buffer` starts as that singleton, and the
     * method only allocates when `buffer.capacity() < count`, so a count of
     * zero takes the `buffer.clear()` branch and returns what is already
     * there. An empty *input* is the same singleton. `put` then refuses to
     * copy a buffer into itself —
     *
     *     java.lang.IllegalArgumentException: The source buffer is this buffer
     *
     * — ExoPlayer turns that into a playback error, and every track stops at
     * buffering. It happens on the **first** buffer of a fresh player, which is
     * why it was total rather than intermittent.
     *
     * ⚠️ It only bit with mono **off**: `AudioMixingUtil.mix` with `frames = 0`
     * touches nothing and returns, so the mono path survived the same call and
     * left a real buffer allocated behind it — which is why switching mono on
     * "fixed" playback for the rest of the session, and why restarting the app
     * broke it again. That made the toggle look like the cause when it was the
     * workaround.
     *
     * Returning early is the whole fix: `BaseAudioProcessor.getOutput()` resets
     * `outputBuffer` to `EMPTY_BUFFER` after each read, so producing nothing is
     * exactly right, and there is nothing to consume from an empty input.
     */
    if (frames == 0) return

    val outputBuffer = replaceOutputBuffer(frames * outputAudioFormat.bytesPerFrame)

    if (!MioMono.enabled.get()) {
      // Straight through. `put` copies the whole remaining input and leaves it
      // consumed, which is what the caller expects either way.
      outputBuffer.put(inputBuffer)
    } else {
      AudioMixingUtil.mix(
        inputBuffer,
        inputAudioFormat,
        outputBuffer,
        outputAudioFormat,
        mixToBoth,
        frames,
        /* accumulate= */ false,
        /* clipFloatOutput= */ true
      )
    }

    outputBuffer.flip()
  }
}

/**
 * The default renderers factory, with one processor added.
 *
 * `ExoPlayer.Builder` takes a `RenderersFactory` and `expo-audio` does not pass
 * one, so it gets `DefaultRenderersFactory`. This is that class with
 * `buildAudioSink` overridden — the body is upstream's, verified against
 * media3 1.9.0, plus `setAudioProcessors`.
 */
@UnstableApi
class MioMonoRenderersFactory(context: Context) : DefaultRenderersFactory(context) {
  override fun buildAudioSink(
    context: Context,
    enableFloatOutput: Boolean,
    enableAudioTrackPlaybackParams: Boolean
  ): AudioSink =
    DefaultAudioSink.Builder(context)
      .setEnableFloatOutput(enableFloatOutput)
      .setEnableAudioOutputPlaybackParameters(enableAudioTrackPlaybackParams)
      .setAudioProcessors(arrayOf(MioMonoAudioProcessor()))
      .build()
}
