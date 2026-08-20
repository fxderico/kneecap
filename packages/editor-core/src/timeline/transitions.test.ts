import { describe, expect, it } from "bun:test";
import type { MediaTime } from "@/wasm";
import type { SceneTracks, TSceneTransition, VideoTrack } from "./types";
import {
	applyTransitionsToSceneTracks,
	buildNominalToOutputRemap,
	clampedTransitionDuration,
	computeMainTrackPlacements,
	remapNominalTick,
} from "./transitions";

// The verify-export-pipeline fixture's numbers (ticksPerSecond = 120000):
// clip-a 2.0s, clip-b ~1.333s, cross-fade 0.2s — the Swift harness asserts
// clip-b is pulled earlier by exactly the transition duration and the total
// shrinks by it. This file asserts the TS port produces the same placements.
const t = (seconds: number) => Math.round(seconds * 120_000) as MediaTime;

const clipA = { id: "clip-a", startTime: t(0), duration: t(2.0) };
const clipB = { id: "clip-b", startTime: t(2.0), duration: t(2.0 / 1.5) };

const fade = (duration: number, after = "clip-a"): TSceneTransition => ({
	id: `tr-${after}`,
	afterElementId: after,
	kind: "fade",
	duration: t(duration),
});

describe("computeMainTrackPlacements (port parity with MainTrackPlacement.swift)", () => {
	it("pulls the incoming clip earlier by exactly the transition duration", () => {
		const { placements, windows } = computeMainTrackPlacements({
			elements: [clipA, clipB],
			transitions: [fade(0.2)],
		});
		expect(windows.length).toBe(1);
		expect(windows[0].durationTicks).toBe(t(0.2));
		expect(placements[1].insertStartTicks).toBe(t(1.8));
		expect(placements[0].trailingOverlapTicks).toBe(t(0.2));
		expect(placements[1].leadingOverlapTicks).toBe(t(0.2));
		// total placed duration == clipA + clipB - overlap
		expect(placements[1].insertStartTicks + placements[1].insertDurationTicks).toBe(
			t(2.0) + t(2.0 / 1.5) - t(0.2),
		);
	});

	it("ripples downstream clips left by the cumulative overlap", () => {
		const clipC = { id: "clip-c", startTime: t(2.0 + 2.0 / 1.5), duration: t(2.0) };
		const { placements } = computeMainTrackPlacements({
			elements: [clipA, clipB, clipC],
			transitions: [fade(0.2)],
		});
		// clip-c has no incoming transition but starts where compressed clip-b ends
		expect(placements[2].insertStartTicks).toBe((t(1.8) + t(2.0 / 1.5)) as MediaTime);
		expect(placements[2].leadingOverlapTicks).toBe(t(0));
	});

	it("drops a transition whose after-clip was deleted (dormant, no throw)", () => {
		const { windows } = computeMainTrackPlacements({
			elements: [clipA, clipB],
			transitions: [fade(0.2, "deleted-clip")],
		});
		expect(windows.length).toBe(0);
	});

	it("drops a transition after the LAST clip", () => {
		const { windows } = computeMainTrackPlacements({
			elements: [clipA, clipB],
			transitions: [fade(0.2, "clip-b")],
		});
		expect(windows.length).toBe(0);
	});
});

describe("clampedTransitionDuration", () => {
	it("clamps to half the shorter neighbor minus one tick (Swift parity)", () => {
		const clamped = clampedTransitionDuration({
			requested: t(5),
			prevDuration: t(2),
			nextDuration: t(4),
		});
		expect(clamped).toBe((Math.floor((2 * 120_000) / 2) - 1) as MediaTime);
	});

	it("passes a small duration through unchanged", () => {
		expect(
			clampedTransitionDuration({
				requested: t(0.2),
				prevDuration: t(2),
				nextDuration: t(2),
			}),
		).toBe(t(0.2));
	});
});

describe("nominal -> output remap", () => {
	it("shifts starts at/after the incoming clip by the cumulative overlap", () => {
		const { windows } = computeMainTrackPlacements({
			elements: [clipA, clipB],
			transitions: [fade(0.2)],
		});
		const breakpoints = buildNominalToOutputRemap({
			sortedElements: [clipA, clipB],
			windows,
		});
		// before the transition: unshifted
		expect(remapNominalTick({ nominalTick: t(1.0), breakpoints })).toBe(t(1.0));
		// at/after clip-b's nominal start: shifted by 0.2s
		expect(remapNominalTick({ nominalTick: t(2.5), breakpoints })).toBe(t(2.3));
	});
});

function makeTracks(): SceneTracks {
	const main = {
		id: "track-main",
		type: "video",
		kind: "main",
		name: "Main",
		elements: [
			{ ...clipA, type: "video", params: {} },
			{ ...clipB, type: "video", params: {} },
		],
	} as unknown as VideoTrack;
	const overlay = {
		id: "track-text",
		type: "text",
		kind: "overlay",
		name: "Text",
		elements: [{ id: "text-1", startTime: t(2.5), duration: t(1.0), type: "text", params: {} }],
	} as unknown as SceneTracks["overlay"][number];
	return { main, overlay: [overlay], audio: [] };
}

describe("applyTransitionsToSceneTracks", () => {
	it("returns the SAME reference when there are no transitions (memo-friendly)", () => {
		const tracks = makeTracks();
		expect(applyTransitionsToSceneTracks({ tracks, transitions: [] })).toBe(tracks);
		expect(applyTransitionsToSceneTracks({ tracks, transitions: undefined })).toBe(tracks);
	});

	it("shifts the incoming main clip and injects a fade-in opacity channel", () => {
		const tracks = makeTracks();
		const derived = applyTransitionsToSceneTracks({
			tracks,
			transitions: [fade(0.2)],
		});
		expect(derived).not.toBe(tracks);
		const b = derived.main.elements.find((e) => e.id === "clip-b")!;
		expect(b.startTime).toBe(t(1.8));
		const channel = b.animations?.opacity as { keys: Array<{ time: number; value: number }> };
		expect(channel).toBeDefined();
		expect(channel.keys[0].value).toBe(0);
		expect(channel.keys[1].value).toBe(1);
		expect(channel.keys[1].time).toBe(t(0.2));
		// outgoing clip untouched in place and opacity
		const a = derived.main.elements.find((e) => e.id === "clip-a")!;
		expect(a.startTime).toBe(t(0));
		expect(a.animations?.opacity).toBeUndefined();
	});

	it("remaps overlay starts through the step function", () => {
		const derived = applyTransitionsToSceneTracks({
			tracks: makeTracks(),
			transitions: [fade(0.2)],
		});
		expect(derived.overlay[0].elements[0].startTime).toBe(t(2.3));
	});

	it("never clobbers a user-authored opacity channel", () => {
		const tracks = makeTracks();
		const userChannel = { keys: [] };
		(tracks.main.elements[1] as { animations?: unknown }).animations = {
			opacity: userChannel,
		};
		const derived = applyTransitionsToSceneTracks({
			tracks,
			transitions: [fade(0.2)],
		});
		const b = derived.main.elements.find((e) => e.id === "clip-b")!;
		expect(b.animations?.opacity).toBe(userChannel as never);
	});
});
