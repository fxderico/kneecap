/**
 * Round 22 — publikclip's caption chunking ("ViralMint rule"), ported from
 * ~/publikclip pipeline/captions/ass.py `chunk_words`. Founder: "there
 * should be text lining up with timing of speech with only a few words on
 * a screen at a time — look into how publikclip does that."
 *
 * A chunk breaks when ANY of:
 *   - it reaches CHUNK_MAX_WORDS (4),
 *   - the word ends in sentence punctuation [.!?,;:],
 *   - the pause to the next word exceeds 0.6s.
 *
 * Each chunk becomes its OWN caption element spanning exactly its words'
 * spoken time — so a few words appear at a time, in sync with speech,
 * instead of one long sliding caption per transcript segment.
 *
 * Pure and dependency-free (plain micros numbers) so it unit-tests
 * without the wasm runtime.
 */

export const CHUNK_MAX_WORDS = 4;
export const CHUNK_PAUSE_BREAK_MICROS = 600_000;
const PUNCT_BREAK = /[.!?,;:]$/;

export interface ChunkableWord {
	text: string;
	startMicros: number;
	endMicros: number;
}

export interface ChunkableSegment {
	startMicros: number;
	endMicros: number;
	text: string;
	words: ChunkableWord[];
}

export function chunkTranscriptSegments(
	segments: readonly ChunkableSegment[],
): ChunkableSegment[] {
	const out: ChunkableSegment[] = [];
	for (const segment of segments) {
		let current: ChunkableWord[] = [];
		const flush = () => {
			if (current.length === 0) return;
			out.push({
				startMicros: current[0].startMicros,
				endMicros: current[current.length - 1].endMicros,
				text: current.map((w) => w.text).join(" "),
				words: current,
			});
			current = [];
		};
		for (let i = 0; i < segment.words.length; i++) {
			const word = segment.words[i];
			current.push(word);
			const next = segment.words[i + 1];
			const shouldBreak =
				current.length >= CHUNK_MAX_WORDS ||
				PUNCT_BREAK.test(word.text) ||
				(next !== undefined && next.startMicros - word.endMicros > CHUNK_PAUSE_BREAK_MICROS);
			if (shouldBreak) flush();
		}
		flush();
	}
	return out;
}
