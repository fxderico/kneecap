import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DEAD_SPACE_OPTIONS,
	FrameFeatureExtractor,
	detectDeadSpace,
	downmixToMono,
	type DeadSpaceOptions,
	type FrameFeatures,
} from "@/media/dead-space";

const RATE = 48000;

/** Deterministic LCG — `Math.random()` in a threshold test is a flaky test. */
function makeNoise({ seed }: { seed: number }): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return (state / 0x100000000) * 2 - 1;
	};
}

interface Section {
	seconds: number;
	/** Linear amplitude, 1 = full scale. */
	amplitude: number;
	kind: "tone" | "noise";
}

/** Builds a mono test signal with a constant low-level room-tone bed. */
function synthesize({
	sections,
	roomToneAmplitude = 0.002,
	dcOffset = 0,
	seed = 7,
}: {
	sections: Section[];
	roomToneAmplitude?: number;
	dcOffset?: number;
	seed?: number;
}): Float32Array {
	const totalSamples = Math.round(
		sections.reduce((sum, s) => sum + s.seconds, 0) * RATE,
	);
	const out = new Float32Array(totalSamples);
	const noise = makeNoise({ seed });
	let cursor = 0;
	for (const section of sections) {
		const length = Math.round(section.seconds * RATE);
		for (let i = 0; i < length && cursor < totalSamples; i++, cursor++) {
			const bed = noise() * roomToneAmplitude;
			const body =
				section.amplitude === 0
					? 0
					: section.kind === "tone"
						? Math.sin((2 * Math.PI * 220 * i) / RATE) * section.amplitude
						: noise() * section.amplitude;
			out[cursor] = bed + body + dcOffset;
		}
	}
	return out;
}

function features({
	samples,
	chunkSamples = 4096,
}: {
	samples: Float32Array;
	chunkSamples?: number;
}): FrameFeatures {
	const extractor = new FrameFeatureExtractor({ sampleRate: RATE });
	for (let offset = 0; offset < samples.length; offset += chunkSamples) {
		extractor.push({
			samples: samples.subarray(
				offset,
				Math.min(samples.length, offset + chunkSamples),
			),
		});
	}
	return extractor.finish();
}

function options(overrides: Partial<DeadSpaceOptions> = {}): DeadSpaceOptions {
	return { ...DEFAULT_DEAD_SPACE_OPTIONS, ...overrides };
}

describe("frame feature extraction", () => {
	test("frames the signal at a 10 ms hop regardless of chunk sizes", () => {
		const samples = synthesize({
			sections: [{ seconds: 2, amplitude: 0.3, kind: "tone" }],
		});
		const wholeFile = features({ samples, chunkSamples: samples.length });
		const dribbled = features({ samples, chunkSamples: 997 });

		expect(wholeFile.hopSec).toBeCloseTo(0.01, 6);
		expect(wholeFile.frameSec).toBeCloseTo(0.02, 6);
		expect(wholeFile.sampleCount).toBe(samples.length);
		// ~2 s at a 10 ms hop, minus the frame that can't be filled at the end.
		expect(wholeFile.rmsDb.length).toBeGreaterThan(195);
		expect(dribbled.rmsDb.length).toBe(wholeFile.rmsDb.length);
		for (let i = 0; i < wholeFile.rmsDb.length; i++) {
			expect(dribbled.rmsDb[i]).toBeCloseTo(wholeFile.rmsDb[i], 4);
		}
	});

	test("reads a loud tone far above a quiet bed", () => {
		const loud = features({
			samples: synthesize({
				sections: [{ seconds: 0.5, amplitude: 0.5, kind: "tone" }],
				roomToneAmplitude: 0,
			}),
		});
		const quiet = features({
			samples: synthesize({
				sections: [{ seconds: 0.5, amplitude: 0, kind: "tone" }],
				roomToneAmplitude: 0.002,
			}),
		});
		expect(loud.rmsDb[20]).toBeGreaterThan(-15);
		expect(quiet.rmsDb[20]).toBeLessThan(-45);
	});

	test("noise reads a far higher zero-crossing rate than a low tone", () => {
		const noisy = features({
			samples: synthesize({
				sections: [{ seconds: 0.5, amplitude: 0.2, kind: "noise" }],
				roomToneAmplitude: 0,
			}),
		});
		const tonal = features({
			samples: synthesize({
				sections: [{ seconds: 0.5, amplitude: 0.2, kind: "tone" }],
				roomToneAmplitude: 0,
			}),
		});
		expect(noisy.zcr[20]).toBeGreaterThan(tonal.zcr[20] * 5);
	});

	test("a DC offset does not raise the measured floor or flatten the ZCR", () => {
		const clean = features({
			samples: synthesize({
				sections: [{ seconds: 1, amplitude: 0, kind: "tone" }],
				roomToneAmplitude: 0.002,
			}),
		});
		const biased = features({
			samples: synthesize({
				sections: [{ seconds: 1, amplitude: 0, kind: "tone" }],
				roomToneAmplitude: 0.002,
				dcOffset: 0.05,
			}),
		});
		// Without the DC blocker this frame would read ~-26 dB (the offset),
		// not the ~-54 dB of the actual room tone.
		expect(biased.rmsDb[50]).toBeLessThan(clean.rmsDb[50] + 6);
		expect(biased.zcr[50]).toBeGreaterThan(0.05);
	});

	test("downmix averages channels", () => {
		const left = Float32Array.from([1, 0, -1]);
		const right = Float32Array.from([0, 0, 1]);
		expect(Array.from(downmixToMono({ channels: [left, right], length: 3 }))).toEqual([
			0.5, 0, 0,
		]);
	});
});

