/**
 * Round 21.4 (founder: captions "should be editable like a text field") —
 * rewrite a caption element's words from a plain edited string.
 *
 * When the word COUNT is unchanged, every word keeps its exact timing and
 * only the text swaps (typo fixes stay perfectly synced). When the count
 * changes, the new words are distributed evenly across the caption's
 * original spoken span — approximate, but the span itself stays honest.
 *
 * Pure and dependency-free (type-only imports) so it unit-tests without
 * the wasm runtime — same constraint as caption-window.ts.
 */
import type { MediaTime } from "@kneecap/editor-core";
import type { CaptionWord } from "@kneecap/editor-core/timeline";

export function rewriteCaptionWords({
	words,
	newText,
}: {
	words: readonly CaptionWord[];
	newText: string;
}): CaptionWord[] {
	const tokens = newText.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return [];
	if (words.length === 0) return [];

	if (tokens.length === words.length) {
		return words.map((word, i) => ({ ...word, text: tokens[i] }));
	}

	const start = words[0].startTime;
	const end = words[words.length - 1].endTime;
	const span = Math.max(1, end - start);
	const per = span / tokens.length;
	return tokens.map((text, i) => ({
		text,
		startTime: Math.round(start + i * per) as MediaTime,
		endTime: Math.round(start + (i + 1) * per) as MediaTime,
	}));
}

/** The caption's words as one editable string. */
export function captionText(words: readonly CaptionWord[]): string {
	return words.map((w) => w.text).join(" ");
}
