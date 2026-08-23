import AVFoundation
import CoreGraphics
import CoreImage
import CoreText
import Foundation

/// kneecap round 23 — text/sticker/caption overlays as pre-rasterized
/// BILLBOARDS composited by `EdlTransitionCompositor`, replacing the old
/// `AVVideoCompositionCoreAnimationTool` CALayer path entirely.
///
/// WHY THE REWRITE: AVFoundation IGNORES `animationTool` whenever
/// `customVideoCompositorClass` is set — and this pipeline always sets it
/// (transitions/adjust/PiP run in the custom compositor). The CALayer
/// overlays therefore never rendered in ANY export. The original
/// golden-frame check (cyan-fraction over the whole frame) passed against
/// the colorful fixture VIDEO, not the text — a false positive. Proven by
/// probe: an 80pt white text overlay positioned over the pure-black
/// letterbox band exported to nothing; so did a solid-white CALayer.
///
/// The fix rides the mechanism that demonstrably works (PiP overlays,
/// step 10): rasterize each overlay once at build time with CoreText, hand
/// the compositor `OverlayBillboard`s (image states + display rect +
/// window), and let it composite per frame. Karaoke captions carry one
/// image per active-word state; the compositor's sticky-state rule picks
/// the right one from the frame time.
///
/// V1 scope, disclosed: single-line text (the old CATextLayer `isWrapped`
/// box never rendered at all, so nothing regressed); billboard-level
/// animation channels (e.g. the text opacity fade of the harness fixture)
/// are not implemented — constant `clip.opacity` gates the whole window.
public enum OverlayLayerBuilder {
	/// `FONT_SIZE_SCALE_REFERENCE` in `text/typography.ts` — captions scale
	/// their font size by `renderHeight / 90`, same as the preview.
	static let fontSizeScaleReference: CGFloat = 90

	public static func buildBillboards(
		edl: EdlDocument,
		renderSize: CGSize
	) -> [OverlayBillboard] {
		let tps = edl.meta.ticksPerSecond
		var billboards: [OverlayBillboard] = []
		for track in edl.tracks where track.kind == "overlay" {
			for clip in track.clips where !clip.hidden {
				let zIndex = track.zIndex ?? 0
				switch clip.kind {
				case "text", "sticker", "graphic":
					if let billboard = buildTextBillboard(clip: clip, renderSize: renderSize, ticksPerSecond: tps, zIndex: zIndex) {
						billboards.append(billboard)
					}
				case "caption":
					if let billboard = buildCaptionBillboard(clip: clip, renderSize: renderSize, ticksPerSecond: tps, zIndex: zIndex) {
						billboards.append(billboard)
					}
				default:
					break
				}
			}
		}
		billboards.sort { $0.zIndex < $1.zIndex }
		return billboards
	}

	// MARK: - Text / sticker / graphic

	private static func buildTextBillboard(
		clip: EdlClip,
		renderSize: CGSize,
		ticksPerSecond: Int64,
		zIndex: Int
	) -> OverlayBillboard? {
		guard let content = clip.params["content"]?.asString, !content.isEmpty else { return nil }
		// HEIGHT-SCALED, exactly like the preview and like captions (round 33):
		// `text/primitives.ts` renders text at `fontSize × canvasHeight / 90`,
		// so drawing the raw param here made every exported text overlay ~21×
		// too small at 1080×1920 — the founder's title shrank to a speck while
		// the preview showed it full size. The old "text is authored against
		// the canvas" comment was simply wrong.
		let authoredFontSize = CGFloat(clip.params["fontSize"]?.asDouble ?? 48)
		let fontSize = authoredFontSize * (renderSize.height / fontSizeScaleReference)
		let color = cgColor(fromHex: clip.params["color"]?.asString ?? "#FFFFFF")
		let bold = (clip.params["fontWeight"]?.asString ?? "normal") == "bold"
		let font = resolveFont(family: clip.params["fontFamily"]?.asString ?? "Albert Sans", bold: bold, size: fontSize)

		// Text border: a PERCENT of font size (round 33), same as captions.
		let textStrokeWidth = CGFloat(clip.params["strokeWidth"]?.asDouble ?? 0)
		let textStrokeColor = cgColor(fromHex: clip.params["strokeColor"]?.asString ?? "#000000")

		let width = lineWidth(content, font: font)
		let height = fontSize * 1.3
		guard let image = rasterizeLine(
			words: [RasterWord(text: content, x: 0, width: width, fill: color)],
			font: font,
			scaledFontSize: fontSize,
			totalWidth: width,
			totalHeight: height,
			strokeColor: textStrokeWidth > 0 ? textStrokeColor : nil,
			strokePercent: textStrokeWidth,
			background: nil,
			activePill: nil
		) else { return nil }

		let padding = rasterPadding(scaledFontSize: fontSize)
		let rect = displayRect(
			contentWidth: width + padding * 2,
			contentHeight: height + padding * 2,
			transform: clip.transform,
			renderSize: renderSize,
			positionFractionY: 0
		)
		return OverlayBillboard(
			states: [OverlayBillboardState(startSeconds: 0, image: CIImage(cgImage: image))],
			rect: rect,
			opacity: clip.opacity,
			timeRange: EdlTime.cmTimeRange(startTicks: clip.startTicks, durationTicks: clip.durationTicks, ticksPerSecond: ticksPerSecond),
			zIndex: zIndex
		)
	}

