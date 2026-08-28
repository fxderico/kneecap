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
import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	PointerEvent as ReactPointerEvent,
	ReactNode,
	RefObject,
} from "react";
import { TICKS_PER_SECOND } from "@kneecap/editor-core";
import { useEditor } from "@kneecap/editor-core/react";
import { isVisualElement } from "@kneecap/editor-core/timeline";
import type { ParamValues } from "@kneecap/editor-core/params";
import { useSelectedElement } from "../../editor/use-live-editor";
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
let gpuFailureReason: string | null = null;

/** Human-readable reason the GPU compositor failed to come up (no usable
 *  WebGPU *and* no WebGL2 fallback), or null while it hasn't been tried or
 *  succeeded. Surfaced in the preview area so a device that can't run the
 *  wgpu compositor shows *why* instead of the whole editor crashing on the
 *  first compositor call (2026-08 device report: "GPU context not
 *  initialized" thrown inside a render effect took the app to a black
 *  screen). */
export function getGpuFailureReason(): string | null {
	return gpuFailureReason;
}

export function ensurePreviewGpu(): Promise<boolean> {
	return ensureGpu();
}
function ensureGpu(): Promise<boolean> {
	if (!gpuInitPromise) {
		let started: Promise<unknown>;
		try {
			started = initializeGpu();
		} catch (error: unknown) {
			// Defensive: a synchronous throw (bad wasm load) must not escape.
			started = Promise.reject(error);
		}
		gpuInitPromise = started
			.then(() => {
				gpuFailureReason = null;
				return true;
			})
			.catch((error: unknown) => {
				const panic =
					typeof window !== "undefined"
						? (window as unknown as { __wasmPanic?: string }).__wasmPanic
						: undefined;
				const message =
					panic ||
					(error instanceof Error ? error.message : String(error)) ||
					"unknown error";
				gpuFailureReason = message;
				console.warn(`GPU renderer unavailable: ${message}`);
				return false;
			});
	}
	return gpuInitPromise;
}

/**
 * The preview surface: the GPU-composited frame when it can run, a calm
 * "unavailable" panel when it can't — and a local error boundary so a
 * compositor throw (e.g. "GPU context not initialized" from a code path
 * that slips past the gpuOk gate) degrades the *preview* instead of
 * unmounting the whole editor. Everything outside the stage keeps working.
 */
export function PreviewSurface() {
	return (
		<PreviewBoundary>
			<PreviewRenderer />
		</PreviewBoundary>
	);
}

class PreviewBoundary extends Component<
	{ children: ReactNode },
	{ failed: boolean; message: string | null }
> {
	state = { failed: false, message: null as string | null };

	static getDerivedStateFromError(error: unknown) {
		return {
			failed: true,
			message: error instanceof Error ? error.message : String(error),
		};
	}

	componentDidCatch(error: unknown) {
		console.warn("preview surface failed, degrading:", error);
	}

	render() {
		if (this.state.failed) {
			return (
				<PreviewUnavailable
					reason={this.state.message ?? getGpuFailureReason()}
				/>
			);
		}
		return this.props.children;
	}
}

export function PreviewRenderer() {
	const editor = useEditor();
	// null = still initializing, true = compositor ready, false = no GPU path.
	const [gpuOk, setGpuOk] = useState<boolean | null>(null);

	useEffect(() => {
		let cancelled = false;
		void ensureGpu().then((ok) => {
			if (cancelled) return;
			editor.renderer.setDegraded(!ok);
			setGpuOk(ok);
		});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- editor is the process singleton.
	}, []);

	if (gpuOk === null) return null;
	// No WebGPU and no WebGL2 the compositor can use: mounting
	// PreviewRendererInner here would call initCompositor() -> "GPU context
	// not initialized" and unmount the whole editor. Show the reason and
	// keep everything else (timeline, trim, text, native export) working.
	if (!gpuOk) return <PreviewUnavailable reason={getGpuFailureReason()} />;
	return <PreviewRendererInner />;
}

