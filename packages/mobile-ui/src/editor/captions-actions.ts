/**
 * Fixer pass — wires M8's Captions panel to the REAL M10 captions engine
 * that merged into main after track/ui branched (commit order:
 * track/ui M8 was last, track/captions/M10 merged before it, but the panel
 * was never updated to use what M10 shipped). This was previously a
 * hardcoded `disabled` no-op with the doc-comment claim "no `TrackType` for
 * captions in the engine yet" — both false on this merge:
 * `packages/editor-core/src/timeline/types.ts`'s `TrackType` union includes
 * `"caption"`, and `packages/editor-core/src/captions/generate.ts` +
 * `commands/captions/*` are real, tested modules.
 *
 * "Generate" here calls the REAL pipeline end to end:
 *   1. `getNativeBridge()` (never `./web-fallback` directly — this is an
 *      editor UI file, so it's bound by the same bridge-import gate
 *      `scripts/invariants.sh` enforces for every other panel/action in
 *      this package) selects the web-fallback bridge in a plain browser.
 *   2. The web-fallback bridge's `transcribe()` recognizes exactly ONE
 *      sentinel `MediaHandle` (`DEV_FIXTURE_MEDIA_HANDLE`,
 *      `@kneecap/native-bridge`'s own dev-harness fixture, built
 *      specifically for "verify the full generate -> edit -> preview flow
 *      in the dev harness using the web fallback + a pre-transcribed
 *      fixture" per that fixture's own header) and yields real
 *      `TranscriptSegment[]` data — any other handle still throws the
 *      honest `UNSUPPORTED` error, this is not a general in-webview STT
 *      backdoor.
 *   3. `buildCaptionElementsFromTranscript` (editor-core's real M10
 *      module) converts those segments into `CreateCaptionElement[]`.
 *   4. `insertGeneratedCaptions` (editor-core's real M10 command helper)
 *      lands them on a brand-new caption track as one undoable action.
 *
 * There is still no real on-device whisper.cpp call reachable from THIS
 * panel — only the disclosed dev-fixture path above. A real file's audio
 * still cannot be transcribed from the web-fallback bridge (native shells
 * only, plan M10) or from this panel at all (no "pick a clip to
 * transcribe" affordance was added — out of scope for this fixer pass, see
 * the caller's own flags). That gap is real and left open, not papered
 * over: the panel's copy says exactly this.
 */
import type { EditorCore, MediaAsset } from "@kneecap/editor-core";
import {
	mediaTimeToSeconds,
	resolveNativeMediaRawPath,
	ZERO_MEDIA_TIME,
} from "@kneecap/editor-core";
import type { VideoElement } from "@kneecap/editor-core/timeline";
import {
	buildCaptionElementsFromTranscript,
	type TranscriptSegmentInput,
} from "@kneecap/editor-core/captions";
import { insertGeneratedCaptions, ApplyCaptionStyleCommand } from "@kneecap/editor-core/commands";
import { windowSegmentsToClip } from "./caption-window";
import {
	getNativeBridge,
	DEV_FIXTURE_MEDIA_HANDLE,
	type MediaHandle,
	type TranscriptSegment,
} from "@kneecap/native-bridge";

export interface GenerateCaptionsResult {
	trackId: string;
	elementIds: string[];
}

/**
 * Round 20 — REAL captions: transcribe an actual clip's audio on-device
 * (iOS: Apple Speech via NativeBridgePlugin+Transcribe.swift; Android:
 * whisper.cpp) and land the words as caption elements aligned under the
 * clip. Target = the selected video clip, else the first main-track video
 * clip. The transcript is source-relative; words are windowed to the
 * clip's [trimStart, trimStart+duration) and shifted clip-relative, so
 * captions land where the AUDIBLE audio is, trims respected.
 *
 * Throws with actionable messages ("no video clip", "no native media
 * file") — the caller (the panel, or generateCaptions below) decides how
 * to degrade.
 */
