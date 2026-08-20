import type { TCanvasSize } from "@/project/types";

export const DEFAULT_CANVAS_PRESETS: TCanvasSize[] = [
	{ width: 1920, height: 1080 },
	{ width: 1080, height: 1920 },
	{ width: 1080, height: 1080 },
	{ width: 1440, height: 1080 },
];

export const DEFAULT_CANVAS_SIZE: TCanvasSize = { width: 1920, height: 1080 };

/**
 * CapCut-style "original" aspect adoption: the FIRST visual asset imported
 * into a factory-default project decides the canvas aspect ratio, so a
 * portrait phone video gets a portrait canvas instead of being letterboxed
 * into the 1920x1080 default (and exports fill the frame instead of floating
 * in black — the preview/export both render the canvas, so the canvas IS the
 * output shape).
 *
 * Returns the canvas size to adopt, or null when nothing should change:
 *   - the user already made a canvas choice (mode !== "preset", or the size
 *     differs from the untouched factory default) — user intent always wins;
 *   - visual media already existed before this import — the project's aspect
 *     is established by the first visual asset only;
 *   - the imported batch has no video/image with usable dimensions.
 *
 * The adopted size preserves the asset's exact aspect, normalized to the
 * 1080p class (short side 1080, long side capped at 1920 for extreme
 * aspects) with even dimensions — encoder-friendly, and bounded so preview
 * rendering cost does not scale with source resolution (a 4K import must not
 * quadruple every preview frame; export picks its own resolution multiplier
 * in the export sheet).
 */
export function getAdoptedCanvasSizeForImportedMedia({
	currentSize,
	currentMode,
	hadVisualMediaBefore,
	importedAssets,
}: {
	currentSize: TCanvasSize;
	currentMode: "preset" | "custom" | undefined;
	hadVisualMediaBefore: boolean;
	importedAssets: Array<{ type: string; width?: number; height?: number }>;
}): TCanvasSize | null {
	if (hadVisualMediaBefore) return null;
	if (currentMode !== undefined && currentMode !== "preset") return null;
	if (
		currentSize.width !== DEFAULT_CANVAS_SIZE.width ||
		currentSize.height !== DEFAULT_CANVAS_SIZE.height
	) {
		return null;
	}

	const first = importedAssets.find(
		(asset) =>
			(asset.type === "video" || asset.type === "image") &&
			(asset.width ?? 0) > 0 &&
			(asset.height ?? 0) > 0,
	);
	if (!first) return null;

	const sourceWidth = first.width as number;
	const sourceHeight = first.height as number;

	// Normalize: short side 1080 (never upscale a smaller source), then cap
	// the long side at 1920 for extreme aspect ratios.
	const shortSide = Math.min(sourceWidth, sourceHeight);
	let scale = Math.min(1, 1080 / shortSide);
	const longSide = Math.max(sourceWidth, sourceHeight) * scale;
	if (longSide > 1920) {
		scale *= 1920 / longSide;
	}

	const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
	const adopted = {
		width: even(sourceWidth * scale),
		height: even(sourceHeight * scale),
	};
	if (
		adopted.width === currentSize.width &&
		adopted.height === currentSize.height
	) {
		return null; // already exactly the default shape — nothing to do
	}
	return adopted;
}
