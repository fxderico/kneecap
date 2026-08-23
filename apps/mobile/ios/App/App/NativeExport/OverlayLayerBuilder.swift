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

	/// Multi-line text billboard with FULL preview parity (round 34).
	///
	/// The old version drew `content` as ONE CoreText line at a raw point
	/// size: newline characters vanished from every export, and alignment /
	/// line height / letter spacing / background were ignored, so exported
	/// text never matched what the editor showed. This mirrors
	/// `text/primitives.ts` + `text/layout.ts` exactly:
	///   - lines = content.split("\n")
	///   - scaledFontSize = fontSize × renderHeight / 90
	///   - lineHeightPx = scaledFontSize × lineHeight (default 1.2)
	///   - line i sits at `i × lineHeightPx − (lineCount−1) × lineHeightPx / 2`
	///     from the element's center, drawn on the "middle" baseline
	///   - textAlign shifts each line by 0 / −width / −width⁄2 (left / right /
	///     center) relative to that center, the same asymmetry the preview has
	///   - background pad = (30, 42) × fontSize/15, corner radius from the param
	private static func buildTextBillboard(
		clip: EdlClip,
		renderSize: CGSize,
		ticksPerSecond: Int64,
		zIndex: Int
	) -> OverlayBillboard? {
		guard let content = clip.params["content"]?.asString, !content.isEmpty else { return nil }
		let authoredFontSize = CGFloat(clip.params["fontSize"]?.asDouble ?? 48)
		let fontSize = authoredFontSize * (renderSize.height / fontSizeScaleReference)
		let fontSizeRatio = authoredFontSize / 15
		let color = cgColor(fromHex: clip.params["color"]?.asString ?? "#FFFFFF")
		let bold = (clip.params["fontWeight"]?.asString ?? "normal") == "bold"
		let italic = (clip.params["fontStyle"]?.asString ?? "normal") == "italic"
		let font = resolveFont(
			family: clip.params["fontFamily"]?.asString ?? "Albert Sans",
			bold: bold,
			italic: italic,
			size: fontSize
		)

		// Border: a PERCENT of font size (round 33), same unit as captions.
		let strokePercent = CGFloat(clip.params["strokeWidth"]?.asDouble ?? 0)
		let strokeColor = cgColor(fromHex: clip.params["strokeColor"]?.asString ?? "#000000")

		let lineHeightPx = fontSize * CGFloat(clip.params["lineHeight"]?.asDouble ?? 1.2)
		// NOT height-scaled — the preview uses this param as raw canvas px too.
		let letterSpacing = CGFloat(clip.params["letterSpacing"]?.asDouble ?? 0)
		let align = clip.params["textAlign"]?.asString ?? "center"

		let lines = content.components(separatedBy: "\n")
		let lineWidths = lines.map { lineWidth($0, font: font, letterSpacing: letterSpacing) }
		let maxWidth = lineWidths.max() ?? 0
		guard maxWidth > 0 || lines.count > 1 else { return nil }
		let blockHeight = CGFloat(lines.count) * lineHeightPx

		/// x of a line's left edge, relative to the element's center — the
		/// preview's `getTextRect` offsets applied per line.
		func lineLeft(_ width: CGFloat) -> CGFloat {
			switch align {
			case "left": return 0
			case "right": return -width
			default: return -width / 2
			}
		}

		// Background rect (preview: getTextBackgroundRect), relative to center.
		let backgroundEnabled = clip.params["background.enabled"]?.asBool ?? false
		let backgroundColorHex = clip.params["background.color"]?.asString ?? "#000000"
		var backgroundRect: CGRect? = nil
		if backgroundEnabled, backgroundColorHex != "transparent" {
			let padX = CGFloat(clip.params["background.paddingX"]?.asDouble ?? 30) * fontSizeRatio
			let padY = CGFloat(clip.params["background.paddingY"]?.asDouble ?? 42) * fontSizeRatio
			let offX = CGFloat(clip.params["background.offsetX"]?.asDouble ?? 0)
			let offY = CGFloat(clip.params["background.offsetY"]?.asDouble ?? 0)
			let blockLeft = lineLeft(maxWidth)
			backgroundRect = CGRect(
				x: blockLeft - padX + offX,
				y: -blockHeight / 2 - padY + offY,
				width: maxWidth + padX * 2,
				height: blockHeight + padY * 2
			)
		}

		// Image bounds, symmetric about the element center so `displayRect`'s
		// centering lands the content exactly where the preview draws it.
		var minX: CGFloat = 0
		var maxX: CGFloat = 0
		for width in lineWidths {
			let left = lineLeft(width)
			minX = min(minX, left)
			maxX = max(maxX, left + width)
		}
		var minY = -blockHeight / 2
		var maxY = blockHeight / 2
		if let backgroundRect {
			minX = min(minX, backgroundRect.minX)
			maxX = max(maxX, backgroundRect.maxX)
			minY = min(minY, backgroundRect.minY)
			maxY = max(maxY, backgroundRect.maxY)
		}
		let contentWidth = 2 * max(abs(minX), abs(maxX))
		let contentHeight = 2 * max(abs(minY), abs(maxY))
		guard contentWidth > 0, contentHeight > 0 else { return nil }

		let padding = rasterPadding(scaledFontSize: fontSize)
		let imageWidth = contentWidth + padding * 2
		let imageHeight = contentHeight + padding * 2

		guard let image = rasterizeTextBlock(
			lines: lines,
			lineWidths: lineWidths,
			font: font,
			letterSpacing: letterSpacing,
			lineHeightPx: lineHeightPx,
			lineLeft: lineLeft,
			fill: color,
			strokeColor: strokePercent > 0 ? strokeColor : nil,
			strokePercent: strokePercent,
			background: backgroundRect.map {
				(rect: $0,
				 color: cgColor(fromHex: backgroundColorHex),
				 radiusPercent: CGFloat(clip.params["background.cornerRadius"]?.asDouble ?? 0))
			},
			imageSize: CGSize(width: imageWidth, height: imageHeight)
		) else { return nil }

		let rect = displayRect(
			contentWidth: imageWidth,
			contentHeight: imageHeight,
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

	/// Draws the measured text block into a bitmap whose CENTER is the
	/// element's center (see buildTextBillboard). CoreGraphics is bottom-up
	/// while the layout math is the canvas's top-down +Y, so every y is
	/// mirrored once, here.
	private static func rasterizeTextBlock(
		lines: [String],
		lineWidths: [CGFloat],
		font: CTFont,
		letterSpacing: CGFloat,
		lineHeightPx: CGFloat,
		lineLeft: (CGFloat) -> CGFloat,
		fill: CGColor,
		strokeColor: CGColor?,
		strokePercent: CGFloat,
		background: (rect: CGRect, color: CGColor, radiusPercent: CGFloat)?,
		imageSize: CGSize
	) -> CGImage? {
		let width = Int(ceil(imageSize.width))
		let height = Int(ceil(imageSize.height))
		guard width > 0, height > 0,
			  let ctx = CGContext(
				data: nil,
				width: width,
				height: height,
				bitsPerComponent: 8,
				bytesPerRow: 0,
				space: CGColorSpaceCreateDeviceRGB(),
				bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
			  ) else { return nil }

		let centerX = imageSize.width / 2
		let centerY = imageSize.height / 2

		if let background {
			// Canvas-space rect (top-down) → CG rect (bottom-up).
			let rect = CGRect(
				x: centerX + background.rect.minX,
				y: centerY - background.rect.maxY,
				width: background.rect.width,
				height: background.rect.height
			)
			let p = max(0, min(100, background.radiusPercent)) / 100
			let radius = (min(rect.width, rect.height) / 2) * p
			ctx.setFillColor(background.color)
			if radius > 0 {
				ctx.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil))
				ctx.fillPath()
			} else {
				ctx.fill(rect)
			}
		}

		var ascent: CGFloat = 0
		var descent: CGFloat = 0
		CTLineGetTypographicBounds(
			CTLineCreateWithAttributedString(
				NSAttributedString(
					string: "Ag",
					attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]
				)
			),
			&ascent, &descent, nil
		)
		let visualCenterOffset = (CGFloat(lines.count) - 1) * lineHeightPx / 2

		for (index, text) in lines.enumerated() {
			guard !text.isEmpty else { continue }
			// Canvas: lineY = i × lineHeight − visualCenterOffset, +Y down,
			// baseline "middle" → mirror into CG's +Y up.
			let lineY = CGFloat(index) * lineHeightPx - visualCenterOffset
			let baselineY = centerY - lineY - (ascent - descent) / 2
			drawStyledLine(
				text,
				at: CGPoint(x: centerX + lineLeft(lineWidths[index]), y: baselineY),
				font: font,
				letterSpacing: letterSpacing,
				fill: fill,
				strokeColor: strokeColor,
				strokePercent: strokePercent,
				in: ctx
			)
		}

		return ctx.makeImage()
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

	private static func resolveFont(family: String, bold: Bool, italic: Bool = false, size: CGFloat) -> CTFont {
		if family == "Albert Sans" {
			// Bundled with the app (UIAppFonts, round 31) under its
			// PostScript names — resolve those directly rather than trusting
			// family-name lookup on a just-registered font. Only Regular and
			// Bold ship; italic is synthesized by the trait pass below.
			let base = CTFontCreateWithName((bold ? "AlbertSans-Bold" : "AlbertSans-Regular") as CFString, size, nil)
			if italic, let slanted = CTFontCreateCopyWithSymbolicTraits(base, size, nil, .traitItalic, .traitItalic) {
				return slanted
			}
			return base
		}
		if family == "Arial" || family == "Inter" {
			// Arial ships on both platforms under its PostScript names;
			// Inter is the app's UI font but is not installed system-wide,
			// so it renders as Arial here (closest bundled metric match).
			return CTFontCreateWithName((bold ? "Arial-BoldMT" : "ArialMT") as CFString, size, nil)
		}
		let base = CTFontCreateWithName(family as CFString, size, nil)
		var traits: CTFontSymbolicTraits = []
		if bold { traits.insert(.traitBold) }
		if italic { traits.insert(.traitItalic) }
		if !traits.isEmpty,
		   let styled = CTFontCreateCopyWithSymbolicTraits(base, size, nil, traits, traits) {
			return styled
		}
		return base
	}

	private static func lineWidth(_ text: String, font: CTFont, letterSpacing: CGFloat = 0) -> CGFloat {
		var attributes: [NSAttributedString.Key: Any] = [
			NSAttributedString.Key(kCTFontAttributeName as String): font
		]
		if letterSpacing != 0 {
			attributes[NSAttributedString.Key(kCTKernAttributeName as String)] = letterSpacing
		}
		let line = CTLineCreateWithAttributedString(
			NSAttributedString(string: text, attributes: attributes)
		)
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


	/// Draws one line the way the CANVAS does (round 35): stroke pass FIRST,
	/// then the fill on top.
	///
	/// The preview calls `strokeText` then `fillText`, so the border's inner
	/// half is covered by the fill and the glyph keeps its full weight, with
	/// the border showing only OUTSIDE the outline. The export instead used a
	/// single pass with a NEGATIVE `kCTStrokeWidth` ("stroke and fill"), which
	/// paints the stroke OVER the fill — the border ate ~half its width into
	/// every glyph. Measured on a real export: a 16.2px bold stem rendered
	/// 14px of white with 2px of black biting in from each side, i.e. exactly
	/// the "font looks thinner in export" the founder reported, and it made
	/// borders read heavier than the preview at the same setting.
	///
	/// A POSITIVE `kCTStrokeWidth` is stroke-only (no fill), which is the
	/// direct CoreText equivalent of `strokeText`.
	private static func drawStyledLine(
		_ text: String,
		at position: CGPoint,
		font: CTFont,
		letterSpacing: CGFloat,
		fill: CGColor,
		strokeColor: CGColor?,
		strokePercent: CGFloat,
		in ctx: CGContext
	) {
		guard !text.isEmpty else { return }
		var base: [NSAttributedString.Key: Any] = [
			NSAttributedString.Key(kCTFontAttributeName as String): font
		]
		if letterSpacing != 0 {
			base[NSAttributedString.Key(kCTKernAttributeName as String)] = letterSpacing
		}

		if let strokeColor, strokePercent > 0 {
			var strokeAttributes = base
			strokeAttributes[NSAttributedString.Key(kCTStrokeColorAttributeName as String)] = strokeColor
			strokeAttributes[NSAttributedString.Key(kCTForegroundColorAttributeName as String)] = strokeColor
			// POSITIVE = stroke only, the `strokeText` equivalent.
			strokeAttributes[NSAttributedString.Key(kCTStrokeWidthAttributeName as String)] = Double(strokePercent)
			ctx.textPosition = position
			CTLineDraw(
				CTLineCreateWithAttributedString(
					NSAttributedString(string: text, attributes: strokeAttributes)
				),
				ctx
			)
		}

		var fillAttributes = base
		fillAttributes[NSAttributedString.Key(kCTForegroundColorAttributeName as String)] = fill
		ctx.textPosition = position
		CTLineDraw(
			CTLineCreateWithAttributedString(
				NSAttributedString(string: text, attributes: fillAttributes)
			),
			ctx
		)
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
			// Stroke pass then fill, exactly like the preview's
			// strokeText → fillText order (see drawStyledLine).
			drawStyledLine(
				word.text,
				at: CGPoint(x: startX + word.x, y: baselineY),
				font: font,
				letterSpacing: 0,
				fill: word.fill,
				strokeColor: strokeColor,
				strokePercent: strokePercent,
				in: ctx
			)
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
