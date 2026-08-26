/**
 * Dead-space detection — the analysis behind the timeline's "Cut gaps" verb
 * (founder, 2026-08-25: "when i select a clip i can cut all deadspace
 * without speech or any significant audio … it should be cut up like how a
 * human would cut it up and the clips that it makes should be concatenated
 * but not connected").
 *
 * Two layers, deliberately separated, because they fail differently:
 *
 *  1. MEASUREMENT (`FrameFeatureExtractor` + the gate in `detectDeadSpace`)
 *     — where is there sound at all. Short-time RMS in dBFS on 20 ms frames
 *     at a 10 ms hop, the standard speech-VAD framing, plus a per-frame
 *     zero-crossing rate.
 *
 *  2. EDITORIAL (`applyEditorialRules`) — where would a PERSON cut. The
 *     measurement's raw boundaries are not cut points: a human leaves air
 *     before a first syllable, a longer beat after a last one, never cuts a
 *     200 ms breath between words, and never leaves a 3-frame sliver.
 *
 * Design notes on the measurement, since the naive versions of this feature
 * all fail the same three ways:
 *
 *  - RMS, NOT PEAK. A single mouse click or a table bump is a peak; gating
 *    on peaks opens the gate on transients and keeps dead air. The repo's
 *    cached `SourceWaveformSummary` is peak-per-128-samples — great for
 *    DRAWING a waveform, wrong for gating one, which is why this module
 *    computes its own features instead of reusing it.
 *
 *  - AN ADAPTIVE THRESHOLD, NOT A FIXED dBFS. A hardcoded "-40 dBFS is
 *    silence" never fires on a quiet phone recording and fires constantly
 *    in a loud room. The noise floor is MEASURED as a low percentile of the
 *    frame energies and the gate is set a margin above it, so the same
 *    button behaves the same way on a whisper and on a shout.
 *
 *  - HYSTERESIS AND HANGOVER, NOT A BARE COMPARISON. One threshold chatters
 *    at the boundary and shreds a clip into dozens of pieces mid-word. The
 *    gate here is a Schmitt trigger (open high, close low) with a release
 *    tail, the same shape as a hardware noise gate.
 *
 * And one more, which is what actually separates this from a noise gate:
 * unvoiced fricatives (the /s/ in "yes", the /f/ in "off") sit 15-25 dB
 * below the vowels around them but carry a very high zero-crossing rate.
 * Energy alone deletes them and you get clipped, lisping word endings — the
 * single most audible artifact of automated silence removal. `zcr` exists
 * so `rescueFricatives` can walk a boundary back outward while the signal
 * still looks like broadband noise, the same idea as the endpoint extension
 * in classic Rabiner-Sambur endpointing.
 *
 * This file is pure and DOM-free on purpose: everything here is testable
 * against synthesised buffers, and `analyzeSourceDeadSpace` (media/
 * dead-space-analysis.ts) owns the decoding that isn't.
 */

/** Floor for the dB conversion: digital silence would otherwise be -Inf. */
export const SILENCE_DB_FLOOR = -100;

/**
 * At or below this, the signal is ABSENT — a muted stretch, a padded head,
 * a gap between packets — not a quiet room.
 *
 * The distinction matters because the noise floor is what the gate is
 * measured against. Found live on a real 32 s screen recording
 * (2026-08-25): it contained a stretch of exact digital zeros, the floor
 * estimate came back -100 dBFS, the gate landed at -92, every breath of
 * room tone in the file counted as "significant audio", and the clip was
 * reported as having nothing to cut. Room tone is what the threshold has to
 * clear; true silence is just something to cut, and it must not be allowed
 * to define the floor.
 */
const ABSENT_SIGNAL_DB = SILENCE_DB_FLOOR + 10;

export const DEFAULT_FRAME_MS = 20;
export const DEFAULT_HOP_MS = 10;

