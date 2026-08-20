import { describe, expect, it } from "bun:test";
import type { MediaAsset } from "@kneecap/editor-core";
import type { TimelineElement } from "@kneecap/editor-core/timeline";
import { pointInElement } from "./preview-hit-test";

// Portrait 1080x1920 canvas, landscape 1920x1080 video: contain-fit scales
// by 0.5625 -> displayed 1080x607.5 centered at (540, 960).
const CANVAS = { canvasWidth: 1080, canvasHeight: 1920 };

const media = new Map<string, MediaAsset>([
	["m1", { id: "m1", width: 1920, height: 1080 } as MediaAsset],
]);

function videoElement(params: Record<string, number> = {}): TimelineElement {
	return {
		id: "el-1",
		type: "video",
		mediaId: "m1",
		params,
	} as unknown as TimelineElement;
}

describe("pointInElement (preview hit-testing geometry)", () => {
	it("hits the center of a contain-fit video", () => {
		expect(
			pointInElement({ element: videoElement(), mediaById: media, ...CANVAS, x: 540, y: 960 }),
		).toBe(true);
	});

	it("misses the letterbox band above the contain-fit video", () => {
		// video band spans y in [656.25, 1263.75]
		expect(
			pointInElement({ element: videoElement(), mediaById: media, ...CANVAS, x: 540, y: 400 }),
		).toBe(false);
	});

	it("respects position offset", () => {
		const el = videoElement({ "transform.positionX": 300, "transform.positionY": -500 });
		expect(pointInElement({ element: el, mediaById: media, ...CANVAS, x: 840, y: 460 })).toBe(true);
		expect(pointInElement({ element: el, mediaById: media, ...CANVAS, x: 540, y: 960 })).toBe(false);
	});

	it("respects scale (pinched-down clip has smaller bounds)", () => {
		const el = videoElement({ "transform.scaleX": 0.25, "transform.scaleY": 0.25 });
		// scaled size: 270 x ~152, centered — edge of the FULL-size band no longer hits
		expect(pointInElement({ element: el, mediaById: media, ...CANVAS, x: 60, y: 960 })).toBe(false);
		expect(pointInElement({ element: el, mediaById: media, ...CANVAS, x: 540, y: 960 })).toBe(true);
	});

	it("respects rotation (corner of the unrotated box misses a 90-degree rotated slab)", () => {
		// Unrotated: wide slab (1080 x 607.5). Rotated 90deg: tall slab
		// (607.5 wide x 1080 tall). A point far left on the horizontal
		// mid-line is inside the unrotated slab but OUTSIDE the rotated one.
		const flat = videoElement();
		const rotated = videoElement({ "transform.rotate": 90 });
		expect(pointInElement({ element: flat, mediaById: media, ...CANVAS, x: 60, y: 960 })).toBe(true);
		expect(pointInElement({ element: rotated, mediaById: media, ...CANVAS, x: 60, y: 960 })).toBe(false);
		// ...and a point above the center inside the rotated slab's height.
		expect(pointInElement({ element: rotated, mediaById: media, ...CANVAS, x: 540, y: 480 })).toBe(true);
		expect(pointInElement({ element: flat, mediaById: media, ...CANVAS, x: 540, y: 480 })).toBe(false);
	});

	it("returns false for elements without resolvable source dims (text)", () => {
		const text = { id: "t1", type: "text", params: {} } as unknown as TimelineElement;
		expect(pointInElement({ element: text, mediaById: media, ...CANVAS, x: 540, y: 960 })).toBe(false);
	});
});

describe("metadata-less media stays grabbable", () => {
	it("hits a video whose asset record lacks dimensions (full-frame fallback)", () => {
		const bare = new Map();
		expect(
			pointInElement({ element: videoElement(), mediaById: bare, ...CANVAS, x: 540, y: 960 }),
		).toBe(true);
	});
});

describe("two-pass precision (fallback must not steal touches)", () => {
	it("rejects a dimension-less element when fallback is disabled (precise pass)", () => {
		const bare = new Map();
		expect(
			pointInElement({
				element: videoElement(),
				mediaById: bare,
				...CANVAS,
				x: 540,
				y: 960,
				fallbackToFullFrame: false,
			}),
		).toBe(false);
	});
});
