/**
 * Main-track transition placement — the TypeScript mirror of the native
 * exporter's `MainTrackPlacement.swift`, in the engine's own tick domain
 * (`MediaTime` IS integer ticks; buildEdl asserts every time-shaped value is
 * an integer). Preview and export MUST agree on where clips land, so this
 * file ports that Swift file's math verbatim, including its documented
 * design decision:
 *
 *   a transition of duration `d` after clip A (immediately followed by B)
 *   pulls B's FULL, untruncated media `d` ticks earlier so the two overlap
 *   for exactly `d`. Neither clip's own duration changes — only B's start
 *   moves. Downstream clips ripple left by the cumulative sum of every `d`
 *   before them, and the timeline COMPRESSES by that sum versus naive
 *   concatenation. Overlay/audio clips authored against nominal time are
 *   remapped with the same step function the Swift side uses.
 *
 * The cross-fade itself renders as an opacity ramp on the INCOMING clip
 * (painter's order puts it above the outgoing one): out*(1-t) + in*t — the
 * same result as the export compositor's CIDissolveTransition.
 */
import type { MediaTime } from "@/wasm";

/**
 * Local, dependency-free MediaTime constructor. This module mirrors
 * MainTrackPlacement.swift's "PURE integer arithmetic, zero dependencies"
 * design: importing the @/wasm barrel's `mediaTime()` would load the real
 * wasm binary into every consumer of this math — including unit tests,
 * where that binary cannot initialize. Every input here is already-branded
 * MediaTime and every arithmetic result is an integer by construction, so
 * the brand cast is sound.
 */
function ticks(value: number): MediaTime {
	return value as MediaTime;
}
import type { ScalarChannel } from "@/animation/types";
import type {
	OverlayTrack,
	SceneTracks,
	TimelineElement,
	TSceneTransition,
	VideoTrack,
} from "./types";

export interface ClipPlacement {
	elementId: string;
	/** Position in the OUTPUT (compressed) timeline, ticks. Only ever pulled
	 *  earlier than the nominal start, never later. */
	insertStartTicks: MediaTime;
	/** The clip's own, unchanged nominal on-timeline duration. */
	insertDurationTicks: MediaTime;
	/** Overlap with the PREVIOUS clip at this clip's start (incoming side). */
	leadingOverlapTicks: MediaTime;
	/** Overlap with the NEXT clip at this clip's end (outgoing side). */
	trailingOverlapTicks: MediaTime;
}

export interface TransitionWindow {
	kind: string;
	outgoingElementId: string;
	incomingElementId: string;
	startTicks: MediaTime;
	durationTicks: MediaTime;
}

/**
 * Same clamp as the Swift side: a transition never consumes more than half
 * of the SHORTER neighbor, minus one tick — both neighbors always keep a
 * non-empty solo range.
 */
export function clampedTransitionDuration({
	requested,
	prevDuration,
	nextDuration,
}: {
	requested: MediaTime;
	prevDuration: MediaTime;
	nextDuration: MediaTime;
}): MediaTime {
	if (requested <= 0) return ticks(0);
	const shorter = Math.min(prevDuration, nextDuration);
	const maxAllowed = Math.max(0, Math.floor(shorter / 2) - 1);
	return ticks(Math.min(requested, maxAllowed));
}

/**
 * Port of `MainTrackPlacement.computePlacements`. `elements` must be the
 * main track's VISIBLE elements; ordering of the input is not assumed.
 * Unlike the Swift side (which throws on a malformed document produced
 * elsewhere), unknown/non-adjacent transition targets are DROPPED here —
 * this code runs on every preview frame build against a live document the
 * user is mid-edit in (deleting a clip must not crash the preview; the
 * stale transition just stops applying, matching what buildEdl emits).
 */
export function computeMainTrackPlacements({
	elements,
	transitions,
}: {
	elements: readonly Pick<TimelineElement, "id" | "startTime" | "duration">[];
	transitions: readonly TSceneTransition[];
}): { placements: ClipPlacement[]; windows: TransitionWindow[] } {
	const sorted = [...elements].sort((a, b) =>
		a.startTime !== b.startTime
			? a.startTime - b.startTime
			: a.id.localeCompare(b.id),
	);
	if (sorted.length === 0) return { placements: [], windows: [] };

	const indexById = new Map<string, number>();
	sorted.forEach((element, index) => indexById.set(element.id, index));

	const transitionAfterIndex = new Map<number, TSceneTransition>();
	for (const transition of transitions) {
		const index = indexById.get(transition.afterElementId);
		if (index === undefined) continue; // clip deleted — transition dormant
		if (index + 1 >= sorted.length) continue; // no following clip
		transitionAfterIndex.set(index, transition);
	}

	const placements: ClipPlacement[] = [];
	const windows: TransitionWindow[] = [];

	let cursorStart = sorted[0].startTime;
	for (let i = 0; i < sorted.length; i++) {
		const element = sorted[i];
		let insertStart = i === 0 ? element.startTime : cursorStart;
		let leading: MediaTime = ticks(0);
		const prevTransition = i > 0 ? transitionAfterIndex.get(i - 1) : undefined;
		if (prevTransition) {
			const d = clampedTransitionDuration({
				requested: prevTransition.duration,
				prevDuration: sorted[i - 1].duration,
				nextDuration: element.duration,
			});
			if (d > 0) {
				insertStart = ticks(placements[i - 1].insertStartTicks + placements[i - 1].insertDurationTicks - d);
				leading = d;
				placements[i - 1].trailingOverlapTicks = d;
				windows.push({
					kind: prevTransition.kind,
					outgoingElementId: sorted[i - 1].id,
					incomingElementId: element.id,
					startTicks: insertStart,
					durationTicks: d,
				});
			}
		}
		placements.push({
			elementId: element.id,
			insertStartTicks: insertStart,
			insertDurationTicks: element.duration,
			leadingOverlapTicks: leading,
			trailingOverlapTicks: ticks(0),
		});
		cursorStart = ticks(insertStart + element.duration);
	}

	return { placements, windows };
}

