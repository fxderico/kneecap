/**
 * Round 20 — clip-windowing for transcripts. Words come back
 * SOURCE-relative (seconds 0 of the media file); the visible clip shows
 * [trimStart, trimStart+duration) of that source. Keep only words
 * intersecting the window and shift them clip-relative, so
 * `buildCaptionElementsFromTranscript` can offset by the clip's timeline
 * start and captions land exactly under the audible audio.
 *
 * Pure and dependency-free (type-only imports) so it unit-tests without
 * the wasm runtime — same constraint as preview-hit-test.ts.
 */
import type { TranscriptSegment } from "@kneecap/native-bridge";

export function windowSegmentsToClip({
	segments,
	trimStartMicros,
	durationMicros,
}: {
	segments: readonly TranscriptSegment[];
	trimStartMicros: number;
	durationMicros: number;
}): TranscriptSegment[] {
	const windowEnd = trimStartMicros + durationMicros;
	const out: TranscriptSegment[] = [];
	for (const segment of segments) {
		const words = segment.words
			.filter((w) => w.endMicros > trimStartMicros && w.startMicros < windowEnd)
			.map((w) => ({
				...w,
				startMicros: Math.max(0, w.startMicros - trimStartMicros),
				endMicros: Math.max(0, w.endMicros - trimStartMicros),
			}));
		if (words.length === 0) continue;
		out.push({
			...segment,
			startMicros: words[0].startMicros,
			endMicros: words[words.length - 1].endMicros,
			words,
		});
	}
	return out;
}
