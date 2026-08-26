import type { FrameRate } from "opencut-wasm";
import { frameRateToFloat } from "@/fps/utils";
import { splitAnimationsAtTime } from "@/animation";
import { getClipTimeAtSourceTime, getSourceSpanAtClipTime } from "@/retime";
import { isRetimableElement, type SceneTracks, type TimelineElement } from "@/timeline";
import { generateUUID } from "@/utils/id";
import {
	addMediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
	type MediaTime,
} from "@/wasm";
import type { TimeSpanSec } from "@/media/dead-space";

/**
 * Turns the kept spans `detectDeadSpace` found into the replacement clips
 * that go on the timeline.
 *
 * "The clips that it makes should be concatenated but not connected"
 * (founder, 2026-08-25): each kept span becomes its OWN element, butted end
 * to end with no gap — not one welded clip. Every piece stays individually
 * selectable, movable and trimmable, and because each carries the real
 * `trimStart`/`trimEnd` of its own source window, dragging a handle back out
 * recovers the audio that was cut. Nothing is destroyed; the source window
 * is just re-described.
 *
 * Cut points are snapped to the PROJECT frame grid before anything is
 * derived from them — a cut at 1.0173 s on a video clip is not a thing that
 * exists, and letting one through puts every later piece a fraction of a
 * frame off from the frame it claims to start on.
 *
 * The trim math is deliberately the same shape as `SplitElementsCommand`:
 * snap the SOURCE-side boundary once and derive both trims from it, so
 * `trimStart + span + trimEnd` can't drift by a tick per piece.
 */
export function planDeadSpaceCut({
	element,
	segments,
	fps,
}: {
	element: TimelineElement;
	/** Kept spans in absolute SOURCE seconds (what `detectDeadSpace` returns). */
	segments: TimeSpanSec[];
	fps: FrameRate;
}): TimelineElement[] {
	const durationSec = mediaTimeToSeconds({ time: element.duration });
	const retime = isRetimableElement(element) ? element.retime : undefined;
	const windowStartSec = mediaTimeToSeconds({ time: element.trimStart });
	const totalSourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({ clipTime: element.duration, retime }),
	});
	const frameSec = 1 / frameRateToFloat(fps);

	const snap = ({ sec }: { sec: number }): number =>
		Math.min(durationSec, Math.max(0, Math.round(sec / frameSec) * frameSec));

	const pieces: TimelineElement[] = [];
	let cursor: MediaTime = element.startTime;

	for (const segment of segments) {
		const clipStartSec = snap({
			sec: getClipTimeAtSourceTime({
				sourceTime: segment.startSec - windowStartSec,
				retime,
			}),
		});
		const clipEndSec = snap({
			sec: getClipTimeAtSourceTime({
				sourceTime: segment.endSec - windowStartSec,
				retime,
			}),
		});
		// A piece thinner than one frame has no frame to show. Frame snapping
		// can produce one from a span that only just cleared `minKeepSec`.
		if (clipEndSec - clipStartSec < frameSec) continue;

		// Everything below is TICKS. `getSourceSpanAtClipTime` is a bare
		// multiply by the rate and `roundMediaTime` rounds a tick count, so
		// handing either one seconds silently produces a span 60000x too
		// small — the same unit discipline `SplitElementsCommand` follows.
		const clipStart = mediaTimeFromSeconds({ seconds: clipStartSec });
		const clipEnd = mediaTimeFromSeconds({ seconds: clipEndSec });
		const visibleDuration = subMediaTime({ a: clipEnd, b: clipStart });
		const leadingSourceSpan = roundMediaTime({
			time: getSourceSpanAtClipTime({ clipTime: clipStart, retime }),
		});
		const throughSourceSpan = roundMediaTime({
			time: getSourceSpanAtClipTime({ clipTime: clipEnd, retime }),
		});

		pieces.push({
			...element,
			// The first piece keeps the original identity so selection,
			// transitions and anything else holding this element's id survive
			// a cut that didn't touch the clip's opening frame.
			id: pieces.length === 0 ? element.id : generateUUID(),
			name: pieces.length === 0 ? element.name : `${element.name} (${pieces.length + 1})`,
			startTime: cursor,
			duration: visibleDuration,
			trimStart: addMediaTime({ a: element.trimStart, b: leadingSourceSpan }),
			trimEnd: addMediaTime({
				a: element.trimEnd,
				b: subMediaTime({ a: totalSourceSpan, b: throughSourceSpan }),
			}),
			animations: sliceAnimations({
				element,
				from: clipStart,
				span: visibleDuration,
			}),
			...(retime !== undefined ? { retime } : {}),
		} as TimelineElement);

		cursor = addMediaTime({ a: cursor, b: visibleDuration });
	}

	return pieces;
}

/**
 * Keyframes for one piece: split the element's animation channels at the
 * piece's start (keep the right side, which `splitAnimationsAtTime` rebases
 * to that point) and then at its length (keep the left). Composing the
 * existing pairwise split twice is what keeps a multi-cut consistent with
 * what a hand-run sequence of splits would have produced.
 */
function sliceAnimations({
	element,
	from,
	span,
}: {
	element: TimelineElement;
	from: MediaTime;
	span: MediaTime;
}): TimelineElement["animations"] {
	if (!element.animations) return undefined;
	const { rightAnimations } = splitAnimationsAtTime({
		animations: element.animations,
		splitTime: from,
	});
	if (!rightAnimations) return undefined;
	const { leftAnimations } = splitAnimationsAtTime({
		animations: rightAnimations,
		splitTime: span,
	});
	return leftAnimations;
}

/**
 * Swaps one element for its pieces across the scene and re-butts the main
 * track.
 *
 * The main track is magnetic (founder, 2026-08-22: "split a clip twice and
 * cut the middle clip — the 2 clips don't snap together"), so removing dead
 * space from a main-track clip closes the hole for the WHOLE track, not just
 * between the new pieces. Free-position tracks keep their own layout: the
 * pieces occupy the span the clip started at and nothing else on that track
 * moves.
 *
 * Pure: hand it `before`, get `after`, and let one `TracksSnapshotCommand`
 * own apply/undo — so however many pieces a clip became, one undo restores
 * it.
 */
export function applyDeadSpaceCutToTracks({
	tracks,
	ref,
	pieces,
}: {
	tracks: SceneTracks;
	ref: { trackId: string; elementId: string };
	pieces: TimelineElement[];
}): SceneTracks {
	const splice = <T extends { id: string; elements: TimelineElement[] }>(track: T): T =>
		track.id !== ref.trackId
			? track
			: {
					...track,
					elements: track.elements.flatMap((element) =>
						element.id === ref.elementId ? pieces : [element],
					),
				};

	const main = splice(tracks.main);
	let cursor = ZERO_MEDIA_TIME;
	const rebutted = [...main.elements]
		.sort((a, b) => a.startTime - b.startTime)
		.map((element) => {
			const next = element.startTime === cursor ? element : { ...element, startTime: cursor };
			cursor = addMediaTime({ a: cursor, b: element.duration });
			return next;
		});

	return {
		main: { ...main, elements: rebutted },
		overlay: tracks.overlay.map(splice),
		audio: tracks.audio.map(splice),
	};
}
