import { describe, expect, it } from "bun:test";
import {
	DEFAULT_CANVAS_SIZE,
	getAdoptedCanvasSizeForImportedMedia,
} from "./sizes";

const base = {
	currentSize: { ...DEFAULT_CANVAS_SIZE },
	currentMode: "preset" as const,
	hadVisualMediaBefore: false,
};

describe("getAdoptedCanvasSizeForImportedMedia (first-import aspect adoption)", () => {
	it("adopts a portrait canvas for a portrait phone video", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				importedAssets: [{ type: "video", width: 1080, height: 1920 }],
			}),
		).toEqual({ width: 1080, height: 1920 });
	});

	it("keeps the exact aspect for a 4K portrait source, normalized to the 1080 class", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				importedAssets: [{ type: "video", width: 2160, height: 3840 }],
			}),
		).toEqual({ width: 1080, height: 1920 });
	});

	it("returns null for a landscape 16:9 video (canvas already the default shape)", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				importedAssets: [{ type: "video", width: 3840, height: 2160 }],
			}),
		).toBeNull();
	});

	it("never upscales a small source's shape past its own pixels", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				importedAssets: [{ type: "video", width: 640, height: 480 }],
			}),
		).toEqual({ width: 640, height: 480 });
	});

	it("caps the long side at 1920 for extreme aspect ratios", () => {
		const adopted = getAdoptedCanvasSizeForImportedMedia({
			...base,
			importedAssets: [{ type: "video", width: 4320, height: 1080 }],
		});
		expect(adopted).not.toBeNull();
		expect(Math.max(adopted!.width, adopted!.height)).toBeLessThanOrEqual(1920);
		// aspect preserved within even-rounding tolerance
		expect(adopted!.width / adopted!.height).toBeCloseTo(4, 1);
	});

	it("produces even dimensions (encoder requirement)", () => {
		const adopted = getAdoptedCanvasSizeForImportedMedia({
			...base,
			importedAssets: [{ type: "video", width: 1079, height: 1921 }],
		});
		expect(adopted).not.toBeNull();
		expect(adopted!.width % 2).toBe(0);
		expect(adopted!.height % 2).toBe(0);
	});

	it("respects an existing visual asset (aspect already established)", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				hadVisualMediaBefore: true,
				importedAssets: [{ type: "video", width: 1080, height: 1920 }],
			}),
		).toBeNull();
	});

	it("respects an explicit user canvas choice (non-default size)", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				currentSize: { width: 1080, height: 1080 },
				importedAssets: [{ type: "video", width: 1080, height: 1920 }],
			}),
		).toBeNull();
	});

	it("respects custom mode", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				currentMode: "custom",
				importedAssets: [{ type: "video", width: 1080, height: 1920 }],
			}),
		).toBeNull();
	});

	it("ignores audio assets and assets without dimensions", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				importedAssets: [
					{ type: "audio" },
					{ type: "video", width: 0, height: 0 },
				],
			}),
		).toBeNull();
	});

	it("adopts from an image import too", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				importedAssets: [{ type: "image", width: 3000, height: 3000 }],
			}),
		).toEqual({ width: 1080, height: 1080 });
	});
});