export interface FrameFeatures {
	/** Per-frame RMS in dBFS, clamped at `SILENCE_DB_FLOOR`. */
	rmsDb: Float32Array;
	/** Per-frame zero-crossing rate as crossings-per-sample (0..1). */
	zcr: Float32Array;
	sampleRate: number;
	frameSec: number;
	hopSec: number;
	/** Mono samples consumed, i.e. the true source duration in samples. */
	sampleCount: number;
}

/**
 * Streaming feature extractor: push decoded mono chunks in any sizes, get
 * frames out at `finish()`.
 *
 * Streaming rather than "decode the whole clip to a Float32Array, then
 * analyse" is not a style preference — a 10-minute 48 kHz clip is 115 MB of
 * float samples in the JS heap, which is the jetsam vector `media/
 * playable-source.ts` already documents for this app. Features are ~100
 * frames per second (800 bytes/s), so a 10-minute clip costs under 500 KB
 * no matter how long it runs.
 */
export class FrameFeatureExtractor {
	private readonly frameSamples: number;
	private readonly hopSamples: number;
	private readonly sampleRate: number;
	private buffer: Float32Array;
	private length = 0;
	private cursor = 0;
	private sampleCount = 0;
	private readonly rmsDb: number[] = [];
	private readonly zcr: number[] = [];
	/** One-pole DC-blocker state, carried across pushes — see `push`. */
	private dcPrevIn = 0;
	private dcPrevOut = 0;

	constructor({
		sampleRate,
		frameMs = DEFAULT_FRAME_MS,
		hopMs = DEFAULT_HOP_MS,
	}: {
		sampleRate: number;
		frameMs?: number;
		hopMs?: number;
	}) {
		if (!(sampleRate > 0)) {
			throw new Error(`FrameFeatureExtractor: bad sampleRate ${sampleRate}`);
		}
		this.sampleRate = sampleRate;
		this.frameSamples = Math.max(2, Math.round((sampleRate * frameMs) / 1000));
		this.hopSamples = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
		this.buffer = new Float32Array(this.frameSamples * 4);
	}

	/**
	 * Feed one decoded chunk of MONO samples.
	 *
	 * A one-pole DC blocker runs first (`y[n] = x[n] - x[n-1] + R*y[n-1]`).
	 * Phone and USB-mic captures routinely carry a DC offset of a few
	 * hundredths full-scale; left in, it raises the measured RMS of true
	 * silence (so the noise floor lands too high) and pins the signal to one
	 * side of zero (so the zero-crossing rate reads ~0 and the fricative
	 * rescue below never fires). Removing it is two multiplies per sample.
	 */
	push({ samples }: { samples: Float32Array }): void {
		if (samples.length === 0) return;
		this.ensureCapacity({ extra: samples.length });
		const buffer = this.buffer;
		let write = this.length;
		let prevIn = this.dcPrevIn;
		let prevOut = this.dcPrevOut;
		for (let i = 0; i < samples.length; i++) {
			const x = samples[i];
			const y = x - prevIn + 0.995 * prevOut;
			prevIn = x;
			prevOut = y;
			buffer[write++] = y;
		}
		this.dcPrevIn = prevIn;
		this.dcPrevOut = prevOut;
		this.length = write;
		this.sampleCount += samples.length;
		this.drainFrames();
	}

	finish(): FrameFeatures {
		return {
			rmsDb: Float32Array.from(this.rmsDb),
			zcr: Float32Array.from(this.zcr),
			sampleRate: this.sampleRate,
			frameSec: this.frameSamples / this.sampleRate,
			hopSec: this.hopSamples / this.sampleRate,
			sampleCount: this.sampleCount,
		};
	}

	private ensureCapacity({ extra }: { extra: number }): void {
		if (this.cursor > 0) {
			this.buffer.copyWithin(0, this.cursor, this.length);
			this.length -= this.cursor;
			this.cursor = 0;
		}
		const needed = this.length + extra;
		if (needed <= this.buffer.length) return;
		const grown = new Float32Array(Math.max(needed, this.buffer.length * 2));
		grown.set(this.buffer.subarray(0, this.length));
		this.buffer = grown;
	}