	// MARK: - Captions

	private struct CaptionStyle {
		var fontFamily: String
		var fontSize: CGFloat
		var bold: Bool
		var color: CGColor
		var highlightColor: CGColor
		var strokeColor: CGColor
		var strokeWidth: CGFloat
		var backgroundEnabled: Bool
		var backgroundColor: CGColor
		var activeWordBackgroundEnabled: Bool
		var activeWordBackgroundColor: CGColor
		var positionFractionY: CGFloat
		var uppercase: Bool
		var highlightActive: Bool
	}

	private static func buildCaptionBillboard(
		clip: EdlClip,
		renderSize: CGSize,
		ticksPerSecond: Int64,
		zIndex: Int
	) -> OverlayBillboard? {
		let allWords = clip.captionWords ?? []
		// Mirrors `getVisibleCaptionWords`: intersect the trimmed source window.
		let visible = allWords.filter {
			$0.endTicks > clip.sourceStartTicks && $0.startTicks < clip.sourceEndTicks
		}
		guard !visible.isEmpty else { return nil }

		let style = readCaptionStyle(clip: clip)
		let scaledFontSize = style.fontSize * (renderSize.height / fontSizeScaleReference)
		guard scaledFontSize > 1 else { return nil }
		let font = resolveFont(family: style.fontFamily, bold: style.bold, size: scaledFontSize)

		// One-line layout, single-space joined — `measureCaptionLine`.
		let spaceWidth = lineWidth(" ", font: font)
		struct Laid { var text: String; var x: CGFloat; var width: CGFloat; var startTicks: Int64 }
		var laidOut: [Laid] = []
		var cursor: CGFloat = 0
		for word in visible {
			let display = style.uppercase ? word.text.uppercased() : word.text
			let width = lineWidth(display, font: font)
			laidOut.append(Laid(text: display, x: cursor, width: width, startTicks: word.startTicks))
			cursor += width + spaceWidth
		}
		let totalWidth = max(0, cursor - spaceWidth)
		let totalHeight = scaledFontSize * 1.3

		let clipStart = EdlTime.cmTime(ticks: clip.startTicks, ticksPerSecond: ticksPerSecond).seconds
		func rasterize(activeIndex: Int?) -> CGImage? {
			let activePill: RasterPill? = {
				guard style.activeWordBackgroundEnabled, let activeIndex, laidOut.indices.contains(activeIndex) else { return nil }
				let active = laidOut[activeIndex]
				return RasterPill(
					centerX: active.x + active.width / 2,
					width: active.width + scaledFontSize * 0.44,
					height: totalHeight * 0.75 + scaledFontSize * 0.24,
					color: style.activeWordBackgroundColor
				)
			}()
			return rasterizeLine(
				words: laidOut.enumerated().map { index, word in
					RasterWord(
						text: word.text,
						x: word.x,
						width: word.width,
						fill: index == activeIndex ? style.highlightColor : style.color
					)
				},
				font: font,
				scaledFontSize: scaledFontSize,
				totalWidth: totalWidth,
				totalHeight: totalHeight,
				// strokeWidth is a PERCENT of font size (round 33) — same unit
				// kCTStrokeWidth wants, and the same the preview divides by 100.
				strokeColor: style.strokeWidth > 0 ? style.strokeColor : nil,
				strokePercent: style.strokeWidth,
				background: style.backgroundEnabled
					? RasterPill(centerX: totalWidth / 2, width: totalWidth + scaledFontSize * 0.8, height: totalHeight + scaledFontSize * 0.5, color: style.backgroundColor)
					: nil,
				activePill: activePill
			)
		}

		// States: nil-active before the first word, then sticky per-word.
		var states: [OverlayBillboardState] = []
		guard let baseImage = rasterize(activeIndex: nil) else { return nil }
		states.append(OverlayBillboardState(startSeconds: 0, image: CIImage(cgImage: baseImage)))
		if style.highlightActive {
			for (index, word) in laidOut.enumerated() {
				guard let image = rasterize(activeIndex: index) else { return nil }
				// Word ticks are source-space; captions are speed-1, so the
				// output start is clipStart + (start - sourceStart).
				let start = clipStart + EdlTime.cmTime(
					ticks: max(0, word.startTicks - clip.sourceStartTicks),
					ticksPerSecond: ticksPerSecond
				).seconds
				states.append(OverlayBillboardState(startSeconds: start, image: CIImage(cgImage: image)))
			}
		}

		let padding = rasterPadding(scaledFontSize: scaledFontSize)
		let rect = displayRect(
			contentWidth: totalWidth + padding * 2,
			contentHeight: totalHeight + padding * 2,
			transform: clip.transform,
			renderSize: renderSize,
			positionFractionY: style.positionFractionY
		)
		return OverlayBillboard(
			states: states,
			rect: rect,
			opacity: clip.opacity,
			timeRange: EdlTime.cmTimeRange(startTicks: clip.startTicks, durationTicks: clip.durationTicks, ticksPerSecond: ticksPerSecond),
			zIndex: zIndex
		)
	}

