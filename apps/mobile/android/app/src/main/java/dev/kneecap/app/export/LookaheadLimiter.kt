package dev.kneecap.app.export

import kotlin.math.abs
import kotlin.math.exp

/**
 * Look-ahead brickwall limiter — the Android half of the export's clipping
 * protection. Byte-for-byte the same algorithm as `EdlExporter.swift`'s
 * `LookaheadLimiter` and `editor-core/src/audio/limiter.ts`; the three must
 * stay audibly identical, so change them together.
 *
 * Why a look-ahead limiter and not a plain envelope follower: the volume
 * control reaches 1000% (+20 dB), so the summed mix runs far past full scale.
 * A limiter that derives its gain from samples as they arrive is still at
 * gain ~1 when a sudden onset goes through, and whatever clamps the result
 * squares the waveform off — measured offline on synthetic speech boosted
 * 10x, that shape produced 46 clipped runs per second, the longest 2.06 ms of
 * flat top, which is audible tearing on every syllable.
 *
 * Delaying the audio by the look-ahead window and deriving the gain from
 * samples that have not been emitted yet means the gain is already down when
 * the peak arrives:
 *
 *     gain[n] = boxcar_L( releaseSmoothed( slidingMin_2L( ceiling / |x| ) ) )
 *     out[n]  = x[n - L] * gain[n]
 *
 * Every value averaged into `gain[n]` is a minimum taken over a window that
 * still contains the sample being emitted, so the applied gain is always
 * <= the gain that sample needs and NO clamp is required anywhere. Same
 * measurement, same signal: 0 clipped runs and peak exactly at the ceiling.
 *
 * @param ceiling -1.0 dBFS. Sample-peak limiting does NOT bound INTER-sample
 *   peaks — a reconstructed waveform can exceed the sample peak by up to
 *   ~3 dB in the pathological case and typically 0.3-1.5 dB on real program
 *   material — and a lossy encoder adds its own overshoot on top. -1 dBFS
 *   absorbs both without audibly costing loudness; going hotter (-0.3) before
 *   an AAC encode is how "limited" audio still arrives clipped.
 * @param lookaheadMs 4 ms — long enough to catch a transient, short enough
 *   that the delay it adds is inaudible and irrelevant to an offline export.
 * @param releaseMs 150 ms — slow enough not to pump on speech.
 */
class LookaheadLimiter(
    sampleRate: Int,
    private val ceiling: Float = CEILING,
    lookaheadMs: Float = 4f,
    releaseMs: Float = 150f,
) {
    private val lookahead: Int = maxOf(2, (sampleRate * lookaheadMs / 1000f).toInt())

    companion object {
        /** -1.0 dBFS. See the ceiling note in the class doc. */
        const val CEILING = 0.891f
    }
    private val releaseCoefficient: Float = exp(-1.0 / (sampleRate * releaseMs / 1000f)).toFloat()

    private val delayLine = FloatArray(lookahead)
    private var delayWrite = 0

    // Monotonic deque over the required-gain curve; its head is the minimum
    // across the look-ahead window in O(1) amortized. Backed by a ring buffer
    // sized 2L+1 so a steady stream never allocates.
    private val minValues = FloatArray(2 * lookahead + 1)
    private val minIndices = LongArray(2 * lookahead + 1)
    private var head = 0
    private var tail = 0

    private val boxcar = FloatArray(lookahead) { 1f }
    private var boxcarWrite = 0
    private var boxcarSum = lookahead.toFloat()

    private var heldGain = 1f
    private var sampleIndex = 0L

    private val capacity = 2 * lookahead + 1

    /** Limits `count` interleaved float samples in place, starting at `offset`. */
    fun process(samples: FloatArray, offset: Int = 0, count: Int = samples.size - offset) {
        for (i in offset until offset + count) {
            val raw = samples[i]
            val value = if (raw.isFinite()) raw else 0f
            val magnitude = abs(value)
            val required = if (magnitude > ceiling) ceiling / magnitude else 1f

            while (head != tail) {
                val last = if (tail == 0) capacity - 1 else tail - 1
                if (minValues[last] >= required) tail = last else break
            }
            minValues[tail] = required
            minIndices[tail] = sampleIndex
            tail = (tail + 1) % capacity
            while (head != tail && minIndices[head] <= sampleIndex - 2 * lookahead) {
                head = (head + 1) % capacity
            }
            val slidingMin = if (head == tail) 1f else minValues[head]

            // Drop instantly, recover slowly. Staying <= slidingMin is what
            // preserves the no-overshoot guarantee.
            heldGain = if (slidingMin < heldGain) {
                slidingMin
            } else {
                releaseCoefficient * heldGain + (1 - releaseCoefficient) * slidingMin
            }

            boxcarSum += heldGain - boxcar[boxcarWrite]
            boxcar[boxcarWrite] = heldGain
            boxcarWrite = (boxcarWrite + 1) % lookahead

            val emitted = delayLine[delayWrite]
            delayLine[delayWrite] = value
            delayWrite = (delayWrite + 1) % lookahead
            sampleIndex++

            samples[i] = emitted * (boxcarSum / lookahead)
        }
    }
}