/**
 * Port of `MainTrackPlacement.buildNominalToOutputRemap` + `remapNominalTick`
 * — the monotonic step function mapping a nominal (as-authored) tick to its
 * output (post-compression) tick, used to keep overlay/audio clips in sync
 * with the compressed main track. Same documented approximation as the
 * Swift side: only an element's START is remapped, its duration is kept.
 */
export function buildNominalToOutputRemap({
	sortedElements,
	windows,
}: {
	sortedElements: readonly Pick<TimelineElement, "id" | "startTime">[];
	windows: readonly TransitionWindow[];
}): Array<{ nominalStart: MediaTime; shift: MediaTime }> {
	const startById = new Map<string, MediaTime>();
	for (const element of sortedElements) startById.set(element.id, element.startTime);

	const breakpoints: Array<{ nominalStart: MediaTime; shift: MediaTime }> = [
		{ nominalStart: ticks(0), shift: ticks(0) },
	];
	let cumulative: MediaTime = ticks(0);
	for (const window of [...windows].sort((a, b) => a.startTicks - b.startTicks)) {
		const nominalStart = startById.get(window.incomingElementId);
		if (nominalStart === undefined) continue;
		cumulative = ticks(cumulative + window.durationTicks);
		breakpoints.push({ nominalStart, shift: cumulative });
	}
	return breakpoints;
}

export function remapNominalTick({
	nominalTick,
	breakpoints,
}: {
	nominalTick: MediaTime;
	breakpoints: readonly { nominalStart: MediaTime; shift: MediaTime }[];
}): MediaTime {
	let shift: MediaTime = ticks(0);
	for (const bp of breakpoints) {
		if (bp.nominalStart <= nominalTick) shift = bp.shift;
	}
	return ticks(Math.max(0, nominalTick - shift));
}

const FADE_CHANNEL_KEY = "opacity";

/**
 * Derive render-ready tracks from the authored ones: main-track clips move
 * to their compressed placements (incoming clips gaining a fade-in opacity
 * channel over the overlap window), and every overlay/audio element's start
 * is remapped through the step function. Returns the input unchanged (same
 * reference) when there are no applicable transitions, so preview code can
 * cheaply detect "nothing derived".
 *
 * An element that already carries a user-authored opacity channel keeps it
 * untouched (documented v1 limitation: the transition fade does not compose
 * with hand-keyframed opacity — rare, and clobbering user keyframes would
 * be worse).
 */
export function applyTransitionsToSceneTracks({
	tracks,
	transitions,
}: {
	tracks: SceneTracks;
	transitions: readonly TSceneTransition[] | undefined;
}): SceneTracks {
	if (!transitions || transitions.length === 0) return tracks;

	const visible = tracks.main.elements.filter(
		(element) => !("hidden" in element && element.hidden),
	);
	const { placements, windows } = computeMainTrackPlacements({
		elements: visible,
		transitions,
	});
	if (windows.length === 0) return tracks;

	const placementById = new Map(placements.map((p) => [p.elementId, p]));
	const fadeInById = new Map<string, MediaTime>();
	for (const window of windows) {
		fadeInById.set(window.incomingElementId, window.durationTicks);
	}

	const mainElements = tracks.main.elements.map((element) => {
		const placement = placementById.get(element.id);
		if (!placement) return element;
		const fadeIn = fadeInById.get(element.id);
		let animations = element.animations;
		if (fadeIn && fadeIn > 0 && !element.animations?.[FADE_CHANNEL_KEY]) {
			const channel: ScalarChannel = {
				keys: [
					{
						id: `${element.id}:transition-fade-in:0`,
						time: ticks(0),
						value: 0,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
					{
						id: `${element.id}:transition-fade-in:1`,
						time: fadeIn,
						value: 1,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
				extrapolation: { before: "hold", after: "hold" },
			};
			animations = { ...element.animations, [FADE_CHANNEL_KEY]: channel };
		}
		if (placement.insertStartTicks === element.startTime && animations === element.animations) {
			return element;
		}
		return {
			...element,
			startTime: placement.insertStartTicks,
			animations,
		};
	}) as VideoTrack["elements"];

	const sortedVisible = [...visible].sort((a, b) =>
		a.startTime !== b.startTime
			? a.startTime - b.startTime
			: a.id.localeCompare(b.id),
	);
	const breakpoints = buildNominalToOutputRemap({
		sortedElements: sortedVisible,
		windows,
	});

	const remapTrackElements = <TTrack extends OverlayTrack | SceneTracks["audio"][number]>(
		track: TTrack,
	): TTrack => {
		let changed = false;
		const elements = track.elements.map((element) => {
			const remapped = remapNominalTick({
				nominalTick: element.startTime,
				breakpoints,
			});
			if (remapped === element.startTime) return element;
			changed = true;
			return { ...element, startTime: remapped };
		});
		return changed ? ({ ...track, elements } as TTrack) : track;
	};

	return {
		main: { ...tracks.main, elements: mainElements },
		overlay: tracks.overlay.map(remapTrackElements),
		audio: tracks.audio.map(remapTrackElements),
	};
}
