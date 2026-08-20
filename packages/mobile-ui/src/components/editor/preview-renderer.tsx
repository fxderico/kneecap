/**
 * Live preview rendering for the mobile editor — closes the "chrome-only
 * placeholder, does not render frame content" gap PreviewStage's own header
 * disclosed (and the founder hit on device: playback ran over a black
 * preview, 2026-08-18).
 *
 * Same architecture as apps/web's preview (apps/web/src/preview/components/
 * index.tsx, RenderTreeController + PreviewCanvas), deliberately minus the
 * web-only chrome (zoom/pan viewport, overlay handles, context menus):
 *   1. a scene-sync effect maps live engine state -> buildScene() ->
 *      editor.renderer.setRenderTree()
 *   2. a CanvasRenderer draws the tree into its output canvas (wgpu/wasm
 *      compositor underneath — WebGPU preferred, WebGL2 fallback)
 *   3. a rAF loop renders the frame under the playhead, skipping when
 *      neither the frame index nor the tree changed (same guard as web).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { TICKS_PER_SECOND, type MediaTime } from "@kneecap/editor-core";
import { useEditor } from "@kneecap/editor-core/react";
import { isVisualElement } from "@kneecap/editor-core/timeline";
import type { ParamValues } from "@kneecap/editor-core/params";
import { useSelectedElement } from "../../editor/use-live-editor";
import { selectElement } from "../../editor/actions";
import { hitTestPreview } from "../../editor/preview-hit-test";
import { CanvasRenderer } from "@kneecap/editor-core/services/renderer/canvas-renderer";
import { buildScene } from "@kneecap/editor-core/services/renderer/scene-builder";
import type { RootNode } from "@kneecap/editor-core/services/renderer/nodes/root-node";
import { initializeGpu } from "opencut-wasm";

/** Same contract as apps/web's `initializeGpuRenderer()`: init once per
 *  process, NEVER reject — a GPU-less environment degrades (the compositor
 *  falls back off the wgpu path) instead of crashing. Constructing
 *  `CanvasRenderer` before this resolves was CRITICAL finding #1 of the
 *  2026-08-18 test sweep: `initializeGpu()` had never been called on the
 *  mobile shell, the first render threw "GPU context not initialized"
 *  inside React render, and the entire app unmounted to a black screen. */
let gpuInitPromise: Promise<boolean> | null = null;
export function ensurePreviewGpu(): Promise<boolean> {
	return ensureGpu();
}
function ensureGpu(): Promise<boolean> {
	if (!gpuInitPromise) {
		gpuInitPromise = initializeGpu()
			.then(() => true)
			.catch((error: unknown) => {
				console.warn(
					`GPU renderer unavailable: ${error instanceof Error ? error.message : String(error)}`,
				);
				return false;
			});
	}
	return gpuInitPromise;
}

export function PreviewRenderer() {
	const editor = useEditor();
	const [gpuReady, setGpuReady] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void ensureGpu().then((ok) => {
			if (cancelled) return;
			editor.renderer.setDegraded(!ok);
			setGpuReady(true);
		});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- editor is the process singleton.
	}, []);

	if (!gpuReady) return null;
	return <PreviewRendererInner />;
}

