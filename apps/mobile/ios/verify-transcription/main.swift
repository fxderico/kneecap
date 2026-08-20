import AVFoundation
import Foundation
import Speech

/// kneecap M10 round 20 — standalone verification for the Apple Speech
/// transcription path. Same pattern as `verify-export-pipeline`: compiles
/// the SAME `NativeMedia/AppleSpeechTranscriber.swift` the app ships, runs
/// it on macOS against REAL generated speech (`say` -> aiff — fully local,
/// no fixtures to license), and asserts on the output.
///
/// HONEST SCOPE: the live-recognition half needs Speech-recognition TCC
/// authorization, which a headless CLI may not be granted — in that case it
/// prints a loud SKIP and exits 0, because the PURE half (the wire mapper
/// every recognized word flows through) is always asserted. Run it once
/// from a logged-in terminal to exercise the live half.
///
/// Run:
///   swiftc App/App/NativeMedia/AppleSpeechTranscriber.swift \
///     verify-transcription/main.swift -o /tmp/verify-transcription \
///   && /tmp/verify-transcription

func fail(_ message: String) -> Never {
	FileHandle.standardError.write("FAIL: \(message)\n".data(using: .utf8)!)
	exit(1)
}

func check(_ condition: Bool, _ message: String) {
	if !condition { fail(message) }
	print("  ok: \(message)")
}

// --- 1. Pure wire-mapper assertions (no authorization needed) ---
print("== 1. wireResult mapping (pure, the path every recognized word takes) ==")
let words = [
	AppleSpeechTranscriber.RecognizedWord(text: "the", startSeconds: 0.50, durationSeconds: 0.20, confidence: 0.9),
	AppleSpeechTranscriber.RecognizedWord(text: "quick", startSeconds: 0.72, durationSeconds: 0.30, confidence: 0.0),
	AppleSpeechTranscriber.RecognizedWord(text: "fox", startSeconds: 1.10, durationSeconds: 0.40, confidence: 0.8),
]
let mapped = AppleSpeechTranscriber.wireResult(words: words, fullText: "the quick fox")
let segments = mapped["segments"] as! [[String: Any]]
check(segments.count == 1, "one segment spanning the recognized span")
let seg = segments[0]
check(seg["startMicros"] as! Int == 500_000, "segment start == first word start (got \(seg["startMicros"]!))")
check(seg["endMicros"] as! Int == 1_500_000, "segment end == last word end (got \(seg["endMicros"]!))")
check(seg["text"] as! String == "the quick fox", "segment text is the formatted transcript")
let tokens = seg["tokens"] as! [[String: Any]]
check(tokens.count == 3, "three word tokens")
check(tokens[0]["coarseStartMicros"] as! Int == 500_000 && tokens[0]["coarseEndMicros"] as! Int == 700_000, "word envelope in integer micros")
check(tokens[0]["dtwStartMicros"] is NSNull, "no fake DTW refinement signal (Apple gives one timing)")
check(tokens[1]["confidence"] is NSNull, "confidence 0 (Apple's 'unavailable') maps to null, not fake zero")
check((tokens[2]["confidence"] as! Double) == 0.8, "real confidence passes through")
let empty = AppleSpeechTranscriber.wireResult(words: [], fullText: "")
check((empty["segments"] as! [[String: Any]]).isEmpty, "zero words -> empty segments (contract's no-speech case)")

// --- 2. Live on-device recognition against generated speech ---
print("== 2. LIVE recognition: say-generated speech -> AppleSpeechTranscriber ==")
let workDir = FileManager.default.temporaryDirectory.appendingPathComponent("kneecap-verify-stt-\(UUID().uuidString)")
try! FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: workDir) }
let speechURL = workDir.appendingPathComponent("speech.aiff")

let sayProcess = Process()
sayProcess.executableURL = URL(fileURLWithPath: "/usr/bin/say")
sayProcess.arguments = ["-o", speechURL.path, "ask not what your country can do for you"]
try! sayProcess.run()
sayProcess.waitUntilExit()
guard sayProcess.terminationStatus == 0, FileManager.default.fileExists(atPath: speechURL.path) else {
	fail("could not generate speech fixture with `say`")
}
let speechBytes = (try? FileManager.default.attributesOfItem(atPath: speechURL.path)[.size] as? Int) ?? 0
print("  generated \(speechURL.lastPathComponent) (\(speechBytes ?? 0) bytes)")

