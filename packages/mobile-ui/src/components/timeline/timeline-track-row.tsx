import { useMemo } from "react";
import type { TimelineTrackVM } from "../../timeline/types";
import { visibleClipIndices } from "../../timeline/virtualization";
import type { SnapTarget } from "../../timeline/snapping";
import { TimelineClip, MIN_CLIP_DURATION_SEC, type TrimEdge } from "./timeline-clip";
import { TransitionSquare } from "./transition-square";

const CLIP_OVERSCAN_SEC = 5;

export interface TrimPreview {
	clipId: string;
	edge: TrimEdge;
	boundarySec: number;
}

export interface MovePreview {
	clipId: string;
	/** Already snapped/clamped by the view — the row just renders it. */
	startSec: number;
}

export function TimelineTrackRow({
	track,
	pixelsPerSecond,
	viewStartSec,
	viewEndSec,
	durationSec,
	selectedClipId,
	onSelectClip,
	trimPreview,
	onTrimPreview,
	onTrimCommit,
	movePreview,
	onMovePreview,
	onMoveEnd,
	snapTargets,
	snapThresholdSec,
	onKeyframeTap,
	transitionAfterClipIds,
	onTransitionTap,
}: {
	track: TimelineTrackVM;
	pixelsPerSecond: number;
	viewStartSec: number;
	viewEndSec: number;
	durationSec: number;
	selectedClipId: string | null;
	onSelectClip: (params: { clipId: string }) => void;
	trimPreview: TrimPreview | null;
	onTrimPreview: (params: { clipId: string; edge: TrimEdge; boundarySec: number }) => void;
	onTrimCommit: (params: {
		clipId: string;
		trackId: string;
		edge: TrimEdge;
		boundarySec: number;
	}) => void;
	movePreview: MovePreview | null;
	onMovePreview?: (params: {
		clipId: string;
		trackId: string;
		candidateStartSec: number;
	}) => void;
	onMoveEnd?: (params: { clipId: string; trackId: string }) => void;
	snapTargets: readonly SnapTarget[];
	snapThresholdSec: number;
	onKeyframeTap?: (params: { clipId: string; keyframeId: string }) => void;
	/** Which afterClipId gaps already have an applied transition — main track only. */
	transitionAfterClipIds?: ReadonlySet<string>;
	onTransitionTap?: (params: { afterClipId: string }) => void;
}) {
	const { startIndex, endIndex } = useMemo(
		() =>
			visibleClipIndices({
				clips: track.clips,
				viewStartSec,
				viewEndSec,
				overscanSec: CLIP_OVERSCAN_SEC,
			}),
		[track.clips, viewStartSec, viewEndSec],
	);

	const visibleClips = endIndex >= startIndex ? track.clips.slice(startIndex, endIndex + 1) : [];

	return (
		<div className={`cc-timeline__track-row cc-timeline__track-row--${track.kind}`}>
			{visibleClips.map((clip, offset) => {
				const index = startIndex + offset;
				const prevClip = track.clips[index - 1];
				const nextClip = track.clips[index + 1];
				// How far each edge may EXTEND back out, from the source-trim
				// state (the "un-trim after split" fix): trimmed-off source
				// material, converted to timeline seconds through the retime
				// rate. Elements with no finite source (text/image/sticker)
				// extend without limit.
				const rate = clip.retimeRate ?? 1;
				const hasFiniteSource = clip.sourceDurationSec != null;
				const startExtensionSec = hasFiniteSource
					? (clip.trimStartSec ?? 0) / rate
					: Number.POSITIVE_INFINITY;
				const endExtensionSec = hasFiniteSource
					? (clip.trimEndSec ?? 0) / rate
					: Number.POSITIVE_INFINITY;
				const sourceMinStartSec = clip.startSec - startExtensionSec;
				const sourceMaxEndSec =
					clip.startSec + clip.durationSec + endExtensionSec;
				// Main track is MAGNETIC (CapCut): trims may cross neighbors —
				// the commit ripples every later clip to stay butted — so only
				// the source extent bounds the drag. Free-position tracks
				// (audio/overlay/text) still stop at their neighbors, and are
				// no longer capped at the current project duration (extending
				// the LAST clip grows the project; the old `durationSec` cap
				// made the last clip's end handle immovable).
				const isMainTrack = track.kind === "main";
				const minStartBoundSec = isMainTrack
					? sourceMinStartSec
					: Math.max(
							prevClip ? prevClip.startSec + prevClip.durationSec : 0,
							sourceMinStartSec,
						);
				const maxEndBoundSec = isMainTrack
					? sourceMaxEndSec
					: Math.min(
							nextClip ? nextClip.startSec : Number.POSITIVE_INFINITY,
							sourceMaxEndSec,
						);

				const hasPreview = trimPreview?.clipId === clip.id;
				let effectiveStartSec = clip.startSec;
				let effectiveDurationSec = clip.durationSec;
				if (hasPreview && trimPreview) {
					if (trimPreview.edge === "start") {
						const clampedStart = Math.min(
							trimPreview.boundarySec,
							clip.startSec + clip.durationSec - MIN_CLIP_DURATION_SEC,
						);
						effectiveDurationSec = clip.startSec + clip.durationSec - clampedStart;
						effectiveStartSec = clampedStart;
					} else {
						effectiveDurationSec = Math.max(
							MIN_CLIP_DURATION_SEC,
							trimPreview.boundarySec - clip.startSec,
						);
					}
				}
				if (movePreview?.clipId === clip.id) {
					effectiveStartSec = movePreview.startSec;
				}

				return (
					<TimelineClip
						key={clip.id}
						clip={clip}
						effectiveStartSec={effectiveStartSec}
						effectiveDurationSec={effectiveDurationSec}
						pixelsPerSecond={pixelsPerSecond}
						viewStartSec={viewStartSec}
						viewEndSec={viewEndSec}
						isSelected={clip.id === selectedClipId}
						onSelect={onSelectClip}
						onTrimPreview={onTrimPreview}
						onTrimCommit={onTrimCommit}
						onMovePreview={onMovePreview}
						onMoveEnd={onMoveEnd}
						minStartBoundSec={minStartBoundSec}
						maxEndBoundSec={maxEndBoundSec}
						snapTargets={snapTargets}
						snapThresholdSec={snapThresholdSec}
						onKeyframeTap={onKeyframeTap}
					/>
				);
			})}
			{track.kind === "main" &&
				onTransitionTap &&
				visibleClips.slice(0, -1).map((clip, offset) => {
					const index = startIndex + offset;
					const next = track.clips[index + 1];
					if (!next) return null;
					const atSec = clip.startSec + clip.durationSec;
					return (
						<TransitionSquare
							key={`transition-${clip.id}`}
							afterClipId={clip.id}
							atSec={atSec}
							pixelsPerSecond={pixelsPerSecond}
							applied={transitionAfterClipIds?.has(clip.id) ?? false}
							onTap={onTransitionTap}
						/>
					);
				})}
		</div>
	);
}
