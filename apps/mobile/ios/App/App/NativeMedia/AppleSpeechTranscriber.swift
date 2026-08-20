import Foundation
import Speech

/// kneecap M10 (round 20) — the iOS half of `NativeBridge.transcribe()`,
/// implemented on Apple's Speech framework instead of whisper.cpp.
///
/// WHY NOT WHISPER (founder: "worried whisper will be too heavy for
/// mobile — check"): whisper.cpp on iOS costs a bundled/downloaded model
/// (tiny.en q5 ≈ 32MB, base.en ≈ 60MB), a few hundred MB of peak RAM, an
/// out-of-repo xcframework build, and the audio-decode pipeline
/// `WhisperTranscriber.swift`'s own header documents as unimplemented.
/// Apple's Speech framework costs ZERO bytes of app weight, runs
/// on-device (private, offline), returns per-word timestamps + confidence
/// — exactly the wire contract's `coarseStart/EndMicros` envelope — and
/// `caption-smoothing.ts` runs identically on its words (`dtwStartMicros`
/// stays null, which the smoother already treats as "no refinement
/// signal"). CapCut itself does NONE of this on-device: its auto-captions
/// upload audio to ByteDance's server ASR (they fail offline) — so any
/// on-device path already beats CapCut on privacy and offline. The
/// whisper.cpp scaffold stays as the documented Android engine (already
/// built there) and a future iOS quality option; `SpeechAnalyzer`/
/// `SpeechTranscriber` (iOS 26's new API, the plan's own "preferred path"
/// note) is the designated upgrade once this baseline is device-proven.
///
/// This file is PURE Foundation + Speech (no Capacitor) so
/// `verify-transcription` compiles it into a macOS CLI and exercises the
/// real mapping — the same harness pattern as `verify-export-pipeline`.
public enum AppleSpeechTranscriberError: Error, CustomStringConvertible {
	case audioNotReadable(String)
	case localeUnsupported(String)
	case onDeviceUnavailable(String)
	case recognitionFailed(String)

	public var description: String {
		switch self {
		case .audioNotReadable(let m): return "audio not readable: \(m)"
		case .localeUnsupported(let m): return "speech recognition unsupported for locale: \(m)"
		case .onDeviceUnavailable(let m): return "on-device speech recognition unavailable: \(m)"
		case .recognitionFailed(let m): return "speech recognition failed: \(m)"
		}
	}
}

public enum AppleSpeechTranscriber {

	/// One recognized word in a plain, framework-free shape — lets the wire
	/// mapper below be unit-tested by the harness without constructing
	/// (unconstructable) `SFTranscriptionSegment`s.
	public struct RecognizedWord {
		public let text: String
		/// Seconds from the start of the AUDIO FILE (source-relative).
		public let startSeconds: Double
		public let durationSeconds: Double
		/// 0...1; Apple reports 0 when confidence is unavailable.
		public let confidence: Double

		public init(text: String, startSeconds: Double, durationSeconds: Double, confidence: Double) {
			self.text = text
			self.startSeconds = startSeconds
			self.durationSeconds = durationSeconds
			self.confidence = confidence
		}
	}

	/// `MediaHandle.uri` arrives as either an absolute sandbox path or a
	/// `file://` URL string — same duality `NativeBridgePlugin+Export.swift`
	/// handles for `EdlAsset.sourceUri`.
	public static func audioURL(fromUri uri: String) -> URL {
		if uri.hasPrefix("file://"), let url = URL(string: uri) {
			return url
		}
		return URL(fileURLWithPath: uri)
	}

	/// Transcribe a media file's audio on-device. `modelSize` from the wire
	/// contract is accepted and ignored — Apple's recognizer has no model
	/// tiers (documented on the TS side too). Completion is called exactly
	/// once, on an arbitrary queue.
	public static func transcribe(
		audioUri: String,
		languageHint: String?,
		completion: @escaping (Result<[String: Any], AppleSpeechTranscriberError>) -> Void
	) {
		let url = audioURL(fromUri: audioUri)
		guard FileManager.default.fileExists(atPath: url.path) else {
			completion(.failure(.audioNotReadable(url.path)))
			return
		}

		let localeId = languageHint ?? "en-US"
		guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
			completion(.failure(.localeUnsupported(localeId)))
			return
		}
		guard recognizer.isAvailable else {
			completion(.failure(.recognitionFailed("recognizer unavailable (locale \(localeId))")))
			return
		}

		let request = SFSpeechURLRecognitionRequest(url: url)
		request.shouldReportPartialResults = false
		request.taskHint = .dictation
		if #available(iOS 16.0, macOS 13.0, *) {
			request.addsPunctuation = true
		}
		// Local-first, like everything else in this app: never silently
		// upload the user's audio. If this device/locale cannot recognize
		// on-device, fail with a clear reason instead of falling back to
		// Apple's server.
		if recognizer.supportsOnDeviceRecognition {
			request.requiresOnDeviceRecognition = true
		} else {
			completion(.failure(.onDeviceUnavailable(
				"locale \(localeId) has no on-device model on this device — " +
				"download it in Settings > General > Keyboard > Dictation, or use a supported language"
			)))
			return
		}

		recognizer.recognitionTask(with: request) { result, error in
			if let error {
				completion(.failure(.recognitionFailed(error.localizedDescription)))
				return
			}
			guard let result, result.isFinal else { return }
			let words = result.bestTranscription.segments.map { segment in
				RecognizedWord(
					text: segment.substring,
					startSeconds: segment.timestamp,
					durationSeconds: segment.duration,
					confidence: Double(segment.confidence)
				)
			}
			completion(.success(wireResult(
				words: words,
				fullText: result.bestTranscription.formattedString
			)))
		}
	}

	/// Map recognized words into the exact `NativeTranscribeResult` wire
	/// shape `capacitor-bridge.ts` expects: one segment spanning the whole
	/// recognized span, word tokens carrying the coarse envelope
	/// (`caption-smoothing.ts` chunks/smooths downstream; caption LINE
	/// grouping is editor-core's `buildCaptionElementsFromTranscript`'s
	/// job, not this mapper's). `dtwStartMicros` is always null — Apple
	/// gives one timing signal, which IS the reliable envelope. Zero words
	/// (no speech) returns `segments: []` per the contract's "genuinely no
	/// decodable words" case.
	public static func wireResult(words: [RecognizedWord], fullText: String) -> [String: Any] {
		guard let first = words.first, let last = words.last else {
			return ["segments": [[String: Any]]()]
		}
		let micros = { (seconds: Double) in Int((seconds * 1_000_000).rounded()) }
		let tokens: [[String: Any]] = words.map { word in
			[
				"text": word.text,
				"coarseStartMicros": micros(word.startSeconds),
				"coarseEndMicros": micros(word.startSeconds + word.durationSeconds),
				"dtwStartMicros": NSNull(),
				// Apple reports 0 for "confidence unavailable" (e.g. every
				// non-final result, some on-device paths) — map that to the
				// wire contract's null rather than lying "zero confidence".
				"confidence": word.confidence > 0 ? word.confidence : NSNull(),
			]
		}
		let segment: [String: Any] = [
			"startMicros": micros(first.startSeconds),
			"endMicros": micros(last.startSeconds + last.durationSeconds),
			"text": fullText,
			"confidence": NSNull(),
			"tokens": tokens,
		]
		return ["segments": [segment]]
	}
}
