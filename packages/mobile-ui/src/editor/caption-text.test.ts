import { describe, expect, it } from "bun:test";
import type { CaptionWord } from "@kneecap/editor-core/timeline";
import { captionText, rewriteCaptionWords } from "./caption-text";

const t = (n: number) => n as CaptionWord["startTime"];
const words: CaptionWord[] = [
	{ text: "hello", startTime: t(1000), endTime: t(2000) },
	{ text: "wrold", startTime: t(2000), endTime: t(3500) },
	{ text: "again", startTime: t(3500), endTime: t(5000) },
];

describe("rewriteCaptionWords (text-field caption editing)", () => {
	it("same word count keeps exact per-word timing (typo fix stays synced)", () => {
		const out = rewriteCaptionWords({ words, newText: "hello world again" });
		expect(out.map((w) => w.text)).toEqual(["hello", "world", "again"]);
		expect(out[1].startTime).toBe(t(2000));
		expect(out[1].endTime).toBe(t(3500));
	});

	it("different word count redistributes evenly across the original span", () => {
		const out = rewriteCaptionWords({ words, newText: "hi there" });
		expect(out.length).toBe(2);
		expect(out[0].startTime).toBe(t(1000));
		expect(out[1].endTime).toBe(t(5000));
		expect(out[0].endTime).toBe(out[1].startTime);
	});

	it("empty text clears the words", () => {
		expect(rewriteCaptionWords({ words, newText: "   " })).toEqual([]);
	});

	it("captionText round-trips", () => {
		expect(captionText(words)).toBe("hello wrold again");
	});
});
