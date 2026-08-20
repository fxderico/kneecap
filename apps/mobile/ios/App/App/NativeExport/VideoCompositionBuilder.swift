import AVFoundation
import CoreGraphics
import CoreImage

/// kneecap M9 — assembles the `AVMutableVideoComposition` from a
/// `BuiltComposition` (plan M9 items 1-3): renders every main-track segment
/// through `EdlTransitionCompositor` (transitions + the one wired v1
/// effect), then layers text/sticker overlays on top via
/// `AVVideoCompositionCoreAnimationTool`.
public enum VideoCompositionBuilderError: Error, CustomStringConvertible {
	case emptyTimeline
	public var description: String { "EDL produced an empty main-track timeline (no clips, or all zero-duration)" }
}

public enum VideoCompositionBuilder {
	/// `edl` here is EXPECTED to be `BuiltComposition.remappedEdl`, not the
	/// caller's original document — overlay-track clip timing has already
	/// been shifted to match the (transition-compressed) main-track output
	/// timeline; see `CompositionBuilder.swift`'s `remappedEdl` doc comment
	/// and `MainTrackPlacement.buildNominalToOutputRemap`. The main track
	/// itself is untouched by remapping (only non-main tracks are), so
	/// reading `effects`/`clipById` off it here is safe either way.
	public static func build(edl: EdlDocument, built: BuiltComposition) throws -> AVMutableVideoComposition {
		guard built.totalDurationTicks > 0, !built.mainPlacements.isEmpty else {
			throw VideoCompositionBuilderError.emptyTimeline
		}
		let tps = edl.meta.ticksPerSecond

		guard let mainTrack = edl.tracks.first(where: { $0.kind == "main" && $0.trackType == "video" }) else {
			throw VideoCompositionBuilderError.emptyTimeline
		}
		var clipById: [String: EdlClip] = [:]
		for c in mainTrack.clips { clipById[c.clipId] = c }
		var assetById: [String: EdlAsset] = [:]
		for a in edl.assets { assetById[a.assetId] = a }

		func enabledBrightness(_ clipId: String) -> Double? {
			guard let clip = clipById[clipId] else { return nil }
			guard let fx = clip.effects.first(where: { $0.type == "brightness" && $0.enabled }) else { return nil }
			let amount = fx.params["amount"]?.asDouble ?? 0
			return max(-1, min(1, amount))
		}

		/// Preview-parity source placement for a main-track clip: its EDL
		/// transform plus the asset's container rotation (the compositor gets
		/// RAW decoded buffers — `preferredTransform` does not apply there).
		func sourcePlacement(_ clipId: String) -> SourcePlacement {
			guard let clip = clipById[clipId] else { return .identity }
			let rotation = clip.assetId.flatMap { assetById[$0]?.rotationDegrees } ?? 0
			return SourcePlacement(
				transform: clip.transform,
				rotationDegrees: rotation,
				opacity: clip.opacity
			)
		}

		// Canvas background behind every placed frame — flat EDL color, or
		// opaque black for any background type v1 cannot reproduce natively.
		let backgroundColor: CIColor = {
			guard edl.meta.background.type == "color",
				  let hex = edl.meta.background.color,
				  let parsed = Self.ciColor(fromHex: hex) else {
				return CIColor(red: 0, green: 0, blue: 0, alpha: 1)
			}
			return parsed
		}()

		// --- Build the sorted, contiguous instruction segments ---
		struct Segment {
			var startTicks: Int64
			var endTicks: Int64
			var instruction: EdlVideoCompositionInstruction
		}
		var segments: [Segment] = []

		for placement in built.mainPlacements {
			let solo = placement.soloRange
			guard solo.end > solo.start, let trackID = built.mainTrackIDs[placement.clipId] else { continue }
			let range = EdlTime.cmTimeRange(startTicks: solo.start, durationTicks: solo.end - solo.start, ticksPerSecond: tps)
			let instruction = EdlVideoCompositionInstruction(
				timeRange: range,
				primaryTrackID: trackID,
				primaryBrightness: enabledBrightness(placement.clipId),
				primaryPlacement: sourcePlacement(placement.clipId),
				backgroundColor: backgroundColor
			)
			segments.append(Segment(startTicks: solo.start, endTicks: solo.end, instruction: instruction))
		}

		let sortedClipIds = built.mainPlacements.map(\.clipId)
		for window in built.transitionWindows {
			guard window.outgoingIndex < sortedClipIds.count, window.incomingIndex < sortedClipIds.count else { continue }
			let outgoingId = sortedClipIds[window.outgoingIndex]
			let incomingId = sortedClipIds[window.incomingIndex]
			guard let primaryTrackID = built.mainTrackIDs[outgoingId],
				  let secondaryTrackID = built.mainTrackIDs[incomingId] else { continue }
			let range = EdlTime.cmTimeRange(startTicks: window.startTicks, durationTicks: window.durationTicks, ticksPerSecond: tps)
			let instruction = EdlVideoCompositionInstruction(
				timeRange: range,
				primaryTrackID: primaryTrackID,
				secondaryTrackID: secondaryTrackID,
				transitionWindowStart: range.start,
				transitionWindowDuration: range.duration,
				transitionKind: window.kind,
				primaryBrightness: enabledBrightness(outgoingId),
				secondaryBrightness: enabledBrightness(incomingId),
				primaryPlacement: sourcePlacement(outgoingId),
				secondaryPlacement: sourcePlacement(incomingId),
				backgroundColor: backgroundColor
			)
			segments.append(Segment(startTicks: window.startTicks, endTicks: window.endTicks, instruction: instruction))
		}

		segments.sort { $0.startTicks < $1.startTicks }

		let composition = AVMutableVideoComposition()
		composition.customVideoCompositorClass = EdlTransitionCompositor.self
		composition.instructions = segments.map(\.instruction)
		composition.frameDuration = EdlTime.frameDuration(fps: edl.output.fps)
		let renderSize = CGSize(width: edl.output.resolution.width, height: edl.output.resolution.height)
		composition.renderSize = renderSize

		let overlayLayers = OverlayLayerBuilder.buildOverlayLayers(edl: edl, renderSize: renderSize)
		if !overlayLayers.isEmpty {
			let videoLayer = CALayer()
			videoLayer.frame = CGRect(origin: .zero, size: renderSize)
			let parentLayer = CALayer()
			parentLayer.frame = CGRect(origin: .zero, size: renderSize)
			// EDL overlay `transform.positionX/Y` are authored in the SAME
			// top-left-origin, +Y-downward convention as
			// `services/renderer/scene-builder.ts` (a screen/canvas
			// convention, not AVFoundation's default bottom-left Core
			// Animation space) — `isGeometryFlipped = true` on the parent
			// makes Core Animation composite with that same top-left
			// convention so `OverlayLayerBuilder`'s frame math (also
			// top-left-origin) lines up without a second, error-prone
			// coordinate flip in two different files.
			parentLayer.isGeometryFlipped = true
			parentLayer.addSublayer(videoLayer)
			for layer in overlayLayers {
				parentLayer.addSublayer(layer)
			}
			composition.animationTool = AVVideoCompositionCoreAnimationTool(
				postProcessingAsVideoLayer: videoLayer,
				in: parentLayer
			)
		}

		return composition
	}

	/// Parses `#RGB` / `#RRGGBB` (the EDL's flat-color background format)
	/// into an opaque CIColor. Returns nil for anything unparseable so the
	/// caller can fall back to black rather than guessing.
	static func ciColor(fromHex hex: String) -> CIColor? {
		var value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
		if value.hasPrefix("#") { value.removeFirst() }
		if value.count == 3 {
			value = value.map { "\($0)\($0)" }.joined()
		}
		guard value.count == 6, let rgb = UInt32(value, radix: 16) else { return nil }
		return CIColor(
			red: CGFloat((rgb >> 16) & 0xff) / 255,
			green: CGFloat((rgb >> 8) & 0xff) / 255,
			blue: CGFloat(rgb & 0xff) / 255,
			alpha: 1
		)
	}
}
