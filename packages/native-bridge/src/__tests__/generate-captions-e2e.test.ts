/**
 * The real cross-package "generate" step, end to end: the web-fallback
 * bridge's actual `transcribe()` call (not a hand-copied duplicate of its
 * fixture data) feeding directly into `@kneecap/editor-core`'s actual
 * `buildCaptionElementsFromTranscript()`. This is the exact call sequence a
 * UI host makes — `await getNativeBridge()` then `.transcribe()`, then hand
 * the yielded segments to editor-core — with only the `EditorCore`/`Command`
 * layer omitted (see `caption-pipeline-integration.test.ts` in editor-core
 * for why: importing `@kneecap/editor-core/commands` or `/core` pulls in the
 * WASM compositor, which the repo's test-support stub does not cover).
 */
import { describe, expect, test } from "bun:test";
import { createWebFallbackBridge } from "../web-fallback";
import { DEV_FIXTURE_MEDIA_HANDLE } from "../dev-fixtures/sample-transcript";
import { buildCaptionElementsFromTranscript } from "@kneecap/editor-core/captions";
import { ZERO_MEDIA_TIME } from "@kneecap/editor-core/wasm";

describe("NativeBridge.transcribe() -> buildCaptionElementsFromTranscript()", () => {
	test("the web-fallback bridge's fixture transcript builds real, well-formed caption elements", async () => {
		const bridge = createWebFallbackBridge();

		const segments = [];
		for await (const segment of bridge.transcribe({
			handle: DEV_FIXTURE_MEDIA_HANDLE,
			opts: { modelSize: "tiny" },
		})) {
			segments.push(segment);
		}
		expect(segments.length).toBeGreaterThan(0);

		const elements = buildCaptionElementsFromTranscript({
			segments,
			timelineStartTime: ZERO_MEDIA_TIME,
		});

		// One element per caption PAGE, not per segment: generation chunks a
		// segment into short pages (publikclip parity) so a long sentence does
		// not sit on screen as one wall of text. So pages >= segments, and the
		// words are conserved across the split.
		expect(elements.length).toBeGreaterThanOrEqual(segments.length);
		expect(elements.every((el) => el.type === "caption")).toBe(true);
		expect(elements.every((el) => el.words.length > 0)).toBe(true);

		// First and last word of the whole transcript match the fixture's own
		// text — proves the microseconds -> ticks conversion ran on the REAL
		// transcribe() output, not a copy of it.
		const allWords = elements.flatMap((el) => el.words);
		expect(allWords[0].text).toBe("kneecap");
		expect(allWords.map((word) => word.text)).toContain("editor");

		// Every word's span is inside its own element's [0, duration] — the
		// same invariant `getVisibleCaptionWords`/`getActiveCaptionWordIndex`
		// (editor-core) rely on for an UNSPLIT, freshly generated element.
		for (const element of elements) {
			for (const word of element.words) {
				expect(word.startTime).toBeGreaterThanOrEqual(0);
				expect(word.endTime).toBeLessThanOrEqual(element.duration);
				expect(word.endTime).toBeGreaterThan(word.startTime);
			}
		}
	});
});
