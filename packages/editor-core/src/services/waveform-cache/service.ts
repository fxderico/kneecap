"use client";

import { createAudioContext } from "@/media/audio";
import {
	buildSourceWaveformSummary,
	type SourceWaveformSummary,
} from "@/media/waveform-summary";

interface GetSourceWaveformSummaryArgs {
	sourceKey: string;
	audioBuffer?: AudioBuffer;
	sourceFile?: File;
	audioUrl?: string;
}

export class WaveformCache {
	private summaries = new Map<string, Promise<SourceWaveformSummary>>();

	getSourceSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		const existing = this.summaries.get(sourceKey);
		if (existing) {
			return existing;
		}

		const promise = this.buildSummary({
			sourceKey,
			audioBuffer,
			sourceFile,
			audioUrl,
		}).catch((error) => {
			this.summaries.delete(sourceKey);
			throw error;
		});

		this.summaries.set(sourceKey, promise);
		return promise;
	}

	clearSource({ sourceKey }: { sourceKey: string }): void {
		this.summaries.delete(sourceKey);
	}

	clearAll(): void {
		this.summaries.clear();
	}

	private async buildSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		if (audioBuffer) {
			return buildSourceWaveformSummary({ sourceKey, buffer: audioBuffer });
		}

		let arrayBuffer: ArrayBuffer | null = null;
		if (sourceFile && sourceFile.size > 0) {
			arrayBuffer = await sourceFile.arrayBuffer();
		} else if (audioUrl) {
			// NOT gated on response.ok: Capacitor iOS serves media as a
			// statusless URLResponse (status 0, ok=false, bytes fine) — the
			// same trap readPlayableBytes documents. Empty bytes are the
			// real failure signal.
			const response = await fetch(audioUrl);
			arrayBuffer = await response.arrayBuffer();
			if (arrayBuffer.byteLength === 0) {
				throw new Error(
					`Failed to fetch waveform source (status ${response.status}, 0 bytes)`,
				);
			}
		}

		if (!arrayBuffer) {
			throw new Error(`No waveform source available for ${sourceKey}`);
		}

		const audioContext = createAudioContext();
		try {
			const buffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
			return buildSourceWaveformSummary({ sourceKey, buffer });
		} finally {
			void audioContext.close();
		}
	}
}

export const waveformCache = new WaveformCache();
