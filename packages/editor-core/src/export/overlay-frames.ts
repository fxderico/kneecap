/**
 * PRERENDERED OVERLAY FRAMES — the end of preview-vs-export drift for
 * text and captions (round 37).
 *
 * Until now the native exporter re-implemented text and caption drawing in
 * Swift/CoreText, parallel to the preview's own canvas code. Two
 * implementations of the same visual contract drifted every single round:
 * font size (raw vs height-scaled), border unit (px vs percent), paint
 * order (stroke over fill vs fill over stroke), line breaks (dropped),
 * alignment, line height, letter spacing, z-order, and bitmap resampling
 * on scaled elements. Each was found and fixed one at a time, by
 * measuring exported pixels.
 *
 * This module removes the second implementation. The PREVIEW rasterizes
 * every text/caption node into a full-canvas 2D texture
 * (see `services/renderer/compositor/frame-descriptor.ts` — `draw: (ctx)
 * => renderTextToContext({ node, ctx })`, composited with
 * `fullCanvasTransform`). Here we call the SAME functions, on the same
 * resolved nodes, into a canvas at the EXPORT resolution — so what the
 * exporter composites over the video is, by construction, the same
 * drawing the editor shows. Position, size, weight, wrapping and stacking
 * cannot disagree, because there is only one implementation left.
 *
 * Output is a list of time SEGMENTS, not one image per frame: the overlay
 * layer only changes when a clip enters/leaves, an animation advances, or
 * a caption's active word moves. Each frame's overlay content is hashed
 * (the same params+resolved hash the preview's texture cache uses) and a
 * new PNG is emitted only when that hash changes, so a static title over
 * a 60s clip costs exactly one image.
 *
 * SCOPE: text and captions — the two overlay kinds the preview draws
 * through a 2D context, and the two the founder reported drifting. PiP
 * (video/image) overlays keep coming from the decoder, placed natively by
 * the same `SourcePlacement` math as the main track; stickers/graphics are
 * GPU-composited image sources with no 2D draw path (and are not exported
 * today at all — a separate, disclosed gap).
 */
import type { SceneTracks } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import type { TCanvasSize } from "@/project/types";
import type { FrameRate } from "opencut-wasm";
import { buildScene } from "@/services/renderer/scene-builder";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { resolveRenderTree } from "@/services/renderer/resolve";
import type { AnyBaseNode } from "@/services/renderer/nodes/base-node";
import { TextNode, renderTextToContext } from "@/services/renderer/nodes/text-node";
import {
	CaptionNode,
	renderCaptionToContext,
} from "@/services/renderer/nodes/caption-node";

export interface OverlayFrame {
	/** Inclusive start / exclusive end on the OUTPUT timeline, in ticks. */
	startTicks: number;
	endTicks: number;
	/** Base64 PNG (no data: prefix) at the export resolution, transparent
	 *  everywhere the overlay does not paint. */
	pngBase64: string;
}

type OverlayCanvas = {
	canvas: HTMLCanvasElement | OffscreenCanvas;
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
};

function createCanvas({
	width,
	height,
}: {
	width: number;
	height: number;
}): OverlayCanvas | null {
	if (typeof OffscreenCanvas !== "undefined") {
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		return { canvas, ctx };
	}
	if (typeof document === "undefined") return null;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	return { canvas, ctx };
}

/** Depth-first, which is the order `buildScene` appended them: bottom to
 *  top, captions last (see scene-builder's caption-on-top rule). */
function collectOverlayNodes(root: AnyBaseNode): AnyBaseNode[] {
	const out: AnyBaseNode[] = [];
	const walk = (node: AnyBaseNode) => {
		if (node instanceof TextNode || node instanceof CaptionNode) {
			out.push(node);
		}
		for (const child of node.children) walk(child);
	};
	walk(root);
	return out;
}

function drawOverlayNode({
	node,
	ctx,
}: {
	node: AnyBaseNode;
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}): void {
	// `node.resolved` being null means "not visible at this time" — every
	// resolver returns null outside its element's window.
	if (!node.resolved) return;
	ctx.save();
	if (node instanceof TextNode) {
		// The preview applies a text layer's opacity at the COMPOSITOR
		// (frame-descriptor pushes `opacity: node.resolved.opacity`); there
		// is no compositor layer here, so apply it on the context.
		ctx.globalAlpha = node.resolved.opacity;
		renderTextToContext({ node, ctx });
	} else if (node instanceof CaptionNode) {
		// renderCaptionToContext applies its own globalAlpha already.
		renderCaptionToContext({ node, ctx });
	}
	ctx.restore();
}