	private drainFrames(): void {
		const { buffer, frameSamples, hopSamples } = this;
		while (this.length - this.cursor >= frameSamples) {
			const start = this.cursor;
			const end = start + frameSamples;
			let sumSquares = 0;
			let crossings = 0;
			let prev = buffer[start];
			for (let i = start; i < end; i++) {
				const value = buffer[i];
				sumSquares += value * value;
				// Strict sign change only: a run of exact zeros (digital
				// silence) must NOT read as a crossing on every sample, or
				// silence would look like the noisiest thing in the file.
				if ((value > 0 && prev < 0) || (value < 0 && prev > 0)) {
					crossings++;
				}
				if (value !== 0) prev = value;
			}
			const rms = Math.sqrt(sumSquares / frameSamples);
			this.rmsDb.push(
				rms > 0 ? Math.max(SILENCE_DB_FLOOR, 20 * Math.log10(rms)) : SILENCE_DB_FLOOR,
			);
			this.zcr.push(crossings / frameSamples);
			this.cursor += hopSamples;
		}
	}
}

/** Mixes an `AudioBuffer`-shaped channel set down to one mono chunk. */
export function downmixToMono({
	channels,
	length,
}: {
	channels: Float32Array[];
	length: number;
}): Float32Array {
	if (channels.length === 1) return channels[0].subarray(0, length);
	const mono = new Float32Array(length);
	for (const channel of channels) {
		for (let i = 0; i < length; i++) mono[i] += channel[i] ?? 0;
	}
	const scale = 1 / channels.length;
	for (let i = 0; i < length; i++) mono[i] *= scale;
	return mono;
}

// ------------------------------- detection ---------------------------------

export interface DeadSpaceOptions {
	/**
	 * A quiet stretch shorter than this is RHYTHM, not dead air, and is left
	 * alone. This is the single knob that decides whether the result sounds
	 * human or breathless: cutting every 150 ms inter-word pause is exactly
	 * what makes auto-cut podcasts sound like a machine read them.
	 */
	minSilenceSec: number;
	/** Room tone kept before a kept region's first sound. */
	padInSec: number;
	/**
	 * Room tone kept after a kept region's last sound. Deliberately LONGER
	 * than `padInSec`: speech decays into breath and a hard truncation on a
	 * word's tail reads as a dropout, while a late entry reads as a normal
	 * edit. Same asymmetry a person uses cutting by hand.
	 */
	padOutSec: number;
	/** Kept regions shorter than this are dropped rather than emitted. */
	minKeepSec: number;
	/**
	 * Air left inside each REMOVED gap. 0 closes gaps completely (what "cut
	 * all dead space" asks for); raise it to "tighten" instead of "remove".
	 */
	keepGapSec: number;
	/** How far above the measured noise floor the gate sits. */
	thresholdMarginDb: number;
	/** Schmitt-trigger half-width: open at +this, close at -this. */
	hysteresisDb: number;
	/** How long the gate stays open after the level drops (unvoiced tails). */
	hangoverSec: number;
	/** Below this floor-to-speech spread, refuse rather than guess. */
	minDynamicRangeDb: number;
	/**
	 * The gate never sits further than this below the loud material.
	 *
	 * Phone and screen recordings run noise suppression, so their pauses are
	 * pushed to near-digital-silence and the measured floor comes back around
	 * -90 dBFS. Threshold-from-floor then lands near -80, where every trace
	 * of breath counts as "significant audio" and no gap is ever cut (found
	 * live on three real recordings, 2026-08-25). Dead space is relative to
	 * how loud the content is: 45 dB under the voice is silence by any
	 * standard, and nothing a listener would miss lives below it.
	 */
	maxRangeBelowSpeechDb: number;
	/** Refuse when the plan would keep less than this fraction of the clip. */
	minKeptFraction: number;
	/** Refuse when the plan would emit more pieces than this. */
	maxSegments: number;
	/** Fricative rescue fires while ZCR exceeds the quiet-frame ZCR by this. */
	zcrRescueRatio: number;
	/** Hard cap on how far the fricative rescue may extend one boundary. */
	zcrRescueMaxSec: number;
}