	private static func readCaptionStyle(clip: EdlClip) -> CaptionStyle {
		let p = clip.params
		let position = p["position"]?.asString ?? "bottom"
		// `CAPTION_POSITION_Y_FRACTION` in `captions/layout.ts`.
		let fraction: CGFloat = position == "top" ? -0.36 : position == "center" ? 0 : 0.36
		let animationStyle = p["animationStyle"]?.asString ?? "karaoke"
		return CaptionStyle(
			fontFamily: p["fontFamily"]?.asString ?? "Albert Sans",
			fontSize: CGFloat(p["fontSize"]?.asDouble ?? 22),
			bold: (p["fontWeight"]?.asString ?? "bold") == "bold",
			color: cgColor(fromHex: p["color"]?.asString ?? "#ffffff"),
			highlightColor: cgColor(fromHex: p["highlightColor"]?.asString ?? "#FFDE59"),
			strokeColor: cgColor(fromHex: p["strokeColor"]?.asString ?? "#000000"),
			strokeWidth: CGFloat(p["strokeWidth"]?.asDouble ?? 6),
			backgroundEnabled: p["background.enabled"]?.asBool ?? false,
			backgroundColor: cgColor(fromHex: p["background.color"]?.asString ?? "#000000"),
			activeWordBackgroundEnabled: p["activeWordBackground.enabled"]?.asBool ?? false,
			activeWordBackgroundColor: cgColor(fromHex: p["activeWordBackground.color"]?.asString ?? "#FFDE59"),
			positionFractionY: fraction,
			uppercase: p["uppercase"]?.asBool ?? false,
			highlightActive: animationStyle != "none"
		)
	}

	// MARK: - Shared rasterization (CoreText, platform-free)

	private struct RasterWord {
		var text: String
		var x: CGFloat
		var width: CGFloat
		var fill: CGColor
	}

	private struct RasterPill {
		/// Center X in LINE coordinates (0 = line's left edge).
		var centerX: CGFloat
		var width: CGFloat
		var height: CGFloat
		var color: CGColor
	}

	private static func resolveFont(family: String, bold: Bool, size: CGFloat) -> CTFont {
		if family == "Albert Sans" {
			// Bundled with the app (UIAppFonts, round 31) under its
			// PostScript names — resolve those directly rather than trusting
			// family-name lookup on a just-registered font.
			return CTFontCreateWithName((bold ? "AlbertSans-Bold" : "AlbertSans-Regular") as CFString, size, nil)
		}
		if family == "Arial" || family == "Inter" {
			// Arial ships on both platforms under its PostScript names;
			// Inter is the app's UI font but is not installed system-wide,
			// so it renders as Arial here (closest bundled metric match).
			return CTFontCreateWithName((bold ? "Arial-BoldMT" : "ArialMT") as CFString, size, nil)
		}
		let base = CTFontCreateWithName(family as CFString, size, nil)
		if bold, let boldFont = CTFontCreateCopyWithSymbolicTraits(base, size, nil, .traitBold, .traitBold) {
			return boldFont
		}
		return base
	}

