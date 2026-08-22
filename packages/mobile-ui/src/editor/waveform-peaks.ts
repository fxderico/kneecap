/**
 * Async waveform peaks for the mobile timeline (round 27, founder: "show
 * audio waves on audio imports that reflect the amount of sound").
 *
 * Thin subscription shim over editor-core's existing `waveformCache`
 * (services/waveform-cache — the same decode+bucket pipeline the desktop
 * timeline consumes): the VM mapping (`use-timeline-project-vm`) is a
 * synchronous pure function, so decoding rides here — `kickWaveform` is
 * called during mapping for any audio asset without peaks yet, the decode
 * resolves out-of-band, and `useSyncExternalStore(subscribeWaveforms,
 * getWaveformsVersion)` re-runs the mapping when a summary lands.
 *
 * Failures are cached as `null` (one warn, no retry storm) — a source that
 * can't decode just keeps the flat placeholder strip.
 */
import { waveformCache } from "@kneecap/editor-core/services/waveform-cache";
import type { SourceWaveformSummary } from "@kneecap/editor-core/media/waveform-summary";

const summaries = new Map<string, SourceWaveformSummary | null>();
const pending = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

export function subscribeWaveforms(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getWaveformsVersion(): number {
	return version;
}

export function getWaveformSummary(assetId: string): SourceWaveformSummary | null {
	return summaries.get(assetId) ?? null;
}

/** Idempotent decode kick — safe to call on every VM mapping pass. */
export function kickWaveform({
	assetId,
	file,
	url,
}: {
	assetId: string;
	file?: File;
	url?: string;
}): void {
	if (summaries.has(assetId) || pending.has(assetId)) return;
	pending.add(assetId);
	void waveformCache
		.getSourceSummary({ sourceKey: assetId, sourceFile: file, audioUrl: url })
		.then((summary) => {
			summaries.set(assetId, summary);
		})
		.catch((error: unknown) => {
			summaries.set(assetId, null);
			console.warn(
				`[kneecap-waveform] decode failed for asset ${assetId}:`,
				error instanceof Error ? error.message : String(error),
			);
		})
		.finally(() => {
			pending.delete(assetId);
			version += 1;
			for (const listener of listeners) listener();
		});
}

export function __resetWaveformPeaksForTests(): void {
	summaries.clear();
	pending.clear();
	version = 0;
	listeners.clear();
}