export const DEFAULT_DEAD_SPACE_OPTIONS: DeadSpaceOptions = {
	minSilenceSec: 0.35,
	padInSec: 0.08,
	padOutSec: 0.18,
	minKeepSec: 0.2,
	keepGapSec: 0,
	thresholdMarginDb: 8,
	hysteresisDb: 3,
	hangoverSec: 0.2,
	minDynamicRangeDb: 8,
	maxRangeBelowSpeechDb: 45,
	minKeptFraction: 0.1,
	maxSegments: 200,
	zcrRescueRatio: 1.6,
	zcrRescueMaxSec: 0.12,
};

export interface TimeSpanSec {
	startSec: number;
	endSec: number;
}

/**
 * Why a clip was left untouched. Every one of these is a REFUSAL, not an
 * error: the button did its job by declining, and the UI says so instead of
 * silently shredding footage.
 */
export type DeadSpaceRefusal =
	/** No decodable audio, or the whole window is digital silence. */
	| "no-audio"
	/** Floor and speech are too close — constant music, noise, or a room
	 *  loud enough that nothing here is a "quiet part". */
	| "no-dynamic-range"
	/** Real speech, real silence, but no gap long enough to be worth a cut. */
	| "nothing-to-cut"
	/** The plan kept almost nothing — a misdetection, not an edit. */
	| "would-remove-everything"
	/** More pieces than any human would make; the gate was chattering. */
	| "too-fragmented";

export interface DeadSpaceAnalysis {
	/** Kept regions in SOURCE seconds, ascending, non-overlapping. */
	segments: TimeSpanSec[];
	noiseFloorDb: number;
	speechDb: number;
	thresholdDb: number;
	openDb: number;
	closeDb: number;
	windowSec: number;
	keptSec: number;
	removedSec: number;
	/** Non-null means nothing should be changed. `segments` is then empty. */
	refusal: DeadSpaceRefusal | null;
}

function percentile({
	sorted,
	fraction,
}: {
	sorted: Float32Array | number[];
	fraction: number;
}): number {
	const n = sorted.length;
	if (n === 0) return Number.NaN;
	const index = Math.min(n - 1, Math.max(0, Math.round(fraction * (n - 1))));
	return sorted[index];
}

function refuse({
	reason,
	windowSec,
	noiseFloorDb,
	speechDb,
	thresholdDb,
	openDb,
	closeDb,
}: {
	reason: DeadSpaceRefusal;
	windowSec: number;
	noiseFloorDb: number;
	speechDb: number;
	thresholdDb: number;
	openDb: number;
	closeDb: number;
}): DeadSpaceAnalysis {
	return {
		segments: [],
		noiseFloorDb,
		speechDb,
		thresholdDb,
		openDb,
		closeDb,
		windowSec,
		keptSec: 0,
		removedSec: 0,
		refusal: reason,
	};
}

/**
 * Runs the gate over `features`, restricted to `window` (a trimmed clip
 * measures its OWN visible window — a noise floor taken from material the
 * clip doesn't show would set the threshold for footage nobody sees).
 *
 * Returned spans are in absolute SOURCE seconds, the same coordinate space
 * as `TimelineElement.trimStart`.
 */
