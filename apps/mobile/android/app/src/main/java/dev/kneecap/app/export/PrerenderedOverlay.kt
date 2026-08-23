package dev.kneecap.app.export

import android.graphics.Bitmap
import androidx.media3.common.OverlaySettings
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.StaticOverlaySettings

/**
 * Text/caption overlays rendered by the PREVIEW's own drawing code
 * (`editor-core/export/overlay-frames.ts`) and composited here verbatim —
 * the Android half of round 37.
 *
 * Android had the same structural problem iOS did: `EdlTextOverlay` is a
 * SECOND implementation of the editor's text rendering (Spannable +
 * `AbsoluteSizeSpan` at the RAW `fontSize` param, no height scaling, no
 * border, no line breaks, no caption word timing), so its exports could
 * never match the preview — the exact class of drift that cost iOS half a
 * dozen rounds to chase down one property at a time. Feeding it the
 * preview's own full-frame images removes that implementation from the
 * path instead of fixing it property by property.
 *
 * Each frame is a full-resolution RGBA bitmap covering `[startUs, endUs)`.
 * `BitmapOverlay` has no "inactive" notion, so outside every frame's window
 * this returns a 1×1 fully transparent bitmap — the same time-gating trick
 * `EdlTextOverlay.getText` uses with an empty string.
 */
class PrerenderedOverlay(
    private val frames: List<Frame>,
) : BitmapOverlay() {

    data class Frame(val startUs: Long, val endUs: Long, val bitmap: Bitmap)

    private val blank: Bitmap =
        Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888).apply { eraseColor(0) }

    /** Full-frame, 1:1: the bitmap IS the output-resolution overlay layer,
     *  so it is anchored dead centre at scale 1 with no transform of its
     *  own. All positioning already happened in the preview's renderer. */
    private val settings: OverlaySettings =
        StaticOverlaySettings.Builder()
            .setBackgroundFrameAnchor(0.5f, 0.5f)
            .setOverlayFrameAnchor(0.5f, 0.5f)
            .build()

    override fun getBitmap(presentationTimeUs: Long): Bitmap {
        for (frame in frames) {
            if (presentationTimeUs >= frame.startUs && presentationTimeUs < frame.endUs) {
                return frame.bitmap
            }
        }
        return blank
    }

    override fun getOverlaySettings(presentationTimeUs: Long): OverlaySettings = settings
}
