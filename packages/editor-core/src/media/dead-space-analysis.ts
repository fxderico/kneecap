"use client";

/**
 * Decode side of the "Cut gaps" verb: turns an imported asset into the
 * frame features `media/dead-space.ts` gates on, without ever holding the
 * whole waveform in the JS heap.
 *
 * Decode strategy mirrors `AudioManager.decodeClipBuffer` exactly, because
 * that pair of routes is the one combination proven to work on BOTH targets
 * (device bisect, 2026-08-19/20):
 *
 *  1. mediabunny `AudioBufferSink` over `createPlayableSource`. Streams via
 *     Range requests, so a 200 MB proxy never lands in memory — but it needs
 *     WebCodecs `AudioDecoder`.
 *  2. WebAudio `decodeAudioData` on the whole file, and when that rejects
 *     (WebKit refuses MOVIE containers outright) a mediabunny packet-COPY
 *     remux to audio-only mp4, then decode that. No WebCodecs required.
 *
 * Route 1 is tried first and route 2 catches everything it can't do,
 * including a sink that yields zero chunks.
 *
 * Features are cached per source key for the session: they are ~800 bytes
 * per second of audio, and re-cutting a second clip off the same asset (the
 * normal case once a long take has been split) then costs nothing.
 */

import {
	ALL_FORMATS,
	AudioBufferSink,
	BlobSource,
	BufferTarget,
	Conversion,
	Input,
	Mp4OutputFormat,
	Output,
} from "mediabunny";
import { createAudioContext } from "@/media/audio";
import { createPlayableSource, readPlayableBytes } from "@/media/playable-source";
import {
	downmixToMono,
	FrameFeatureExtractor,
	type FrameFeatures,
} from "@/media/dead-space";

export interface DeadSpaceProgress {
	/** 0..1, or null while the total duration is still unknown. */
	fraction: number | null;
}

interface AnalyzeArgs {
	file: File | null;
	url: string | null;
	/** Source duration in seconds, when the caller knows it (asset metadata) —
	 *  used only to report progress. */
	durationSecHint?: number;
	onProgress?: (progress: DeadSpaceProgress) => void;
}

const featureCache = new Map<string, Promise<FrameFeatures>>();

/** Session cache over `analyzeSourceAudio`, keyed like `waveformCache`. */
export function getSourceDeadSpaceFeatures({
	sourceKey,
	file,
	url,
	durationSecHint,
	onProgress,
}: AnalyzeArgs & { sourceKey: string }): Promise<FrameFeatures> {
	const existing = featureCache.get(sourceKey);
	if (existing) return existing;
	const promise = analyzeSourceAudio({
		file,
		url,
		durationSecHint,
		onProgress,
	}).catch((error: unknown) => {
		featureCache.delete(sourceKey);
		throw error;
	});
	featureCache.set(sourceKey, promise);
	return promise;
}

export function clearDeadSpaceFeatureCache({
	sourceKey,
}: {
	sourceKey?: string;
} = {}): void {
	if (sourceKey === undefined) featureCache.clear();
	else featureCache.delete(sourceKey);
}

export async function analyzeSourceAudio({
	file,
	url,
	durationSecHint,
	onProgress,
}: AnalyzeArgs): Promise<FrameFeatures> {
	const streamed = await analyzeViaSink({
		file,
		url,
		durationSecHint,
		onProgress,
	});
	if (streamed) return streamed;
	return analyzeViaWebAudio({ file, url, onProgress });
}

