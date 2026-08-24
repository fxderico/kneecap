package dev.kneecap.app.export

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.sin
import kotlin.math.sqrt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The limiter's contract, on the same three fixture signals the Swift and TS
 * ports are measured against (see `EdlExporter.swift`'s `LookaheadLimiter`).
 * The numbers here are what makes "audio rips at 1000%" a regression test
 * rather than a listening opinion.
 */
class LookaheadLimiterTest {

    private val rate = 44100
    private val ceiling = LookaheadLimiter.CEILING

    /** Consecutive samples pinned at the ceiling — a squared-off waveform. */
    private fun clippedRuns(samples: FloatArray, skip: Int = 0): List<Int> {
        val runs = mutableListOf<Int>()
        var current = 0
        for (i in skip until samples.size) {
            if (abs(samples[i]) >= ceiling - 1e-6f) {
                current++
            } else {
                if (current > 0) runs.add(current)
                current = 0
            }
        }
        if (current > 0) runs.add(current)
        return runs
    }

    private fun steadyTone(gain: Float) = FloatArray(rate) {
        gain * sin(2.0 * PI * 440.0 * it / rate).toFloat()
    }

    /** Quiet bed with four sharp full-scale bursts — a drum hit, a consonant. */
    private fun transients() = FloatArray(rate) {
        val t = it.toFloat() / rate
        val phase = t % 0.25f
        val bed = 0.05f * sin(2.0 * PI * 220.0 * t).toFloat()
        val burst = if (phase < 0.02f) {
            10f * sin(2.0 * PI * 900.0 * t).toFloat() * exp(-phase * 120.0).toFloat()
        } else {
            0f
        }
        bed + burst
    }

    /** Amplitude-modulated harmonic stack, boosted 10x — speech-shaped. */
    private fun speechLike() = FloatArray(rate) {
        val t = it.toFloat() / rate
        val envelope = maxOf(0f, sin(2.0 * PI * 3.0 * t).toFloat()) *
            (0.6f + 0.4f * sin(2.0 * PI * 11.0 * t).toFloat())
        var harmonics = 0f
        for (h in 1..6) harmonics += sin(2.0 * PI * 140.0 * h * t).toFloat() / h
        10f * envelope * harmonics * 0.3f
    }

    @Test
    fun `never exceeds the ceiling, whatever is thrown at it`() {
        for (signal in listOf(steadyTone(7.5f), transients(), speechLike())) {
            LookaheadLimiter(rate).process(signal)
            val peak = signal.maxOf { abs(it) }
            // 1e-4 (-80 dBFS) absorbs float rounding in `ceiling / magnitude`;
            // the failure this guards against is overshoot measured in dB, not
            // in ulps.
            assertTrue("peak $peak exceeded ceiling", peak <= ceiling + 1e-4f)
        }
    }

    @Test
    fun `transients produce no squared-off runs`() {
        // The failure this whole class exists for: the previous feed-forward
        // limiter left 46 clipped runs per second here, the longest 2.06 ms of
        // flat top. A brickwall limiter DOES touch its ceiling — one isolated
        // sample at a time is it riding the limit; two or more CONSECUTIVE
        // samples pinned there is a squared-off waveform, which is the thing
        // that is audible. Skips the first 100ms while the limiter settles.
        for (signal in listOf(transients(), speechLike())) {
            LookaheadLimiter(rate).process(signal)
            val longest = clippedRuns(signal, skip = rate / 10).maxOrNull() ?: 0
            assertTrue("longest flat top was $longest samples", longest <= 1)
        }
    }

    @Test
    fun `a steady boosted tone stays a tone instead of turning into a square`() {
        val signal = steadyTone(7.5f)
        LookaheadLimiter(rate).process(signal)
        val settled = signal.copyOfRange(rate / 10, signal.size)

        // Any run of consecutive ceiling samples is clipping; a limiter merely
        // riding the ceiling touches it one sample at a time.
        assertTrue("longest run ${clippedRuns(settled).maxOrNull()}", (clippedRuns(settled).maxOrNull() ?: 0) <= 1)

        // Total harmonic distortion: energy that is NOT at 440 Hz. The old
        // limiter measured 3.0% here; a clean one just turns the tone down.
        var re = 0.0
        var im = 0.0
        var energy = 0.0
        for ((i, v) in settled.withIndex()) {
            val angle = 2.0 * PI * 440.0 * i / rate
            re += v * kotlin.math.cos(angle)
            im += v * sin(angle)
            energy += v.toDouble() * v
        }
        val fundamental = 2.0 * (re * re + im * im) / settled.size
        val thd = sqrt(maxOf(0.0, energy - fundamental) / maxOf(energy, 1e-12))
        assertTrue("THD $thd too high", thd < 0.01)
    }

    @Test
    fun `audio that already fits is left alone`() {
        val quiet = steadyTone(0.5f)
        val processed = quiet.copyOf()
        LookaheadLimiter(rate).process(processed)
        // Delayed by the look-ahead window, otherwise untouched.
        val lookahead = (rate * 4 / 1000)
        for (i in rate / 2 until rate / 2 + 1000) {
            assertEquals(quiet[i - lookahead], processed[i], 1e-4f)
        }
    }
}