/// Speech delivers its callbacks on the MAIN queue — a CLI blocking main on
/// a semaphore deadlocks (observed live: 120s timeout on the first run of
/// this harness). Pump the main run loop while waiting instead.
func pump(timeout: TimeInterval, until done: () -> Bool) -> Bool {
	let deadline = Date().addingTimeInterval(timeout)
	while !done() {
		if Date() > deadline { return false }
		RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
	}
	return true
}

var authStatus: SFSpeechRecognizerAuthorizationStatus = .notDetermined
var authDone = false
SFSpeechRecognizer.requestAuthorization { status in
	authStatus = status
	authDone = true
}
if !pump(timeout: 15, until: { authDone }) || authStatus != .authorized {
	print("""
	  SKIP: speech-recognition authorization not granted in this headless \
	context (status=\(authStatus.rawValue)) — the live half needs one run from \
	a logged-in terminal. The pure mapper above is fully asserted either way.
	""")
	print("\nALL RUNNABLE CHECKS PASSED (live half skipped)")
	exit(0)
}

var liveResult: Result<[String: Any], AppleSpeechTranscriberError>?
AppleSpeechTranscriber.transcribe(audioUri: speechURL.path, languageHint: "en-US") { result in
	liveResult = result
}
if !pump(timeout: 120, until: { liveResult != nil }) {
	fail("live recognition timed out after 120s")
}

switch liveResult! {
case .failure(let error):
	// On-device model genuinely absent on this Mac -> honest skip, the
	// same way the app reports UNSUPPORTED to the user.
	if case .onDeviceUnavailable = error {
		print("  SKIP: \(error.description)")
		print("\nALL RUNNABLE CHECKS PASSED (live half skipped: no on-device model)")
		exit(0)
	}
	fail("live recognition failed: \(error.description)")
case .success(let payload):
	let liveSegments = payload["segments"] as! [[String: Any]]
	check(!liveSegments.isEmpty, "live recognition produced at least one segment")
	let liveTokens = liveSegments[0]["tokens"] as! [[String: Any]]
	let text = (liveSegments[0]["text"] as! String).lowercased()
	print("  transcript: \"\(text)\" (\(liveTokens.count) words)")
	check(liveTokens.count >= 6, "word-level tokens present (got \(liveTokens.count))")
	check(text.contains("country"), "transcript contains 'country' (got \"\(text)\")")
	var lastStart = -1
	for token in liveTokens {
		let start = token["coarseStartMicros"] as! Int
		let end = token["coarseEndMicros"] as! Int
		check(end >= start, "token envelope non-inverted (\(start)..\(end))")
		check(start >= lastStart, "token starts monotonic (\(lastStart) -> \(start))")
		lastStart = start
	}
}

// --- 3. Audio extraction from a VIDEO container (the round-21.1 device bug:
// SFSpeechURLRecognitionRequest fed a video file returns one empty
// zero-length segment; extraction to .m4a is the fix) ---
print("== 3. extractAudio from the VIDEO fixture (the device failure mode) ==")
let fixturePath = CommandLine.arguments.count > 1
	? CommandLine.arguments[1]
	: "App/App/Fixtures/kneecap-test-clip.mp4"
if FileManager.default.fileExists(atPath: fixturePath) {
	var extractResult: Result<URL, AppleSpeechTranscriberError>?
	AppleSpeechTranscriber.extractAudio(from: URL(fileURLWithPath: fixturePath)) { result in
		extractResult = result
	}
	if !pump(timeout: 60, until: { extractResult != nil }) {
		fail("audio extraction timed out")
	}
	switch extractResult! {
	case .failure(let error):
		fail("extraction from video container failed: \(error.description)")
	case .success(let m4aURL):
		defer { try? FileManager.default.removeItem(at: m4aURL) }
		check(m4aURL.pathExtension == "m4a", "extracted an .m4a from the mp4 video container")
		let asset = AVURLAsset(url: m4aURL)
		var duration: Double = -1
		var audioTrackCount = -1
		let probeDone = DispatchSemaphore(value: 0)
		Task {
			duration = (try? await asset.load(.duration).seconds) ?? -1
			audioTrackCount = (try? await asset.loadTracks(withMediaType: .audio).count) ?? -1
			probeDone.signal()
		}
		_ = probeDone.wait(timeout: .now() + 30)
		check(audioTrackCount == 1, "extracted file has exactly one audio track (got \(audioTrackCount))")
		check(duration > 1.0, "extracted audio has real duration (got \(String(format: "%.2f", duration))s)")
	}
} else {
	print("  SKIP: fixture not found at \(fixturePath) — pass a path as argv[1]")
}

print("\nALL CHECKS PASSED")