async function analyzeViaSink({
	file,
	url,
	durationSecHint,
	onProgress,
}: AnalyzeArgs): Promise<FrameFeatures | null> {
	if (typeof (globalThis as { AudioDecoder?: unknown }).AudioDecoder === "undefined") {
		return null;
	}

	let input: Input;
	try {
		input = new Input({
			source: createPlayableSource({ file, url }),
			formats: ALL_FORMATS,
		});
	} catch (error) {
		console.warn("[dead-space] no playable source for sink route:", error);
		return null;
	}

	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) return null;

		const totalSec =
			durationSecHint ?? (await audioTrack.computeDuration().catch(() => 0));
		const sink = new AudioBufferSink(audioTrack);

		let extractor: FrameFeatureExtractor | null = null;
		let expectedSec = 0;
		let sampleRate = 0;
		let chunks = 0;

		for await (const { buffer, timestamp } of sink.buffers(0)) {
			if (!extractor) {
				sampleRate = buffer.sampleRate;
				extractor = new FrameFeatureExtractor({ sampleRate });
			}
			// Keep frame indices pinned to REAL source time. A track with a
			// packet gap (or that simply starts late) would otherwise shift
			// every later frame earlier, and the cut points derived from
			// those frames would land in the wrong place on the timeline.
			const gapSec = timestamp - expectedSec;
			if (gapSec > 1 / sampleRate) {
				extractor.push({
					samples: new Float32Array(Math.round(gapSec * sampleRate)),
				});
				expectedSec += gapSec;
			}
			const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
				buffer.getChannelData(c),
			);
			extractor.push({
				samples: downmixToMono({ channels, length: buffer.length }),
			});
			expectedSec += buffer.length / sampleRate;
			chunks++;
			if ((chunks & 0x1f) === 0) {
				onProgress?.({
					fraction: totalSec > 0 ? Math.min(1, expectedSec / totalSec) : null,
				});
			}
		}

		if (!extractor || chunks === 0) return null;
		onProgress?.({ fraction: 1 });
		return extractor.finish();
	} catch (error) {
		console.warn("[dead-space] sink route failed — falling back to WebAudio:", error);
		return null;
	} finally {
		input.dispose();
	}
}

async function analyzeViaWebAudio({
	file,
	url,
	onProgress,
}: AnalyzeArgs): Promise<FrameFeatures> {
	const bytes = await readPlayableBytes({ file, url });
	const audioContext = createAudioContext();
	try {
		let buffer: AudioBuffer;
		try {
			buffer = await audioContext.decodeAudioData(bytes.slice(0));
		} catch {
			// WebKit rejects movie containers outright — remux the audio
			// track out as a pure packet copy (no decoding, so this route
			// still needs no WebCodecs) and decode that instead.
			buffer = await audioContext.decodeAudioData(
				await remuxAudioOnly({ bytes }),
			);
		}
		onProgress?.({ fraction: 1 });
		return extractFeaturesFromAudioBuffer({ buffer });
	} finally {
		void audioContext.close();
	}
}

/**
 * Packet COPY of the audio track into an audio-only mp4 — no decoding, so
 * it works on WebKit builds without WebCodecs. Same recipe as
 * `AudioManager.decodeClipBufferViaWebAudio`'s remux fallback.
 */
async function remuxAudioOnly({ bytes }: { bytes: ArrayBuffer }): Promise<ArrayBuffer> {
	const input = new Input({
		source: new BlobSource(new Blob([bytes])),
		formats: ALL_FORMATS,
	});
	const target = new BufferTarget();
	const conversion = await Conversion.init({
		input,
		output: new Output({
			format: new Mp4OutputFormat({ fastStart: "in-memory" }),
			target,
		}),
		video: { discard: true },
	});
	await conversion.execute();
	if (!target.buffer) {
		throw new Error("dead-space: audio remux produced no buffer");
	}
	return target.buffer;
}

/** Frame features for an already-decoded buffer — the test/seam entry point. */
export function extractFeaturesFromAudioBuffer({
	buffer,
}: {
	buffer: AudioBuffer;
}): FrameFeatures {
	const extractor = new FrameFeatureExtractor({ sampleRate: buffer.sampleRate });
	const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
		buffer.getChannelData(c),
	);
	// Chunked so a long clip never allocates a second full-length mono copy.
	const CHUNK = 1 << 18;
	for (let offset = 0; offset < buffer.length; offset += CHUNK) {
		const length = Math.min(CHUNK, buffer.length - offset);
		extractor.push({
			samples: downmixToMono({
				channels: channels.map((c) => c.subarray(offset, offset + length)),
				length,
			}),
		});
	}
	return extractor.finish();
}