function PreviewUnavailable({ reason }: { reason: string | null }) {
	return (
		<div className="cc-preview-unavailable" role="status">
			<svg
				className="cc-preview-unavailable__glyph"
				viewBox="0 0 24 24"
				aria-hidden="true"
			>
				<rect x="2.5" y="4.5" width="19" height="13" rx="2.5" />
				<path d="M8.5 20.5h7M12 17.5v3" />
				<path d="M4 4l16 14" />
			</svg>
			<p className="cc-preview-unavailable__title">Preview not available here</p>
			<p className="cc-preview-unavailable__body">
				This device&rsquo;s WebView can&rsquo;t give the preview a GPU to draw
				on. Editing, playback scrubbing and export all still work.
			</p>
			{reason ? (
				<p className="cc-preview-unavailable__reason">{reason}</p>
			) : null}
		</div>
	);
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
 * SELECTION-GATED manipulation on the preview (round 23, founder: "maybe
 * this is bc video is hyper sensitive, how about these things are only
 * adjustable if they are selected in the timeline") — this supersedes
 * round 18's direct-grab hit-testing, which made the full-frame video
 * swallow every touch and left text/captions practically unreachable.
 *
 * The rule is one line: preview drags and pinches apply to the element
 * currently selected in the TIMELINE, and only then. One finger moves
 * (`transform.positionX/Y`, canvas units), two fingers pinch to scale
 * (`transform.scaleX/Y`) anywhere on the preview. Nothing selected →
 * touches do nothing at all (stage tap-to-play was REMOVED 2026-08-22:
 * the toggle also fired on the pointer-up ending a gesture — releasing a
 * caption resize started playback; play/pause is the PlaybackBar button
 * only).
 *
 * CAPTIONS MOVE AS ONE (round 23, founder: "if i can move one caption it
 * should move all of it around to same position and sizing — sync all
 * caption sizing and positioning"): when the selected element is a
 * caption, the session fans the same transform out to EVERY caption
 * element, and the commit lands them all in one undo step.
 *
 * Mid-gesture frames ride the engine's preview overlay
 * (`timeline.previewElements`); release commits ONE undoable
 * TracksSnapshotCommand (`timeline.commitPreview`). Tap semantics: only
 * real drags swallow the up-event; plain taps bubble but nothing above
 * listens anymore (see the stage-tap removal note in the header).
 */
const DRAG_SLOP_PX = 6;

function usePreviewTransformGesture({
	mountRef,
	canvasWidth,
}: {
	mountRef: RefObject<HTMLDivElement | null>;
	canvasWidth: number;
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
		target: { trackId: string; elementId: string };
		/** Non-null when the target is a caption: every caption element in
		 *  the scene (target included), each with its own base params — the
		 *  shared transform fans out to all of them per frame. */
		fanout: Array<{ trackId: string; elementId: string; params: ParamValues }> | null;
	} | null>(null);

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
		const transformPatch: ParamValues = {
			"transform.positionX": current.positionX,
			"transform.positionY": current.positionY,
			"transform.scaleX": current.scaleX,
			"transform.scaleY": current.scaleY,
		};
		const targets = session.fanout ?? [
			{ ...session.target, params: session.initialParams },
		];
		editor.timeline.previewElements({
			updates: targets.map((t) => ({
				trackId: t.trackId,
				elementId: t.elementId,
				updates: { params: { ...t.params, ...transformPatch } },
			})),
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

	/** All caption elements in the active scene, each with its live base
	 *  params — the "captions move as one" fan-out list. */
	const collectCaptionFanout = () => {
		const tracks = editor.scenes.getActiveScene().tracks;
		const out: Array<{ trackId: string; elementId: string; params: ParamValues }> = [];
		for (const track of tracks.overlay) {
			if (track.type !== "caption") continue;
			for (const element of track.elements) {
				if (element.type === "caption") {
					out.push({ trackId: track.id, elementId: element.id, params: element.params });
				}
			}
		}
		return out;
	};

	const openSession = ({
		pointers,
		params,
		target,
		isCaption,
	}: {
		pointers: Map<number, { x: number; y: number }>;
		params: ParamValues;
		target: { trackId: string; elementId: string };
		isCaption: boolean;
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
			target,
			fanout: isCaption ? collectCaptionFanout() : null,
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

			// Selection-gated: a touch only manipulates the element selected
			// in the timeline. No selection → the touch is fully inert (the
			// stage has no tap handler anymore — see the header note).
			if (selectionIsManipulable && selectedRef && selectedElement) {
				openSession({
					pointers: new Map([[event.pointerId, point]]),
					params: selectedElement.params,
					target: selectedRef,
					isCaption: selectedElement.type === "caption",
				});
			}
		},
		onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
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
			const session = sessionRef.current;
			if (!session || !session.pointers.has(event.pointerId)) return;
			session.pointers.delete(event.pointerId);
			if (session.pointers.size > 0) {
				reanchor(session);
				return;
			}
			const ended = endSession(true);
			// Only a real drag swallows the up-event; a plain tap (session
			// opened but never moved) bubbles — harmlessly, now that the
			// stage has no tap-to-play handler.
			if (ended?.dragging) {
				event.stopPropagation();
			}
		},
		onPointerCancel: () => {
			endSession(false);
		},
	};
}