export function detectDeadSpace({
	features,
	window,
	options = DEFAULT_DEAD_SPACE_OPTIONS,
}: {
	features: FrameFeatures;
	window?: TimeSpanSec;
	options?: DeadSpaceOptions;
}): DeadSpaceAnalysis {
	const { rmsDb, zcr, hopSec, frameSec } = features;
	const sourceSec = features.sampleCount / features.sampleRate;
	const windowStart = Math.max(0, window?.startSec ?? 0);
	const windowEnd = Math.min(sourceSec, window?.endSec ?? sourceSec);
	const windowSec = Math.max(0, windowEnd - windowStart);
	const empty = {
		windowSec,
		noiseFloorDb: SILENCE_DB_FLOOR,
		speechDb: SILENCE_DB_FLOOR,
		thresholdDb: SILENCE_DB_FLOOR,
		openDb: SILENCE_DB_FLOOR,
		closeDb: SILENCE_DB_FLOOR,
	};
	if (rmsDb.length === 0 || windowSec <= 0) {
		return refuse({ reason: "no-audio", ...empty });
	}

	const firstFrame = Math.max(0, Math.floor(windowStart / hopSec));
	const lastFrame = Math.min(
		rmsDb.length - 1,
		Math.ceil((windowEnd - frameSec) / hopSec),
	);
	if (lastFrame < firstFrame) {
		return refuse({ reason: "no-audio", ...empty });
	}

	const levels = rmsDb.slice(firstFrame, lastFrame + 1);
	const sorted = Float32Array.from(levels).sort();
	const speechDb = percentile({ sorted, fraction: 0.95 });
	// The floor is measured over PRESENT signal only — see ABSENT_SIGNAL_DB.
	const present = Float32Array.from(levels.filter((db) => db > ABSENT_SIGNAL_DB)).sort();
	const noiseFloorDb =
		present.length === 0
			? SILENCE_DB_FLOOR
			: Math.min(
					percentile({ sorted: present, fraction: 0.1 }),
					quietestWindowDb({
						rmsDb,
						firstFrame,
						lastFrame,
						windowFrames: Math.max(1, Math.round(0.1 / hopSec)),
					}),
				);

	if (speechDb <= SILENCE_DB_FLOOR + 1) {
		return refuse({ reason: "no-audio", ...empty, noiseFloorDb, speechDb });
	}
	if (speechDb - noiseFloorDb < options.minDynamicRangeDb) {
		return refuse({
			reason: "no-dynamic-range",
			...empty,
			noiseFloorDb,
			speechDb,
		});
	}

	// The gate sits a margin above the measured floor — but bounded from BOTH
	// sides against the loud material. Never within 6 dB of it (a compressed
	// recording keeps more rather than losing quiet speech), and never more
	// than `maxRangeBelowSpeechDb` under it (a noise-suppressed recording
	// gets a gate that can actually fire).
	const thresholdDb = Math.min(
		Math.max(
			noiseFloorDb + options.thresholdMarginDb,
			speechDb - options.maxRangeBelowSpeechDb,
		),
		speechDb - 6,
	);
	const openDb = thresholdDb + options.hysteresisDb;
	const closeDb = thresholdDb - options.hysteresisDb;

	const raw = runGate({
		rmsDb,
		firstFrame,
		lastFrame,
		openDb,
		closeDb,
		hangoverFrames: Math.max(0, Math.round(options.hangoverSec / hopSec)),
	});

	const rescued = rescueFricatives({
		spans: raw,
		zcr,
		rmsDb,
		firstFrame,
		lastFrame,
		thresholdDb,
		ratio: options.zcrRescueRatio,
		maxFrames: Math.max(0, Math.round(options.zcrRescueMaxSec / hopSec)),
	});

	const segments = applyEditorialRules({
		spans: rescued.map(({ startFrame, endFrame }) => ({
			startSec: startFrame * hopSec,
			// A frame covers [i*hop, i*hop + frameSec): the last frame's
			// content runs to its END, not to its start.
			endSec: endFrame * hopSec + frameSec,
		})),
		windowStart,
		windowEnd,
		options,
	});

	if (segments.length === 0) {
		return refuse({
			reason: "would-remove-everything",
			...empty,
			noiseFloorDb,
			speechDb,
			thresholdDb,
			openDb,
			closeDb,
		});
	}
	if (segments.length > options.maxSegments) {
		return refuse({
			reason: "too-fragmented",
			...empty,
			noiseFloorDb,
			speechDb,
			thresholdDb,
			openDb,
			closeDb,
		});
	}

	const keptSec = segments.reduce(
		(sum, span) => sum + (span.endSec - span.startSec),
		0,
	);
	const removedSec = Math.max(0, windowSec - keptSec);

	if (keptSec / windowSec < options.minKeptFraction) {
		return refuse({
			reason: "would-remove-everything",
			...empty,
			noiseFloorDb,
			speechDb,
			thresholdDb,
			openDb,
			closeDb,
		});
	}
	// One piece that spans the whole window is not an edit — the clip is
	// already tight. Say so rather than replacing it with a copy of itself.
	if (removedSec < options.minSilenceSec) {
		return refuse({
			reason: "nothing-to-cut",
			...empty,
			noiseFloorDb,
			speechDb,
			thresholdDb,
			openDb,
			closeDb,
		});
	}

	return {
		segments,
		noiseFloorDb,
		speechDb,
		thresholdDb,
		openDb,
		closeDb,
		windowSec,
		keptSec,
		removedSec,
		refusal: null,
	};
}