function PreviewRendererInner() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	// Render tracks = preview-overlay tracks + main-track transitions applied
	// (memoized in the manager, so this snapshot is referentially stable).
	const tracks = useEditor(
		(e) => e.timeline.getRenderTracks() ?? e.scenes.getActiveScene().tracks,
	);
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const renderTree = useEditor((e) => e.renderer.getRenderTree());

	const { width, height } = activeProject.settings.canvasSize;
	const background = activeProject.settings.background;
	const fps = activeProject.settings.fps;

	// Scene sync — rebuild the render tree whenever timeline/media/canvas
	// state changes. Reference identity on `tracks`/`mediaAssets` is the
	// engine's own change signal (managers notify with fresh snapshots).
	useEffect(() => {
		const duration = editor.timeline.getTotalDuration();
		const tree = buildScene({
			tracks,
			mediaAssets,
			duration,
			canvasSize: { width, height },
			background,
			isPreview: true,
		});
		editor.renderer.setRenderTree({ renderTree: tree });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `editor` is the process-wide singleton; the deps that matter are the state snapshots.
	}, [tracks, mediaAssets, background, width, height]);

	const renderer = useMemo(
		() => new CanvasRenderer({ width, height, fps }),
		[width, height, fps],
	);

	const mountRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const mount = mountRef.current;
		if (!mount) return;
		const outputCanvas = renderer.getOutputCanvas();
		outputCanvas.style.display = "block";
		outputCanvas.style.width = "100%";
		outputCanvas.style.height = "100%";
		mount.appendChild(outputCanvas);
		return () => {
			if (outputCanvas.parentElement === mount) {
				mount.removeChild(outputCanvas);
			}
		};
	}, [renderer]);

	const lastFrameRef = useRef(-1);
	const lastTreeRef = useRef<RootNode | null>(null);
	const renderingRef = useRef(false);

	const renderFrame = useCallback(() => {
		if (!renderTree || renderingRef.current) return;
		const renderTime = Math.min(
			editor.playback.getCurrentTime(),
			editor.timeline.getLastFrameTime(),
		);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * renderer.fps.denominator) / renderer.fps.numerator,
		);
		const frame = Math.floor(renderTime / ticksPerFrame);
		if (frame === lastFrameRef.current && renderTree === lastTreeRef.current) return;
		renderingRef.current = true;
		lastFrameRef.current = frame;
		lastTreeRef.current = renderTree;
		renderer
			.render({ node: renderTree, time: renderTime })
			.catch((error: unknown) => {
				// A single bad frame must not kill the loop; log and move on.
				console.error("preview render failed:", error);
			})
			.finally(() => {
				renderingRef.current = false;
			});
	}, [editor.playback, editor.timeline, renderTree, renderer]);

	useEffect(() => {
		let rafId: number;
		const tick = () => {
			renderFrame();
			rafId = requestAnimationFrame(tick);
		};
		rafId = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafId);
	}, [renderFrame]);

	const gestureHandlers = usePreviewTransformGesture({
		mountRef,
		canvasWidth: width,
		canvasHeight: height,
	});

	return (
		<div
			ref={mountRef}
			className="cc-preview-stage__render"
			style={{ touchAction: "none" }}
			{...gestureHandlers}
		/>
	);
}

/**
 * CapCut-style DIRECT manipulation on the preview (round 18, founder:
 * "it should just be able to be moved from on top of the preview area" —
 * round 17's selection-gated version read as "completely inaccessible").
 *
 * Touching a clip in the preview grabs it: pointerdown hit-tests the
 * topmost visual element under the finger at the playhead
 * (preview-hit-test.ts — overlay[0] wins over main, the selected element
 * wins over anything stacked on it), selects it, and starts the drag in
 * the same motion. One finger moves (`transform.positionX/Y`, canvas
 * units), a second finger pinches to scale (`transform.scaleX/Y`,
 * sign-preserving); with something selected, a two-finger pinch works
 * ANYWHERE on the preview. Text/caption elements have no cheap bounds, so
 * they keep the selection-based fallback: select one (timeline/panel) and
 * any preview drag moves it.
 *
 * Mid-gesture frames ride the engine's preview overlay
 * (`timeline.previewElements`); release commits ONE undoable
 * TracksSnapshotCommand (`timeline.commitPreview`). Tap semantics: tap on
 * a clip = select it (swallowed); tap on empty preview = PreviewStage's
 * play/pause toggle, untouched.
 */
const DRAG_SLOP_PX = 6;

