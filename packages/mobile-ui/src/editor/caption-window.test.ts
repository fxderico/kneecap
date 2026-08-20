import { describe, expect, it } from "bun:test";
import type { TranscriptSegment } from "@kneecap/native-bridge";
import { windowSegmentsToClip } from "./caption-window";

const word = (text: string, startMicros: number, endMicros: number) => ({
	text,
	startMicros,
	endMicros,
	confidence: null,
});

const segment = (words: ReturnType<typeof word>[]): TranscriptSegment => ({
	startMicros: words[0].startMicros,
	endMicros: words[words.length - 1].endMicros,
	text: words.map((w) => w.text).join(" "),
	confidence: null,
	words,
});

describe("windowSegmentsToClip (trim-aware caption alignment)", () => {
	const source = [segment([
		word("before", 0, 900_000),
		word("hello", 1_000_000, 1_400_000),
		word("world", 1_500_000, 2_000_000),
		word("after", 3_500_000, 4_000_000),
	])];

	it("keeps only words inside the trim window and shifts them clip-relative", () => {
		const out = windowSegmentsToClip({
			segments: source,
			trimStartMicros: 1_000_000,
			durationMicros: 2_000_000, // window [1.0s, 3.0s)
		});
		expect(out.length).toBe(1);
		expect(out[0].words.map((w) => w.text)).toEqual(["hello", "world"]);
		expect(out[0].words[0].startMicros).toBe(0);
		expect(out[0].words[1].endMicros).toBe(1_000_000);
		expect(out[0].startMicros).toBe(0);
		expect(out[0].endMicros).toBe(1_000_000);
	});

	it("keeps a word straddling the window edge, clamped at zero", () => {
		const out = windowSegmentsToClip({
			segments: source,
			trimStartMicros: 1_200_000,
			durationMicros: 1_000_000,
		});
		// "hello" (1.0-1.4s) straddles the 1.2s edge — kept, start clamped to 0
		expect(out[0].words[0].text).toBe("hello");
		expect(out[0].words[0].startMicros).toBe(0);
	});

	it("drops a segment whose words all fall outside the window", () => {
		const out = windowSegmentsToClip({
			segments: source,
			trimStartMicros: 5_000_000,
			durationMicros: 1_000_000,
		});
		expect(out.length).toBe(0);
	});

	it("untrimmed clip passes words through unchanged", () => {
		const out = windowSegmentsToClip({
			segments: source,
			trimStartMicros: 0,
			durationMicros: 10_000_000,
		});
		expect(out[0].words.length).toBe(4);
		expect(out[0].words[1].startMicros).toBe(1_000_000);
	});
});
