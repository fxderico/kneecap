import { describe, expect, it } from "bun:test";
import { chunkTranscriptSegments } from "./chunk";

const w = (text: string, s: number, e: number) => ({ text, startMicros: s, endMicros: e });
const seg = (words: ReturnType<typeof w>[]) => ({
	startMicros: words[0].startMicros,
	endMicros: words[words.length - 1].endMicros,
	text: words.map((x) => x.text).join(" "),
	words,
});

describe("chunkTranscriptSegments (publikclip ViralMint rule)", () => {
	it("breaks at 4 words max", () => {
		const words = Array.from({ length: 9 }, (_, i) => w(`w${i}`, i * 100, i * 100 + 80));
		const chunks = chunkTranscriptSegments([seg(words)]);
		expect(chunks.map((c) => c.words.length)).toEqual([4, 4, 1]);
		expect(chunks[0].startMicros).toBe(0);
		expect(chunks[0].endMicros).toBe(380);
		expect(chunks[1].startMicros).toBe(400);
	});

	it("breaks at sentence punctuation", () => {
		const chunks = chunkTranscriptSegments([
			seg([w("hello,", 0, 100), w("world", 200, 300), w("again.", 400, 500), w("bye", 600, 700)]),
		]);
		expect(chunks.map((c) => c.text)).toEqual(["hello,", "world again.", "bye"]);
	});

	it("breaks on a pause longer than 0.6s", () => {
		const chunks = chunkTranscriptSegments([
			seg([w("one", 0, 100), w("two", 200, 300), w("three", 1_000_000, 1_000_100)]),
		]);
		expect(chunks.map((c) => c.text)).toEqual(["one two", "three"]);
		expect(chunks[1].startMicros).toBe(1_000_000);
	});

	it("a short segment passes through as one chunk", () => {
		const chunks = chunkTranscriptSegments([seg([w("hi", 0, 100), w("there", 150, 250)])]);
		expect(chunks.length).toBe(1);
		expect(chunks[0].text).toBe("hi there");
	});
});
