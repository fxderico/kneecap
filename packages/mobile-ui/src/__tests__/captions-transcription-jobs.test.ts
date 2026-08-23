import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registerNativeMediaPathResolver } from "@kneecap/editor-core";
import { __resetNativeMediaPathResolverForTests } from "@kneecap/editor-core/media/native-paths";
import type { MediaAsset } from "@kneecap/editor-core";
import type { SceneTracks } from "@kneecap/editor-core/timeline";
import { collectTranscriptionJobs } from "../editor/captions-actions";

/**
 * Round 30 — captions transcribe the WHOLE timeline (founder screenshot:
 * a speechless first clip produced "No speech was detected" while later
 * clips were full of speech). `collectTranscriptionJobs` is the pure
 * heart of that: every audible clip in timeline order, muted/hidden
 * skipped, voiceover audio clips included, shared sources dedupe-able by
 * rawPath.
 */

const TICKS = 120_000; // ticks per second (test-local constant)

function asset({ id, rel, duration = 10 }: { id: string; rel: string; duration?: number }): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		file: new File([], `${id}.mp4`),
		duration,
		nativeRelativePath: rel,
	};
}

function videoEl({
	id,
	mediaId,
	startSec,
	durSec,
	extra = {},
}: {
	id: string;
	mediaId: string;
	startSec: number;
	durSec: number;
	extra?: Record<string, unknown>;
}) {
	return {
		id,
		type: "video",
		mediaId,
		name: id,
		startTime: startSec * TICKS,
		duration: durSec * TICKS,
		trimStart: 0,
		trimEnd: 0,
		params: {},
		...extra,
	};
}

function audioEl({
	id,
	mediaId,
	startSec,
	durSec,
}: {
	id: string;
	mediaId: string;
	startSec: number;
	durSec: number;
}) {
	return {
		id,
		type: "audio",
		sourceType: "upload",
		mediaId,
		name: id,
		startTime: startSec * TICKS,
		duration: durSec * TICKS,
		trimStart: 2 * TICKS,
		trimEnd: 0,
		params: {},
	};
}

function tracks({
	main = [] as unknown[],
	overlay = [] as Array<{ type: string; muted?: boolean; elements: unknown[] }>,
	audio = [] as Array<{ muted?: boolean; elements: unknown[] }>,
}) {
	// Structural fixtures: only the fields collectTranscriptionJobs reads.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return {
		main: { id: "main", type: "video", name: "Main", elements: main },
		overlay: overlay.map((t, i) => ({ id: `ov${i}`, name: `ov${i}`, ...t })),
		audio: audio.map((t, i) => ({ id: `au${i}`, type: "audio", name: `au${i}`, ...t })),
	} as unknown as SceneTracks;
}

beforeEach(() => {
	registerNativeMediaPathResolver({
		root: "/custody",
		toPlaybackUri: (uri: string) => uri,
	});
});
afterEach(() => {
	__resetNativeMediaPathResolverForTests();
});

describe("collectTranscriptionJobs (whole-timeline captions)", () => {
	test("collects EVERY audible clip across main, overlay, and audio tracks in timeline order", () => {
		const jobs = collectTranscriptionJobs({
			tracks: tracks({
				main: [videoEl({ id: "b", mediaId: "assetB", startSec: 6, durSec: 4 }), videoEl({ id: "a", mediaId: "assetA", startSec: 0, durSec: 6 })],
				overlay: [
					{ type: "video", elements: [videoEl({ id: "pip", mediaId: "assetC", startSec: 3, durSec: 2 })] },
					// caption/text overlay tracks are not transcription sources
					{ type: "caption", elements: [] },
				],
				audio: [{ elements: [audioEl({ id: "vo", mediaId: "assetD", startSec: 1, durSec: 5 })] }],
			}),
			assets: [
				asset({ id: "assetA", rel: "Media/a.mp4" }),
				asset({ id: "assetB", rel: "Media/b.mp4" }),
				asset({ id: "assetC", rel: "Media/c.mp4" }),
				asset({ id: "assetD", rel: "Media/d.m4a" }),
			],
		});

		expect(jobs.map((j) => j.assetId)).toEqual([
			"assetA", // t=0 (main, listed second in the array — sorted by time)
			"assetD", // t=1 voiceover
			"assetC", // t=3 PiP
			"assetB", // t=6 main
		]);
		expect(jobs.map((j) => j.assetKind)).toEqual(["video", "audio", "video", "video"]);
		// The voiceover's trim window survives (trimStart 2s → micros).
		expect(jobs[1].trimStartMicros).toBe(2_000_000);
		expect(jobs[1].windowMicros).toBe(5_000_000);
		expect(jobs[0].rawPath).toBe("/custody/Media/a.mp4");
	});

	test("skips muted/hidden/audio-disabled clips and muted tracks — captions follow what's audible", () => {
		const jobs = collectTranscriptionJobs({
			tracks: tracks({
				main: [
					videoEl({ id: "ok", mediaId: "assetA", startSec: 0, durSec: 4 }),
					videoEl({ id: "hidden", mediaId: "assetA", startSec: 4, durSec: 2, extra: { hidden: true } }),
					videoEl({ id: "muted", mediaId: "assetA", startSec: 6, durSec: 2, extra: { params: { muted: true } } }),
					videoEl({ id: "noAudio", mediaId: "assetA", startSec: 8, durSec: 2, extra: { isSourceAudioEnabled: false } }),
				],
				overlay: [{ type: "video", muted: true, elements: [videoEl({ id: "x", mediaId: "assetA", startSec: 0, durSec: 2 })] }],
				audio: [{ muted: true, elements: [audioEl({ id: "vo", mediaId: "assetA", startSec: 0, durSec: 2 })] }],
			}),
			assets: [asset({ id: "assetA", rel: "Media/a.mp4" })],
		});
		expect(jobs.map((j) => j.assetId)).toEqual(["assetA"]);
		expect(jobs).toHaveLength(1);
	});

	test("split clips share one source path (transcribe-once, window-per-clip)", () => {
		const jobs = collectTranscriptionJobs({
			tracks: tracks({
				main: [videoEl({ id: "left", mediaId: "assetA", startSec: 0, durSec: 3 }), videoEl({ id: "right", mediaId: "assetA", startSec: 3, durSec: 3 })],
			}),
			assets: [asset({ id: "assetA", rel: "Media/a.mp4" })],
		});
		expect(jobs).toHaveLength(2);
		expect(new Set(jobs.map((j) => j.rawPath)).size).toBe(1);
	});

	test("clips without an on-device file drop out silently (web dev harness)", () => {
		const webAsset = { ...asset({ id: "web", rel: "x" }), nativeRelativePath: undefined };
		const jobs = collectTranscriptionJobs({
			tracks: tracks({ main: [videoEl({ id: "w", mediaId: "web", startSec: 0, durSec: 3 })] }),
			assets: [webAsset],
		});
		expect(jobs).toHaveLength(0);
	});
});