/**
 * Noise floor as the quietest sustained stretch, not just a low percentile.
 *
 * A percentile alone assumes the clip HAS a decent fraction of silence in
 * it: on a take that is 95 % talking with one short pause, the 10th
 * percentile lands inside the speech, the measured "floor" comes out only a
 * few dB under the voice, and the whole clip gets written off as having no
 * dynamic range — the exact case that made this function necessary. Taking
 * the minimum mean over a sliding ~100 ms window (the min-statistics idea
 * from speech enhancement) finds the room tone however little of it there
 * is, while still being long enough that one dropped frame can't define it.
 *
 * The caller takes the LOWER of this and the percentile, because a lower
 * floor means a lower gate, which means keeping more.
 */
function quietestWindowDb({
	rmsDb,
	firstFrame,
	lastFrame,
	windowFrames,
}: {
	rmsDb: Float32Array;
	firstFrame: number;
	lastFrame: number;
	windowFrames: number;
}): number {
	const available = lastFrame - firstFrame + 1;
	if (available <= 0) return Number.POSITIVE_INFINITY;
	const width = Math.min(windowFrames, available);
	let sum = 0;
	for (let i = firstFrame; i < firstFrame + width; i++) sum += rmsDb[i];
	let quietest = Number.POSITIVE_INFINITY;
	const consider = ({ mean }: { mean: number }): void => {
		// Windows sitting in absent signal describe nothing about the room.
		if (mean > ABSENT_SIGNAL_DB && mean < quietest) quietest = mean;
	};
	consider({ mean: sum / width });
	for (let i = firstFrame + width; i <= lastFrame; i++) {
		sum += rmsDb[i] - rmsDb[i - width];
		consider({ mean: sum / width });
	}
	return quietest;
}

interface FrameSpan {
	startFrame: number;
	endFrame: number;
}

/**
 * The Schmitt-triggered gate with a release tail.
 *
 * Open needs one frame at or above `openDb`. Close needs `hangoverFrames`
 * CONSECUTIVE frames below `closeDb` — and the span then ends where the
 * quiet started, not where the hangover expired, so the tail is a detection
 * delay rather than extra material. Anything between the two thresholds
 * holds the current state, which is what stops the boundary chatter that
 * turns a single sentence into fourteen clips.
 */
function runGate({
	rmsDb,
	firstFrame,
	lastFrame,
	openDb,
	closeDb,
	hangoverFrames,
}: {
	rmsDb: Float32Array;
	firstFrame: number;
	lastFrame: number;
	openDb: number;
	closeDb: number;
	hangoverFrames: number;
}): FrameSpan[] {
	const spans: FrameSpan[] = [];
	let open = false;
	let startFrame = 0;
	let quietSince = -1;

	for (let i = firstFrame; i <= lastFrame; i++) {
		const level = rmsDb[i];
		if (!open) {
			if (level >= openDb) {
				open = true;
				startFrame = i;
				quietSince = -1;
			}
			continue;
		}
		if (level < closeDb) {
			if (quietSince < 0) quietSince = i;
			if (i - quietSince >= hangoverFrames) {
				spans.push({ startFrame, endFrame: Math.max(startFrame, quietSince - 1) });
				open = false;
				quietSince = -1;
			}
		} else if (level >= openDb) {
			quietSince = -1;
		}
	}
	if (open) {
		spans.push({ startFrame, endFrame: lastFrame });
	}
	return spans;
}

