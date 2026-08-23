export const MIN_FONT_SIZE = 5;
export const MAX_FONT_SIZE = 300;
export const DEFAULT_TEXT_COLOR = "#000000";

/**
 * higher value: smaller font size
 * lower value: larger font size
 */
export const FONT_SIZE_SCALE_REFERENCE = 90;

/**
 * The "thin black border" weight, in FONT-SIZE units (round 31): a value
 * of 2 draws a canvas `lineWidth` of 2/fontSize of the rendered glyph
 * size — i.e. ~2% of the font size per side, since canvas strokes
 * straddle the glyph outline and half falls outside.
 *
 * MEASURED, not guessed: CapCut Web's text stroke defaults to Size 40
 * (of 100) with a black color, which pixel-analysis of their canvas put
 * at ~13px of visible outline on a ~135px cap-height "Add heading" — a
 * heavy poster outline, roughly 10% of the font size per side. That is
 * their DEFAULT-when-enabled; the founder asked for a THIN border, so
 * this ships at a fifth of it (2 units ≈ 1% per side), which reads as a
 * crisp legibility edge rather than a sticker outline. The Border slider
 * in the Text panel covers the full range up to CapCut's own weight.
 */
export const DEFAULT_TEXT_BORDER_WIDTH = 2;
