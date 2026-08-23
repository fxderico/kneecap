import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registerNativeMediaPathResolver } from "@kneecap/editor-core";
import { __resetNativeMediaPathResolverForTests } from "@kneecap/editor-core/media/native-paths";
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

function asset(id: string, rel: string, duration = 10) {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		file: new File([], `${id}.mp4`),
		duration,
		nativeRelativePath: rel,
	} as never;
}

function videoEl(
	id: string,
	mediaId: string,
	startSec: number,
	durSec: number,
	extra: Record<string, unknown> = {},
) {
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
	} as never;
}

function audioEl(id: string, mediaId: string, startSec: number, durSec: number) {
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
	} as never;
}

function tracks({
	main = [] as unknown[],
	overlay = [] as Array<{ type: string; muted?: boolean; elements: unknown[] }>,
	audio = [] as Array<{ muted?: boolean; elements: unknown[] }>,
}) {
	return {
		main: { id: "main", type: "video", name: "Main", elements: main },
		overlay: overlay.map((t, i) => ({ id: `ov${i}`, name: `ov${i}`, ...t })),
		audio: audio.map((t, i) => ({ id: `au${i}`, type: "audio", name: `au${i}`, ...t })),
	} as never;
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
				main: [videoEl("b", "assetB", 6, 4), videoEl("a", "assetA", 0, 6)],
				overlay: [
					{ type: "video", elements: [videoEl("pip", "assetC", 3, 2)] },
					// caption/text overlay tracks are not transcription sources
					{ type: "caption", elements: [] },
				],
				audio: [{ elements: [audioEl("vo", "assetD", 1, 5)] }],
			}),
			assets: [
				asset("assetA", "Media/a.mp4"),
				asset("assetB", "Media/b.mp4"),
				asset("assetC", "Media/c.mp4"),
				asset("assetD", "Media/d.m4a"),
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
					videoEl("ok", "assetA", 0, 4),
					videoEl("hidden", "assetA", 4, 2, { hidden: true }),
					videoEl("muted", "assetA", 6, 2, { params: { muted: true } }),
					videoEl("noAudio", "assetA", 8, 2, { isSourceAudioEnabled: false }),
				],
				overlay: [{ type: "video", muted: true, elements: [videoEl("x", "assetA", 0, 2)] }],
				audio: [{ muted: true, elements: [audioEl("vo", "assetA", 0, 2)] }],
			}),
			assets: [asset("assetA", "Media/a.mp4")],
		});
		expect(jobs.map((j) => j.assetId)).toEqual(["assetA"]);
		expect(jobs).toHaveLength(1);
	});

	test("split clips share one source path (transcribe-once, window-per-clip)", () => {
		const jobs = collectTranscriptionJobs({
			tracks: tracks({
				main: [videoEl("left", "assetA", 0, 3), videoEl("right", "assetA", 3, 3)],
			}),
			assets: [asset("assetA", "Media/a.mp4")],
		});
		expect(jobs).toHaveLength(2);
		expect(new Set(jobs.map((j) => j.rawPath)).size).toBe(1);
	});

	test("clips without an on-device file drop out silently (web dev harness)", () => {
		const webAsset = { ...(asset("web", "x") as object), nativeRelativePath: undefined } as never;
		const jobs = collectTranscriptionJobs({
			tracks: tracks({ main: [videoEl("w", "web", 0, 3)] }),
			assets: [webAsset],
		});
		expect(jobs).toHaveLength(0);
	});
});