/** The preview's own texture-cache key: params + resolved fully determine
 *  the raster (frame-descriptor.ts says so in as many words). */
function overlayHash(nodes: AnyBaseNode[]): string {
	if (nodes.length === 0) return "";
	return JSON.stringify(
		nodes.map((node) => ({
			p: (node as { params?: unknown }).params,
			r: node.resolved,
		})),
	);
}

async function toPngBase64(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
	if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
		const blob = await canvas.convertToBlob({ type: "image/png" });
		const buffer = await blob.arrayBuffer();
		let binary = "";
		const bytes = new Uint8Array(buffer);
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) {
			binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
		}
		return btoa(binary);
	}
	const dataUrl = (canvas as HTMLCanvasElement).toDataURL("image/png");
	return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

export interface RenderOverlayFramesParams {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	/** EXPORT resolution — not the preview's canvas size. The drawing code
	 *  scales every dimension off this (`fontSize × height / 90`), so
	 *  rendering here at the output size is what makes the exported result
	 *  match the preview shape-for-shape at any resolution. */
	canvasSize: TCanvasSize;
	fps: FrameRate;
	durationTicks: number;
	ticksPerSecond: number;
	/** Reports 0..1 while sampling, for the export sheet's progress bar. */
	onProgress?: (fraction: number) => void;
}

export async function renderOverlayFrames({
	tracks,
	mediaAssets,
	canvasSize,
	fps,
	durationTicks,
	ticksPerSecond,
	onProgress,
}: RenderOverlayFramesParams): Promise<OverlayFrame[]> {
	const surface = createCanvas({
		width: canvasSize.width,
		height: canvasSize.height,
	});
	if (!surface) return [];

	const durationSeconds = durationTicks / ticksPerSecond;
	const frameSeconds = fps.denominator / fps.numerator;
	const frameCount = Math.max(1, Math.ceil(durationSeconds / frameSeconds));

	// A renderer instance purely as the resolve context (it carries the
	// width/height the resolvers scale against). Nothing is composited
	// through it here — the 2D draws above are the whole output.
	const renderer = new CanvasRenderer({
		width: canvasSize.width,
		height: canvasSize.height,
		fps,
	});
	// OVERLAY TRACKS ONLY. Resolving the full scene would resolve VideoNodes
	// too — i.e. decode a video frame per sample, thousands of times, for
	// pixels this pass never draws. Stripping the main track and any
	// non-text/caption overlay leaves a tree whose resolve is pure math.
	const overlayOnlyTracks: SceneTracks = {
		main: { ...tracks.main, elements: [] },
		overlay: tracks.overlay.filter(
			(track) => track.type === "text" || track.type === "caption",
		),
		audio: [],
	};
	const tree = buildScene({
		tracks: overlayOnlyTracks,
		mediaAssets,
		duration: durationTicks,
		canvasSize,
		// Transparent everywhere the overlay does not paint — the exporter
		// composites this OVER the video, so the scene background must not
		// contribute. (No background node is emitted for a color background.)
		background: { type: "color", color: "#000000" },
		isPreview: false,
	});

	const frames: OverlayFrame[] = [];
	let openFrame: { startTicks: number; hash: string; pngBase64: string } | null = null;

	const flush = (endTicks: number) => {
		if (!openFrame || openFrame.hash === "") return;
		if (endTicks <= openFrame.startTicks) return;
		frames.push({
			startTicks: openFrame.startTicks,
			endTicks,
			pngBase64: openFrame.pngBase64,
		});
	};

	for (let index = 0; index < frameCount; index++) {
		const timeSeconds = index * frameSeconds;
		const timeTicks = Math.round(timeSeconds * ticksPerSecond);
		await resolveRenderTree({ node: tree, renderer, time: timeTicks });
		const nodes = collectOverlayNodes(tree).filter((node) => node.resolved);
		const hash = overlayHash(nodes);

		if (!openFrame || hash !== openFrame.hash) {
			flush(timeTicks);
			let pngBase64 = "";
			if (hash !== "") {
				surface.ctx.clearRect(0, 0, canvasSize.width, canvasSize.height);
				for (const node of nodes) drawOverlayNode({ node, ctx: surface.ctx });
				pngBase64 = await toPngBase64(surface.canvas);
			}
			openFrame = { startTicks: timeTicks, hash, pngBase64 };
		}
		onProgress?.((index + 1) / frameCount);
	}
	flush(durationTicks);

	return frames;
}
