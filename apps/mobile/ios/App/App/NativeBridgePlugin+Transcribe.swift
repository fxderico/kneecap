import Foundation
import Capacitor
import Speech

/// kneecap M10 (round 20) — the `transcribe` plugin method, Capacitor glue
/// over `NativeMedia/AppleSpeechTranscriber.swift` (which holds ALL the
/// recognition + wire-mapping logic so `verify-transcription` can compile
/// and exercise it without Capacitor). See that file's header for why this
/// is Apple Speech and not whisper.cpp on iOS.
///
/// Error-code mapping follows `NATIVE_BRIDGE_ERROR_CODES`
/// (packages/native-bridge/src/types.ts): authorization -> PERMISSION_DENIED,
/// locale/on-device gaps -> UNSUPPORTED, everything IO-ish -> IO_ERROR. The
/// TS bridge preserves these codes verbatim (`toNativeBridgeError`).
extension NativeBridgePlugin {

	@objc func transcribe(_ call: CAPPluginCall) {
		guard let audioUri = call.getString("audioUri"), !audioUri.isEmpty else {
			call.reject("transcribe requires audioUri", "IO_ERROR")
			return
		}
		// `modelSize` is part of the wire contract for the Android
		// whisper.cpp engine; Apple's recognizer has no model tiers, so it
		// is accepted and ignored here (documented on the TS side too).
		let languageHint = call.getString("languageHint")

		SFSpeechRecognizer.requestAuthorization { status in
			switch status {
			case .authorized:
				AppleSpeechTranscriber.transcribe(
					audioUri: audioUri,
					languageHint: languageHint
				) { result in
					switch result {
					case .success(let payload):
						call.resolve(payload)
					case .failure(let error):
						switch error {
						case .localeUnsupported, .onDeviceUnavailable:
							call.reject(error.description, "UNSUPPORTED")
						case .audioNotReadable, .recognitionFailed:
							call.reject(error.description, "IO_ERROR")
						}
					}
				}
			case .denied, .restricted:
				call.reject(
					"speech recognition permission denied — enable it in Settings > kneecap",
					"PERMISSION_DENIED"
				)
			case .notDetermined:
				// The callback only fires with a determined status; this arm
				// exists for the enum, not for a reachable state.
				call.reject("speech recognition authorization undetermined", "PERMISSION_DENIED")
			@unknown default:
				call.reject("speech recognition authorization unknown state", "PERMISSION_DENIED")
			}
		}
	}
}