describe("dead-space detection", () => {
	test("finds the two spoken regions and drops the dead air around them", () => {
		//  0.0-1.0 silence | 1.0-3.0 speech | 3.0-4.5 silence | 4.5-5.5 speech | 5.5-6.0 silence
		const analysis = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [
						{ seconds: 1.0, amplitude: 0, kind: "tone" },
						{ seconds: 2.0, amplitude: 0.25, kind: "noise" },
						{ seconds: 1.5, amplitude: 0, kind: "tone" },
						{ seconds: 1.0, amplitude: 0.25, kind: "noise" },
						{ seconds: 0.5, amplitude: 0, kind: "tone" },
					],
				}),
			}),
			options: options(),
		});

		expect(analysis.refusal).toBeNull();
		expect(analysis.segments.length).toBe(2);
		// Padding pulls each boundary outward by padIn/padOut; the gate itself
		// must land within a frame or two of the real transition.
		expect(analysis.segments[0].startSec).toBeCloseTo(1.0 - 0.08, 1);
		expect(analysis.segments[0].endSec).toBeCloseTo(3.0 + 0.18, 1);
		expect(analysis.segments[1].startSec).toBeCloseTo(4.5 - 0.08, 1);
		expect(analysis.segments[1].endSec).toBeCloseTo(5.5 + 0.18, 1);
		expect(analysis.removedSec).toBeGreaterThan(2.4);
		expect(analysis.noiseFloorDb).toBeLessThan(analysis.speechDb - 20);
	});

	test("leaves a short pause alone but cuts a long one", () => {
		const build = ({ pauseSec }: { pauseSec: number }) =>
			detectDeadSpace({
				features: features({
					samples: synthesize({
						sections: [
							{ seconds: 1.0, amplitude: 0.25, kind: "noise" },
							{ seconds: pauseSec, amplitude: 0, kind: "tone" },
							{ seconds: 1.0, amplitude: 0.25, kind: "noise" },
							{ seconds: 1.2, amplitude: 0, kind: "tone" },
							{ seconds: 1.0, amplitude: 0.25, kind: "noise" },
						],
					}),
				}),
				options: options(),
			});

		// 0.2 s is rhythm between words — a human would not cut it, and the
		// padding alone already covers most of it.
		const short = build({ pauseSec: 0.2 });
		expect(short.refusal).toBeNull();
		expect(short.segments.length).toBe(2);

		// 0.9 s is dead air.
		const long = build({ pauseSec: 0.9 });
		expect(long.refusal).toBeNull();
		expect(long.segments.length).toBe(3);
	});

	test("keeps a quiet high-ZCR tail that a bare energy gate would clip", () => {
		// A vowel, then a fricative 26 dB down — the /s/ at the end of a word.
		const withTail = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [
						{ seconds: 1.0, amplitude: 0, kind: "tone" },
						{ seconds: 1.0, amplitude: 0.4, kind: "tone" },
						{ seconds: 0.1, amplitude: 0.02, kind: "noise" },
						{ seconds: 1.5, amplitude: 0, kind: "tone" },
					],
					roomToneAmplitude: 0.0005,
				}),
			}),
			options: options({ padOutSec: 0, hangoverSec: 0 }),
		});
		expect(withTail.refusal).toBeNull();
		// The energy gate closes at 2.0 s; the fricative rescue must carry the
		// boundary past it into the 0.1 s tail.
		expect(withTail.segments[0].endSec).toBeGreaterThan(2.02);
	});

	test("refuses digital silence rather than deleting the clip", () => {
		const analysis = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [{ seconds: 3, amplitude: 0, kind: "tone" }],
					roomToneAmplitude: 0,
				}),
			}),
			options: options(),
		});
		expect(analysis.refusal).toBe("no-audio");
		expect(analysis.segments).toEqual([]);
	});

	test("refuses a clip with no quiet parts to find", () => {
		const analysis = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [{ seconds: 3, amplitude: 0.3, kind: "noise" }],
					roomToneAmplitude: 0,
				}),
			}),
			options: options(),
		});
		expect(analysis.refusal).toBe("no-dynamic-range");
	});

	test("refuses when the only silence is shorter than a cuttable gap", () => {
		const analysis = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [
						{ seconds: 1.5, amplitude: 0.25, kind: "noise" },
						{ seconds: 0.15, amplitude: 0, kind: "tone" },
						{ seconds: 1.5, amplitude: 0.25, kind: "noise" },
					],
				}),
			}),
			options: options(),
		});
		expect(analysis.refusal).toBe("nothing-to-cut");
	});

	test("measures only the trimmed window it was handed", () => {
		const samples = synthesize({
			sections: [
				{ seconds: 2.0, amplitude: 0.25, kind: "noise" },
				{ seconds: 1.5, amplitude: 0, kind: "tone" },
				{ seconds: 2.0, amplitude: 0.25, kind: "noise" },
			],
		});
		const analysis = detectDeadSpace({
			features: features({ samples }),
			// Only the back half of the clip is visible.
			window: { startSec: 3.0, endSec: 5.5 },
			options: options(),
		});
		expect(analysis.refusal).toBeNull();
		expect(analysis.windowSec).toBeCloseTo(2.5, 6);
		for (const segment of analysis.segments) {
			expect(segment.startSec).toBeGreaterThanOrEqual(3.0);
			expect(segment.endSec).toBeLessThanOrEqual(5.5);
		}
		expect(analysis.segments[0].startSec).toBeCloseTo(3.5 - 0.08, 1);
	});

	test("adapts its threshold to a quiet recording", () => {
		// Everything 30 dB down from the previous cases: a fixed -40 dBFS gate
		// would find no sound at all here.
		const analysis = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [
						{ seconds: 1.0, amplitude: 0, kind: "tone" },
						{ seconds: 1.5, amplitude: 0.008, kind: "noise" },
						{ seconds: 1.5, amplitude: 0, kind: "tone" },
					],
					roomToneAmplitude: 0.00005,
				}),
			}),
			options: options(),
		});
		expect(analysis.refusal).toBeNull();
		expect(analysis.segments.length).toBe(1);
		expect(analysis.segments[0].startSec).toBeCloseTo(1.0 - 0.08, 1);
		expect(analysis.thresholdDb).toBeLessThan(-50);
	});

	test("keeps part of each gap in tighten mode", () => {
		const build = ({ keepGapSec }: { keepGapSec: number }) =>
			detectDeadSpace({
				features: features({
					samples: synthesize({
						sections: [
							{ seconds: 1.0, amplitude: 0.25, kind: "noise" },
							{ seconds: 2.0, amplitude: 0, kind: "tone" },
							{ seconds: 1.0, amplitude: 0.25, kind: "noise" },
						],
					}),
				}),
				options: options({ keepGapSec }),
			});
		const removed = build({ keepGapSec: 0 }).removedSec;
		const tightened = build({ keepGapSec: 0.5 }).removedSec;
		expect(removed - tightened).toBeCloseTo(0.5, 1);
	});
});