function usePreviewTransformGesture({
	mountRef,
	canvasWidth,
	canvasHeight,
}: {
	mountRef: RefObject<HTMLDivElement | null>;
	canvasWidth: number;
	canvasHeight: number;
}) {
	const editor = useEditor();
	const [selectedRef, selectedElement] = useSelectedElement();

	// Anchor values are the element's transform at the LAST pointer-topology
	// change (gesture start, finger added, finger lifted); deltas are always
	// measured from the geometry captured at that same moment, so adding or
	// removing a finger never makes the element jump.
	const sessionRef = useRef<{
		pointers: Map<number, { x: number; y: number }>;
		startCentroid: { x: number; y: number };
		startDistance: number | null;
		initialParams: ParamValues;
		anchorPositionX: number;
		anchorPositionY: number;
		anchorScaleX: number;
		anchorScaleY: number;
		dragging: boolean;
		/** True when the session started by touching the element itself —
		 *  a dragless release then reads as a SELECT tap (swallowed), not a
		 *  play/pause tap. Fallback sessions (text/caption, pinch-anywhere)
		 *  leave taps alone. */
		viaHit: boolean;
		target: { trackId: string; elementId: string };
	} | null>(null);
	/** Fingers that landed on empty preview (no session) — kept so a second
	 *  finger can still open the pinch-anywhere session for the selection. */
	const passiveRef = useRef<Map<number, { x: number; y: number }>>(new Map());

	const readNumber = (params: ParamValues, key: string, fallback: number) => {
		const value = params[key];
		return typeof value === "number" && Number.isFinite(value) ? value : fallback;
	};

	const centroidAndDistance = (pointers: Map<number, { x: number; y: number }>) => {
		const points = [...pointers.values()];
		const centroid = {
			x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
			y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
		};
		const distance =
			points.length >= 2
				? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
				: null;
		return { centroid, distance };
	};

	const pxToCanvas = () => {
		const rect = mountRef.current?.getBoundingClientRect();
		// The mount is rendered at the canvas's own aspect ratio (PreviewStage
		// sizes it), so one uniform factor maps CSS px -> canvas units.
		return rect && rect.width > 0 ? canvasWidth / rect.width : 0;
	};

	type Session = NonNullable<typeof sessionRef.current>;

	/** The element's effective transform under the current pointer deltas. */
	const currentTransform = (session: Session) => {
		const scale = pxToCanvas();
		const { centroid, distance } = centroidAndDistance(session.pointers);
		const factor =
			distance !== null && session.startDistance && session.startDistance > 0
				? distance / session.startDistance
				: 1;
		return {
			positionX: session.anchorPositionX + (centroid.x - session.startCentroid.x) * scale,
			positionY: session.anchorPositionY + (centroid.y - session.startCentroid.y) * scale,
			scaleX: session.anchorScaleX * factor,
			scaleY: session.anchorScaleY * factor,
		};
	};

	/** Re-anchor after a finger joins/leaves: bank the current transform and
	 *  restart deltas from the new pointer geometry. */
	const reanchor = (session: Session) => {
		const current = currentTransform(session);
		session.anchorPositionX = current.positionX;
		session.anchorPositionY = current.positionY;
		session.anchorScaleX = current.scaleX;
		session.anchorScaleY = current.scaleY;
		const { centroid, distance } = centroidAndDistance(session.pointers);
		session.startCentroid = centroid;
		session.startDistance = distance;
	};

	const applySessionUpdate = () => {
		const session = sessionRef.current;
		if (!session || session.pointers.size === 0 || pxToCanvas() === 0) return;
		const current = currentTransform(session);
		const params: ParamValues = {
			...session.initialParams,
			"transform.positionX": current.positionX,
			"transform.positionY": current.positionY,
			"transform.scaleX": current.scaleX,
			"transform.scaleY": current.scaleY,
		};
		editor.timeline.previewElements({
			updates: [
				{
					trackId: session.target.trackId,
					elementId: session.target.elementId,
					updates: { params },
				},
			],
		});
	};

	const endSession = (commit: boolean) => {
		const session = sessionRef.current;
		if (!session) return null;
		sessionRef.current = null;
		if (session.dragging && commit) {
			editor.timeline.commitPreview();
		} else if (session.dragging) {
			editor.timeline.discardPreview();
		}
		return session;
	};

	const openSession = ({
		pointers,
		params,
		viaHit,
		target,
	}: {
		pointers: Map<number, { x: number; y: number }>;
		params: ParamValues;
		viaHit: boolean;
		target: { trackId: string; elementId: string };
	}) => {
		const { centroid, distance } = centroidAndDistance(pointers);
		sessionRef.current = {
			pointers,
			startCentroid: centroid,
			startDistance: distance,
			initialParams: params,
			anchorPositionX: readNumber(params, "transform.positionX", 0),
			anchorPositionY: readNumber(params, "transform.positionY", 0),
			anchorScaleX: readNumber(params, "transform.scaleX", 1),
			anchorScaleY: readNumber(params, "transform.scaleY", 1),
			dragging: false,
			viaHit,
			target,
		};
	};

	const selectionIsManipulable =
		selectedRef !== null &&
		selectedElement !== null &&
		isVisualElement(selectedElement);

	return {
		onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
			const point = { x: event.clientX, y: event.clientY };
			const existing = sessionRef.current;
			if (existing) {
				existing.pointers.set(event.pointerId, point);
				reanchor(existing);
				return;
			}

			// Direct grab: whichever clip is under the finger, topmost first.
			const rect = mountRef.current?.getBoundingClientRect();
			if (rect && rect.width > 0 && rect.height > 0) {
				const timeTicks = Math.min(
					editor.playback.getCurrentTime(),
					editor.timeline.getLastFrameTime(),
				) as MediaTime;
				const hit = hitTestPreview({
					editor,
					x: (point.x - rect.left) * (canvasWidth / rect.width),
					y: (point.y - rect.top) * (canvasHeight / rect.height),
					timeTicks,
					canvasWidth,
					canvasHeight,
				});
				if (hit && isVisualElement(hit.element)) {
					if (
						selectedRef?.elementId !== hit.ref.elementId ||
						selectedRef?.trackId !== hit.ref.trackId
					) {
						selectElement({ editor, ref: hit.ref });
					}
					openSession({
						pointers: new Map([[event.pointerId, point]]),
						params: hit.element.params,
						viaHit: true,
						target: hit.ref,
					});
					return;
				}
			}

			// Unhittable selection (text/caption): any preview drag moves it —
			// the round-17 behavior, kept as the fallback for measured-layout
			// elements.
			if (
				selectionIsManipulable &&
				selectedRef &&
				selectedElement &&
				(selectedElement.type === "text" || selectedElement.type === "caption")
			) {
				openSession({
					pointers: new Map([[event.pointerId, point]]),
					params: selectedElement.params,
					viaHit: false,
					target: selectedRef,
				});
				return;
			}

			// Empty-area touch: passive. A second passive finger with a
			// selection becomes the pinch-anywhere session for it.
			passiveRef.current.set(event.pointerId, point);
			if (passiveRef.current.size >= 2 && selectionIsManipulable && selectedRef && selectedElement) {
				const pointers = new Map(passiveRef.current);
				passiveRef.current.clear();
				openSession({
					pointers,
					params: selectedElement.params,
					viaHit: false,
					target: selectedRef,
				});
			}
		},
		onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
			const passive = passiveRef.current;
			if (passive.has(event.pointerId)) {
				passive.set(event.pointerId, { x: event.clientX, y: event.clientY });
				return;
			}
			const session = sessionRef.current;
			if (!session || !session.pointers.has(event.pointerId)) return;
			session.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (!session.dragging) {
				const { centroid } = centroidAndDistance(session.pointers);
				const moved = Math.hypot(
					centroid.x - session.startCentroid.x,
					centroid.y - session.startCentroid.y,
				);
				if (moved < DRAG_SLOP_PX && session.pointers.size < 2) return;
				session.dragging = true;
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch {
					// Defensive: an invalid/stale pointerId (synthetic events,
					// odd webview states) must not kill the drag — capture is
					// an optimization, not a correctness requirement.
				}
			}
			applySessionUpdate();
		},
		onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
			if (passiveRef.current.delete(event.pointerId)) return;
			const session = sessionRef.current;
			if (!session || !session.pointers.has(event.pointerId)) return;
			session.pointers.delete(event.pointerId);
			if (session.pointers.size > 0) {
				reanchor(session);
				return;
			}
			const ended = endSession(true);
			// Swallow the up-event for real drags AND for select-taps on a
			// clip — neither should double as the stage's play/pause tap.
			if (ended && (ended.dragging || ended.viaHit)) {
				event.stopPropagation();
			}
		},
		onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => {
			passiveRef.current.delete(event.pointerId);
			endSession(false);
		},
	};
}
