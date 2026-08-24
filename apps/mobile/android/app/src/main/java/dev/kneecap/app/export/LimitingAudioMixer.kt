package dev.kneecap.app.export

import androidx.media3.common.audio.AudioProcessor
import androidx.media3.transformer.AudioMixer
import androidx.media3.transformer.DefaultAudioMixer
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

/**
 * media3's own audio mixer with a brickwall limiter on its output.
 *
 * This exists because the mix is the ONLY place the export's peak can actually
 * be controlled, and it is not reachable any other way:
 *
 *  - A per-clip `AudioProcessor` runs before the mix, so it cannot see the sum
 *    of two clips that overlap.
 *  - A composition-level `AudioProcessor` sounds like it should be post-mix,
 *    but instrumenting one on the emulator showed a single instance seeing
 *    only ~20 blocks and never the loud material — it is not in the mixed
 *    path in any way that can be relied on.
 *  - `DefaultAudioMixer` itself saturates: `AudioMixingUtil` clamps each
 *    summed frame to the int16 range, so by the time anything downstream runs,
 *    an over-full-scale sum has ALREADY been squared off.
 *
 * `Transformer.Builder.setAudioMixerFactory` is the supported seam, and
 * `getOutput()` is the exact point where the summed buffer exists. Limiting
 * here mirrors what iOS does with `AVAssetReaderAudioMixOutput` + the limiter
 * in `EdlExporter.swift`, so the two platforms end up with the same contract:
 * per-clip gain, one brickwall across the summed mix, nothing clamped.
 */
class LimitingAudioMixer(private val delegate: AudioMixer) : AudioMixer by delegate {

    class Factory : AudioMixer.Factory {
        override fun create(): AudioMixer = LimitingAudioMixer(DefaultAudioMixer.Factory().create())
    }

    private var limiter: LookaheadLimiter? = null
    private var scratch = FloatArray(0)

    override fun configure(
        outputAudioFormat: AudioProcessor.AudioFormat,
        bufferSizeMs: Int,
        startTimeUs: Long,
    ) {
        delegate.configure(outputAudioFormat, bufferSizeMs, startTimeUs)
        // One limiter for the whole export: it is one continuous signal, and a
        // per-buffer instance would restart its envelope on every block.
        limiter = LookaheadLimiter(sampleRate = outputAudioFormat.sampleRate)
    }

    override fun reset() {
        delegate.reset()
        limiter = null
    }

    override fun getOutput(): ByteBuffer {
        val output = delegate.output
        val limiter = this.limiter ?: return output
        val sampleCount = output.remaining() / 2
        if (sampleCount == 0) return output

        // The mixer's output is int16 (media3's PCM chain format). Read it out,
        // do the limiting in float where there is room to work, and write it
        // back into the same buffer — the caller owns its position/limit, so
        // they are restored exactly as found.
        val position = output.position()
        if (scratch.size < sampleCount) scratch = FloatArray(sampleCount)
        val shorts = output.order(ByteOrder.nativeOrder()).asShortBuffer()
        for (i in 0 until sampleCount) scratch[i] = shorts.get(i) / 32768f

        limiter.process(scratch, 0, sampleCount)

        for (i in 0 until sampleCount) {
            shorts.put(i, (scratch[i].coerceIn(-1f, 1f) * 32767f).roundToInt().toShort())
        }
        output.position(position)
        return output
    }
}