	private static func lineWidth(_ text: String, font: CTFont) -> CGFloat {
		let attributed = NSAttributedString(
			string: text,
			attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]
		)
		let line = CTLineCreateWithAttributedString(attributed)
		return CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
	}

	/// Bleed room for stroke + pill padding around the measured line.
	private static func rasterPadding(scaledFontSize: CGFloat) -> CGFloat {
		scaledFontSize * 0.6
	}

	/// Final display rect in OUTPUT pixels, top-left/+Y-down convention:
	/// canvas order translate(center + position + preset baseline) then
	/// scale about the element's own center.
	private static func displayRect(
		contentWidth: CGFloat,
		contentHeight: CGFloat,
		transform: EdlTransform,
		renderSize: CGSize,
		positionFractionY: CGFloat
	) -> CGRect {
		let centerX = renderSize.width / 2 + CGFloat(transform.positionX)
		let centerY = renderSize.height / 2 + CGFloat(transform.positionY) + positionFractionY * renderSize.height
		let width = contentWidth * abs(CGFloat(transform.scaleX))
		let height = contentHeight * abs(CGFloat(transform.scaleY))
		return CGRect(x: centerX - width / 2, y: centerY - height / 2, width: width, height: height)
	}

	private static func rasterizeLine(
		words: [RasterWord],
		font: CTFont,
		scaledFontSize: CGFloat,
		totalWidth: CGFloat,
		totalHeight: CGFloat,
		strokeColor: CGColor?,
		strokePercent: CGFloat,
		background: RasterPill?,
		activePill: RasterPill?
	) -> CGImage? {
		let padding = rasterPadding(scaledFontSize: scaledFontSize)
		let width = Int(ceil(totalWidth + padding * 2))
		let height = Int(ceil(totalHeight + padding * 2))
		guard width > 0, height > 0,
			let ctx = CGContext(
				data: nil,
				width: width,
				height: height,
				bitsPerComponent: 8,
				bytesPerRow: 0,
				space: CGColorSpaceCreateDeviceRGB(),
				bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
			)
		else { return nil }

		let centerY = CGFloat(height) / 2
		let startX = padding

		if let background {
			fillPill(ctx: ctx, pill: background, offsetX: startX, centerY: centerY)
		}
		if let activePill {
			fillPill(ctx: ctx, pill: activePill, offsetX: startX, centerY: centerY)
		}

		var ascent: CGFloat = 0
		var descent: CGFloat = 0
		_ = CTLineGetTypographicBounds(
			CTLineCreateWithAttributedString(
				NSAttributedString(
					string: "Ag",
					attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]
				)
			),
			&ascent, &descent, nil
		)
		// Match canvas `textBaseline = "middle"`: the glyph box (ascent up,
		// descent down) centered on the bitmap midline. CoreText draws
		// upright into the bottom-up CG context; the CGImage reads top-down
		// correctly.
		let baselineY = centerY - (ascent - descent) / 2

		for word in words {
			var attributes: [NSAttributedString.Key: Any] = [
				NSAttributedString.Key(kCTFontAttributeName as String): font,
				NSAttributedString.Key(kCTForegroundColorAttributeName as String): word.fill,
			]
			if let strokeColor, strokePercent > 0 {
				// Negative kCTStrokeWidth = stroke AND fill; magnitude is a
				// PERCENTAGE of the font size — which is exactly the unit the
				// `strokeWidth` param carries (round 33), so it passes straight
				// through. The preview's canvas `lineWidth` is derived from the
				// same percentage, so the two agree by construction.
				attributes[NSAttributedString.Key(kCTStrokeColorAttributeName as String)] = strokeColor
				attributes[NSAttributedString.Key(kCTStrokeWidthAttributeName as String)] = -Double(strokePercent)
			}
			let line = CTLineCreateWithAttributedString(
				NSAttributedString(string: word.text, attributes: attributes)
			)
			ctx.textPosition = CGPoint(x: startX + word.x, y: baselineY)
			CTLineDraw(line, ctx)
		}

		return ctx.makeImage()
	}

	private static func fillPill(ctx: CGContext, pill: RasterPill, offsetX: CGFloat, centerY: CGFloat) {
		let rect = CGRect(
			x: offsetX + pill.centerX - pill.width / 2,
			y: centerY - pill.height / 2,
			width: pill.width,
			height: pill.height
		)
		let radius = min(pill.width, pill.height) * 0.2
		let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
		ctx.setFillColor(pill.color)
		ctx.addPath(path)
		ctx.fillPath()
	}

	/// `"#RRGGBB"` or `"#RRGGBBAA"` hex parsing. Falls back to opaque white
	/// on a malformed string rather than throwing — a broken color for one
	/// overlay should degrade visibly, not abort the whole export.
	static func cgColor(fromHex hex: String) -> CGColor {
		var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
		if s.hasPrefix("#") { s.removeFirst() }
		guard s.count == 6 || s.count == 8, let value = UInt64(s, radix: 16) else {
			return CGColor(red: 1, green: 1, blue: 1, alpha: 1)
		}
		let hasAlpha = s.count == 8
		let r = Double((value >> (hasAlpha ? 24 : 16)) & 0xff) / 255.0
		let g = Double((value >> (hasAlpha ? 16 : 8)) & 0xff) / 255.0
		let b = Double((value >> (hasAlpha ? 8 : 0)) & 0xff) / 255.0
		let a = hasAlpha ? Double(value & 0xff) / 255.0 : 1.0
		return CGColor(red: r, green: g, blue: b, alpha: a)
	}
}