/**
 * Walks each boundary outward while the signal still looks like broadband
 * noise rather than room tone.
 *
 * `/s/`, `/f/`, `/sh/` and stop bursts run 15-25 dB under the vowels beside
 * them, so the energy gate closes on top of them and you lose the end of
 * "yes" and the start of "stop". They are, however, the highest-ZCR content
 * in speech, and room tone is not — so extending a boundary while ZCR stays
 * well above the quiet-frame median recovers them without opening the gate
 * on silence. Capped by `maxFrames` so a hissy recording can't extend a
 * boundary indefinitely, and only ever applied ADJACENT to a region the
 * energy gate already accepted.
 */
function rescueFricatives({
	spans,
	zcr,
	rmsDb,
	firstFrame,
	lastFrame,
	thresholdDb,
	ratio,
	maxFrames,
}: {
	spans: FrameSpan[];
	zcr: Float32Array;
	rmsDb: Float32Array;
	firstFrame: number;
	lastFrame: number;
	thresholdDb: number;
	ratio: number;
	maxFrames: number;
}): FrameSpan[] {
	if (spans.length === 0 || maxFrames === 0) return spans;

	const quiet: number[] = [];
	for (let i = firstFrame; i <= lastFrame; i++) {
		if (rmsDb[i] < thresholdDb) quiet.push(zcr[i]);
	}
	if (quiet.length === 0) return spans;
	quiet.sort((a, b) => a - b);
	const quietZcr = percentile({ sorted: quiet, fraction: 0.5 });
	// A dead-quiet floor gives a ~0 median, which would make ANY frame
	// "1.6x the floor". Require a real, absolute amount of high-frequency
	// activity too before extending.
	const zcrGate = Math.max(quietZcr * ratio, 0.05);

	return spans.map(({ startFrame, endFrame }) => {
		let start = startFrame;
		for (let n = 0; n < maxFrames && start - 1 >= firstFrame; n++) {
			if (zcr[start - 1] <= zcrGate) break;
			start--;
		}
		let end = endFrame;
		for (let n = 0; n < maxFrames && end + 1 <= lastFrame; n++) {
			if (zcr[end + 1] <= zcrGate) break;
			end++;
		}
		return { startFrame: start, endFrame: end };
	});
}

/**
 * The human layer. Takes detected sound regions and turns them into the
 * cuts an editor would actually make.
 *
 * Order matters: pad FIRST, then merge on `minSilenceSec`. Merging on the
 * padded spans is what makes "don't cut short pauses" and "don't leave
 * overlapping pieces" the same rule — after padding, two regions separated
 * by less than a cuttable gap simply become one region.
 */
export function applyEditorialRules({
	spans,
	windowStart,
	windowEnd,
	options,
}: {
	spans: TimeSpanSec[];
	windowStart: number;
	windowEnd: number;
	options: DeadSpaceOptions;
}): TimeSpanSec[] {
	const padded = spans
		.map(({ startSec, endSec }) => ({
			startSec: Math.max(windowStart, startSec - options.padInSec),
			endSec: Math.min(windowEnd, endSec + options.padOutSec),
		}))
		.filter((span) => span.endSec > span.startSec)
		.sort((a, b) => a.startSec - b.startSec);

	const merged: TimeSpanSec[] = [];
	for (const span of padded) {
		const last = merged[merged.length - 1];
		if (last && span.startSec - last.endSec < options.minSilenceSec) {
			last.endSec = Math.max(last.endSec, span.endSec);
			continue;
		}
		merged.push({ ...span });
	}

	// "Tighten" mode: hand back part of each removed gap instead of all of
	// it. Inert at the default 0.
	if (options.keepGapSec > 0 && merged.length > 1) {
		const half = options.keepGapSec / 2;
		for (let i = 0; i < merged.length - 1; i++) {
			const gap = merged[i + 1].startSec - merged[i].endSec;
			const give = Math.min(half, Math.max(0, gap / 2 - 0.001));
			merged[i].endSec += give;
			merged[i + 1].startSec -= give;
		}
	}

	return merged.filter(
		(span) => span.endSec - span.startSec >= options.minKeepSec,
	);
}