export async function generateCaptionsForClip({
	editor,
	stylePresetId,
}: {
	editor: EditorCore;
	stylePresetId: string;
}): Promise<GenerateCaptionsResult | null> {
	const tracks = editor.scenes.getActiveScene().tracks;
	const selectedRef = editor.selection.getSelectedElements()[0];
	const selectedElement = selectedRef
		? [tracks.main, ...tracks.overlay]
				.find((track) => track.id === selectedRef.trackId)
				?.elements.find((el) => el.id === selectedRef.elementId)
		: undefined;
	const target =
		selectedElement?.type === "video"
			? selectedElement
			: tracks.main.elements.find(
					(el): el is VideoElement => el.type === "video" && !el.hidden,
				);
	if (!target || target.type !== "video") {
		throw new Error("Add a video clip first — captions transcribe the clip's audio.");
	}

	const asset: MediaAsset | undefined = editor.media
		.getAssets()
		.find((a) => a.id === target.mediaId);
	// Original preferred (full-quality audio), proxy accepted — the same
	// custody preference the native exporter's asset resolver uses.
	const rawPath = asset?.sourceNativeRelativePath
		? resolveNativeMediaRawPath(asset.sourceNativeRelativePath)
		: asset?.nativeRelativePath
			? resolveNativeMediaRawPath(asset.nativeRelativePath)
			: null;
	if (!asset || !rawPath) {
		throw new Error(
			"This clip has no on-device media file to transcribe (web dev harness clips can't be transcribed — native builds only).",
		);
	}

	const handle: MediaHandle = {
		id: asset.id,
		uri: rawPath,
		kind: "video",
		fileName: asset.name,
		sizeBytes: 0,
		durationMicros: Math.round((asset.duration ?? 0) * 1_000_000),
		width: asset.width ?? 0,
		height: asset.height ?? 0,
		rotationDegrees: 0,
		hasAudio: true,
		codec: "",
		frameRate: null,
	};

	const bridge = await getNativeBridge();
	const segments: TranscriptSegment[] = [];
	for await (const segment of bridge.transcribe({
		handle,
		opts: { modelSize: "tiny" },
	})) {
		segments.push(segment);
	}

	const windowed = windowSegmentsToClip({
		segments,
		trimStartMicros: Math.round(mediaTimeToSeconds({ time: target.trimStart }) * 1_000_000),
		durationMicros: Math.round(mediaTimeToSeconds({ time: target.duration }) * 1_000_000),
	});

	const elements = buildCaptionElementsFromTranscript({
		segments: windowed,
		timelineStartTime: target.startTime,
		stylePresetId,
	});
	const inserted = insertGeneratedCaptions({ editor, elements });
	if (!inserted) {
		// Round 21.1: an empty result must SAY so — the device bug shipped a
		// single empty token and the panel silently reported "done" with
		// nothing inserted.
		throw new Error(
			"No speech was detected in this clip's audio. If the clip definitely has speech, check the language setting.",
		);
	}
	return inserted;
}

/**
 * The panel's one entry point: try the real clip first; when the failure
 * is the KNOWN "nothing transcribable here" class (no clip / no native
 * file — i.e. the web dev harness), fall back to the bundled sample so
 * the dev flow keeps demonstrating the pipeline. Real native errors
 * (permission denied, unsupported locale, IO) propagate untouched.
 */
export async function generateCaptions({
	editor,
	stylePresetId,
}: {
	editor: EditorCore;
	stylePresetId: string;
}): Promise<GenerateCaptionsResult | null> {
	try {
		return await generateCaptionsForClip({ editor, stylePresetId });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const noTranscribableClip =
			message.includes("Add a video clip first") ||
			message.includes("no on-device media file");
		if (!noTranscribableClip) throw error;
		return generateCaptionsFromSampleClip({ editor, stylePresetId });
	}
}

/** Runs the real generate pipeline against the dev-fixture sample clip and
 *  lands real `CaptionElement`s on a real caption track. Returns `null` if
 *  the fixture yields zero usable segments (shouldn't happen with the
 *  bundled sample, but `insertGeneratedCaptions` itself returns `null` for
 *  an empty element list rather than inserting an empty track). */
export async function generateCaptionsFromSampleClip({
	editor,
	stylePresetId,
}: {
	editor: EditorCore;
	stylePresetId: string;
}): Promise<GenerateCaptionsResult | null> {
	const bridge = await getNativeBridge();
	const segments: TranscriptSegmentInput[] = [];
	for await (const segment of bridge.transcribe({
		handle: DEV_FIXTURE_MEDIA_HANDLE,
		opts: { modelSize: "tiny" },
	})) {
		segments.push(segment);
	}

	const elements = buildCaptionElementsFromTranscript({
		segments,
		timelineStartTime: ZERO_MEDIA_TIME,
		stylePresetId,
	});

	return insertGeneratedCaptions({ editor, elements });
}

/** "Apply to all" caption style — the real `ApplyCaptionStyleCommand`
 *  (plan M10 item 6), not local-only chip-selection state. Undoable like
 *  every other engine mutation this package wires. */
export function applyCaptionStyleToAll({
	editor,
	presetId,
}: {
	editor: EditorCore;
	presetId: string;
}): void {
	editor.command.execute({
		command: new ApplyCaptionStyleCommand({ presetId, scope: { kind: "all" } }),
	});
}
