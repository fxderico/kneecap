import { describe, expect, test } from "bun:test";
import type {
	AudioTrack,
	SceneTracks,
	UploadAudioElement,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import {
	applyDeadSpaceCutToTracks,
	planDeadSpaceCut,
} from "@/timeline/dead-space-cut";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import type { FrameRate } from "opencut-wasm";

const FPS: FrameRate = { numerator: 30, denominator: 1 };

function buildVideoElement(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "clip-1",
		type: "video",
		name: "Take 1",
		startTime: mediaTimeFromSeconds({ seconds: 5 }),
		duration: mediaTimeFromSeconds({ seconds: 10 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "media-1",
		params: {},
		...overrides,
	};
}

const sec = (time: Parameters<typeof mediaTimeToSeconds>[0]["time"]): number =>
	mediaTimeToSeconds({ time });

describe("planDeadSpaceCut", () => {
	test("butts every kept span end to end as its own element", () => {
		const element = buildVideoElement();
		const pieces = planDeadSpaceCut({
			element,
			segments: [
				{ startSec: 1, endSec: 3 },
				{ startSec: 6, endSec: 8 },
			],
			fps: FPS,
		});

		expect(pieces.length).toBe(2);
		// Concatenated: the second piece starts exactly where the first ends.
		expect(sec(pieces[0].startTime)).toBeCloseTo(5, 6);
		expect(sec(pieces[0].duration)).toBeCloseTo(2, 6);
		expect(sec(pieces[1].startTime)).toBeCloseTo(7, 6);
		expect(sec(pieces[1].duration)).toBeCloseTo(2, 6);
		// But not connected: two distinct elements with distinct ids.
		expect(pieces[0].id).not.toBe(pieces[1].id);
		// The first keeps the original identity so selection survives.
		expect(pieces[0].id).toBe("clip-1");
	});

	test("each piece points at its own source window, so a trim handle can pull the cut audio back out", () => {
		const element = buildVideoElement();
		const pieces = planDeadSpaceCut({
			element,
			segments: [
				{ startSec: 1, endSec: 3 },
				{ startSec: 6, endSec: 8 },
			],
			fps: FPS,
		});

		expect(sec(pieces[0].trimStart)).toBeCloseTo(1, 3);
		expect(sec(pieces[0].trimEnd)).toBeCloseTo(7, 3);
		expect(sec(pieces[1].trimStart)).toBeCloseTo(6, 3);
		expect(sec(pieces[1].trimEnd)).toBeCloseTo(2, 3);

		// trimStart + visible span + trimEnd must still describe the whole
		// 10 s source for every piece — the invariant a per-piece rounding
		// error would break.
		for (const piece of pieces) {
			expect(
				sec(piece.trimStart) + sec(piece.duration) + sec(piece.trimEnd),
			).toBeCloseTo(10, 3);
		}
	});

	test("respects an existing trim: source spans are absolute, placement is not", () => {
		const element = buildVideoElement({
			trimStart: mediaTimeFromSeconds({ seconds: 4 }),
			trimEnd: mediaTimeFromSeconds({ seconds: 2 }),
			duration: mediaTimeFromSeconds({ seconds: 4 }),
			startTime: ZERO_MEDIA_TIME,
		});
		// Source seconds 5-6 sit one second into this clip's visible window.
		const pieces = planDeadSpaceCut({
			element,
			segments: [{ startSec: 5, endSec: 6 }],
			fps: FPS,
		});

		expect(pieces.length).toBe(1);
		expect(sec(pieces[0].startTime)).toBeCloseTo(0, 6);
		expect(sec(pieces[0].duration)).toBeCloseTo(1, 6);
		expect(sec(pieces[0].trimStart)).toBeCloseTo(5, 3);
		expect(sec(pieces[0].trimEnd)).toBeCloseTo(4, 3);
	});

	test("a retimed clip's timeline duration is the retimed one", () => {
		const element = buildVideoElement({
			retime: { rate: 2 },
			duration: mediaTimeFromSeconds({ seconds: 5 }),
			startTime: ZERO_MEDIA_TIME,
		});
		// 2 s of SOURCE at 2x plays in 1 s of timeline.
		const pieces = planDeadSpaceCut({
			element,
			segments: [{ startSec: 2, endSec: 4 }],
			fps: FPS,
		});

		expect(pieces.length).toBe(1);
		expect(sec(pieces[0].duration)).toBeCloseTo(1, 3);
		expect(sec(pieces[0].trimStart)).toBeCloseTo(2, 3);
		expect(sec(pieces[0].trimEnd)).toBeCloseTo(6, 3);
	});

	test("snaps cuts to the project frame grid", () => {
		const element = buildVideoElement({ startTime: ZERO_MEDIA_TIME });
		const pieces = planDeadSpaceCut({
			element,
			segments: [{ startSec: 1.0173, endSec: 2.9944 }],
			fps: FPS,
		});

		const frame = 1 / 30;
		expect(sec(pieces[0].trimStart) / frame).toBeCloseTo(
			Math.round(sec(pieces[0].trimStart) / frame),
			2,
		);
		expect(sec(pieces[0].duration) / frame).toBeCloseTo(
			Math.round(sec(pieces[0].duration) / frame),
			2,
		);
	});

	test("drops a span too thin to hold a frame", () => {
		const element = buildVideoElement({ startTime: ZERO_MEDIA_TIME });
		const pieces = planDeadSpaceCut({
			element,
			segments: [
				{ startSec: 1, endSec: 1.005 },
				{ startSec: 3, endSec: 5 },
			],
			fps: FPS,
		});
		expect(pieces.length).toBe(1);
		expect(sec(pieces[0].duration)).toBeCloseTo(2, 3);
	});
});

function buildAudioElement(
	overrides: Partial<UploadAudioElement> = {},
): UploadAudioElement {
	return {
		id: "audio-1",
		type: "audio",
		sourceType: "upload",
		name: "Voice",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTimeFromSeconds({ seconds: 10 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "media-1",
		params: {},
		...overrides,
	};
}

function buildTracks({
	main,
	audio = [],
}: {
	main: VideoElement[];
	audio?: UploadAudioElement[];
}): SceneTracks {
	const mainTrack: VideoTrack = {
		id: "main-track",
		type: "video",
		name: "Main",
		muted: false,
		hidden: false,
		elements: main,
	};
	const audioTrack: AudioTrack = {
		id: "audio-track",
		type: "audio",
		name: "Audio",
		muted: false,
		elements: audio,
	};
	return { overlay: [], main: mainTrack, audio: [audioTrack] };
}

describe("applyDeadSpaceCutToTracks", () => {
	test("closes the hole across the WHOLE main track, not just between the pieces", () => {
		const target = buildVideoElement({
			id: "b",
			startTime: mediaTimeFromSeconds({ seconds: 5 }),
			duration: mediaTimeFromSeconds({ seconds: 10 }),
		});
		const before = buildTracks({
			main: [
				buildVideoElement({ id: "a", startTime: ZERO_MEDIA_TIME, duration: mediaTimeFromSeconds({ seconds: 5 }) }),
				target,
				buildVideoElement({
					id: "c",
					startTime: mediaTimeFromSeconds({ seconds: 15 }),
					duration: mediaTimeFromSeconds({ seconds: 5 }),
				}),
			],
		});
		const pieces = planDeadSpaceCut({
			element: target,
			segments: [
				{ startSec: 0, endSec: 3 },
				{ startSec: 7, endSec: 10 },
			],
			fps: FPS,
		});

		const after = applyDeadSpaceCutToTracks({
			tracks: before,
			ref: { trackId: "main-track", elementId: "b" },
			pieces,
		});
		const laid = after.main.elements.map((el) => [
			el.id,
			Number(sec(el.startTime).toFixed(3)),
			Number(sec(el.duration).toFixed(3)),
		]);

		expect(laid.length).toBe(4);
		// a(0-5) | b1(5-8) | b2(8-11) | c(11-16) — every clip butts its
		// neighbour, and the 4 s of dead space is gone from the whole track.
		expect(laid[0]).toEqual(["a", 0, 5]);
		expect(laid[1][1]).toBe(5);
		expect(laid[1][2]).toBe(3);
		expect(laid[2][1]).toBe(8);
		expect(laid[2][2]).toBe(3);
		expect(laid[3]).toEqual(["c", 11, 5]);
		// Concatenated, but still four separate clips.
		expect(new Set(after.main.elements.map((el) => el.id)).size).toBe(4);
	});

	test("leaves a free-position track's other clips where they are", () => {
		const target = buildAudioElement({
			id: "voice",
			startTime: mediaTimeFromSeconds({ seconds: 2 }),
			duration: mediaTimeFromSeconds({ seconds: 10 }),
		});
		const neighbour = buildAudioElement({
			id: "music",
			startTime: mediaTimeFromSeconds({ seconds: 30 }),
			duration: mediaTimeFromSeconds({ seconds: 5 }),
		});
		const before = buildTracks({ main: [], audio: [target, neighbour] });
		const pieces = planDeadSpaceCut({
			element: target,
			segments: [
				{ startSec: 0, endSec: 2 },
				{ startSec: 8, endSec: 10 },
			],
			fps: FPS,
		});

		const after = applyDeadSpaceCutToTracks({
			tracks: before,
			ref: { trackId: "audio-track", elementId: "voice" },
			pieces,
		});
		const elements = after.audio[0].elements;
		expect(elements.length).toBe(3);
		expect(sec(elements[0].startTime)).toBeCloseTo(2, 6);
		expect(sec(elements[1].startTime)).toBeCloseTo(4, 6);
		// The unrelated clip did NOT ripple.
		expect(elements[2].id).toBe("music");
		expect(sec(elements[2].startTime)).toBeCloseTo(30, 6);
	});

	test("does not touch a track the clip isn't on", () => {
		const target = buildVideoElement({ id: "x", startTime: ZERO_MEDIA_TIME });
		const other = buildAudioElement({ id: "y", startTime: mediaTimeFromSeconds({ seconds: 40 }) });
		const before = buildTracks({ main: [target], audio: [other] });
		const after = applyDeadSpaceCutToTracks({
			tracks: before,
			ref: { trackId: "main-track", elementId: "x" },
			pieces: planDeadSpaceCut({ element: target, segments: [{ startSec: 1, endSec: 4 }], fps: FPS }),
		});
		expect(after.audio[0].elements).toEqual(before.audio[0].elements);
	});
});
