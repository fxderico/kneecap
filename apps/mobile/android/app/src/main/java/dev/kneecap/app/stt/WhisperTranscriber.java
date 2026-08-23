package dev.kneecap.app.stt;

import android.content.Context;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONException;

/**
 * kneecap M10 — the native-plugin-facing entry point for
 * `NativeBridge.transcribe()`. Produces exactly the wire shape
 * `packages/native-bridge/src/capacitor-bridge.ts` expects
 * (`NativeTranscribeResult` there): a list of segments, each carrying its
 * own start/end/text plus a `tokens` array shaped like `RawWordTiming`
 * (`caption-smoothing.ts`) — `coarseStartMicros`/`coarseEndMicros` from
 * whisper.cpp's `t0`/`t1`, `dtwStartMicros` from `t_dtw` (or `null` for its
 * `-1` sentinel), `confidence` from the token's decode probability. The
 * mandatory smoothing pass itself runs entirely on the TS side
 * (`mapNativeTranscribeResult()` in `capacitor-bridge.ts`) — this class's
 * only job is producing honest raw numbers for it to smooth.
 *
 * HONEST STATUS (see also `WhisperJNI`'s class doc comment): this class is
 * real, reviewed Java, but two things stand between it and an actual
 * on-device transcription today:
 *
 *   1. No `libkneecap_whisper.so` is built/bundled — `WhisperJNI`'s native
 *      calls throw `UnsatisfiedLinkError`.
 *   2. `decodeToMono16kFloat()` below is NOT implemented — turning an
 *      arbitrary native-custody audio/video URI into 16kHz mono float32
 *      PCM (whisper.cpp's hard input requirement) needs a real
 *      MediaExtractor/MediaCodec decode+resample pipeline. That is
 *      legitimately its own unit of work, and overlaps with M4's media
 *      pipeline (which will already own audio-track extraction for proxy
 *      generation) — implementing it twice, differently, here would be
 *      wasted work. Throws `UnsupportedOperationException` naming this
 *      reason rather than silently returning empty/fake audio.
 *
 * `transcribe()` therefore always throws today. That is the correct,
 * honest state for M10 part 1 — see the plan's own explicit allowance for
 * "simulator/device runs may be partial" and this class's own tests (none
 * yet: exercising this requires either a real `.so` + real audio, or a
 * device/emulator run, neither available in the session that wrote this).
 */
public final class WhisperTranscriber {

	private WhisperTranscriber() {}

	public static final class NotYetWiredException extends RuntimeException {
		public NotYetWiredException(String message) {
			super(message);
		}
	}

	/**
	 * @param context     Android context, used to resolve the bundled model
	 *                    asset path (`assets/models/ggml-{modelSize}.en.bin`,
	 *                    populated at build time by
	 *                    `scripts/download-whisper-model.sh` — see that
	 *                    script and `assets/models/README.md`).
	 * @param audioUri    native-custody handle to the source clip's audio
	 *                    (matches `MediaHandle.uri` — never a `blob:` URL).
	 * @param modelSize   "tiny" or "base" (`TranscribeOptions.modelSize`);
	 *                    resolves to the bundled `.en` asset — kneecap v1
	 *                    ships English-only models (see
	 *                    `download-whisper-model.sh`'s header comment).
	 * @param languageHint reserved for a future non-English model; unused
	 *                    while only `.en` models are bundled.
	 */
	public static JSObject transcribe(
			Context context, String audioUri, String modelSize, String languageHint)
			throws JSONException {
		String modelAssetPath = "models/ggml-" + modelSize + ".en.bin";
		if (!modelAssetExists(context, modelAssetPath)) {
			throw new NotYetWiredException(
					"Bundled model asset '"
							+ modelAssetPath
							+ "' not found. Run scripts/download-whisper-model.sh at build time"
							+ " (see apps/mobile/android/app/src/main/assets/models/README.md).");
		}

		// The two real gaps this class's doc comment describes. Both throw
		// before reaching WhisperJNI, so a missing .so is never the FIRST
		// error a caller sees — the audio-decode gap is more informative
		// and is fixed first regardless of library-loading status.
		float[] pcm16kMono = decodeToMono16kFloat(context, audioUri);

		WhisperJNI.ensureLibraryLoaded();
		// WHISPER_AHEADS_TINY_EN = 3, WHISPER_AHEADS_BASE_EN = 5 — ordinals
		// of `enum whisper_alignment_heads_preset` in `include/whisper.h`,
		// read directly off that header while writing this (see
		// WhisperJNI.initContext's doc comment for why an int ordinal
		// crosses the JNI boundary instead of redeclaring the enum here).
		int aheadsPreset = "base".equals(modelSize) ? 5 : 3;
		long ctx =
				WhisperJNI.initContext(
						resolveAbsoluteModelPath(context, modelAssetPath), /* dtw= */ true, aheadsPreset);
		if (ctx == 0) {
			throw new IllegalStateException("whisper_init failed for model " + modelAssetPath);
		}
		try {
			WhisperJNI.fullTranscribe(ctx, preferredThreadCount(), pcm16kMono);
			return buildResult(ctx);
		} finally {
			WhisperJNI.freeContext(ctx);
		}
	}

	private static JSObject buildResult(long ctx) throws JSONException {
		JSObject result = new JSObject();
		JSArray segments = new JSArray();
		int segmentCount = WhisperJNI.getSegmentCount(ctx);
		for (int s = 0; s < segmentCount; s++) {
			JSObject segment = new JSObject();
			segment.put("startMicros", WhisperJNI.getSegmentT0(ctx, s) * 10_000L);
			segment.put("endMicros", WhisperJNI.getSegmentT1(ctx, s) * 10_000L);
			segment.put("text", WhisperJNI.getSegmentText(ctx, s));
			segment.put("confidence", JSObject.NULL);

			JSArray tokens = new JSArray();
			int tokenCount = WhisperJNI.getSegmentTokenCount(ctx, s);
			for (int t = 0; t < tokenCount; t++) {
				JSObject token = new JSObject();
				token.put("text", WhisperJNI.getTokenText(ctx, s, t));
				token.put("coarseStartMicros", WhisperJNI.getTokenT0(ctx, s, t) * 10_000L);
				token.put("coarseEndMicros", WhisperJNI.getTokenT1(ctx, s, t) * 10_000L);
				long dtw = WhisperJNI.getTokenDtw(ctx, s, t);
				token.put("dtwStartMicros", dtw == -1 ? JSObject.NULL : dtw * 10_000L);
				token.put("confidence", WhisperJNI.getTokenProbability(ctx, s, t));
				tokens.put(token);
			}
			segment.put("tokens", tokens);
			segments.put(segment);
		}
		result.put("segments", segments);
		return result;
	}

	private static boolean modelAssetExists(Context context, String assetPath) {
		try (java.io.InputStream unused = context.getAssets().open(assetPath)) {
			return true;
		} catch (java.io.IOException e) {
			return false;
		}
	}

	/**
	 * whisper.cpp's {@code whisper_init_from_file} needs a real filesystem
	 * path, not an APK asset stream, so the bundled model is copied out to
	 * {@code filesDir/models/} once and reused. The copy is size-guarded
	 * rather than hash-guarded: the asset is immutable within an installed
	 * APK, so a cached file of the right length is the right file, and a
	 * partial copy from a killed process has the wrong length and is redone.
	 */
	private static String resolveAbsoluteModelPath(Context context, String assetPath) {
		java.io.File cached = new java.io.File(context.getFilesDir(), assetPath);
		long assetLength = assetLength(context, assetPath);
		if (cached.isFile() && assetLength > 0 && cached.length() == assetLength) {
			return cached.getAbsolutePath();
		}
		java.io.File parent = cached.getParentFile();
		if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
			throw new IllegalStateException("cannot create model cache dir " + parent);
		}
		java.io.File partial = new java.io.File(cached.getPath() + ".part");
		try (java.io.InputStream in = context.getAssets().open(assetPath);
				java.io.OutputStream out = new java.io.FileOutputStream(partial)) {
			byte[] buffer = new byte[1 << 16];
			int read;
			while ((read = in.read(buffer)) != -1) {
				out.write(buffer, 0, read);
			}
		} catch (java.io.IOException e) {
			throw new IllegalStateException("cannot copy model asset " + assetPath, e);
		}
		// Rename last: a reader either sees no file or a complete one, never a
		// half-written model that whisper_init would fail on cryptically.
		if (!partial.renameTo(cached)) {
			throw new IllegalStateException("cannot finalize model cache file " + cached);
		}
		return cached.getAbsolutePath();
	}

	private static long assetLength(Context context, String assetPath) {
		try (android.content.res.AssetFileDescriptor fd =
				context.getAssets().openFd(assetPath)) {
			return fd.getLength();
		} catch (java.io.IOException e) {
			// Assets over ~1MB are stored uncompressed and openFd works; a
			// compressed asset throws here, in which case the length is
			// unknown and the copy is simply redone each cold start.
			return -1;
		}
	}

	/**
	 * Decodes any audio-bearing native-custody file (the audio track of an
	 * mp4 works as well as a bare m4a) to the 16kHz mono float32 PCM that
	 * whisper.cpp requires, via MediaExtractor + MediaCodec.
	 *
	 * <p>Downmix is a plain channel average and the resample is linear
	 * interpolation. Both are deliberate: whisper's own front end immediately
	 * reduces this to an 80-bin log-mel spectrogram at a 10ms hop, so the
	 * imaging artifacts a higher-order resampler would suppress land far
	 * above the band that survives that transform. This is the same tradeoff
	 * upstream's {@code examples/whisper.android} makes.
	 */
	private static float[] decodeToMono16kFloat(Context context, String audioUri) {
		String path = audioUri.startsWith("file://") ? android.net.Uri.parse(audioUri).getPath() : audioUri;
		if (path == null) {
			throw new IllegalArgumentException("cannot resolve a filesystem path from " + audioUri);
		}
		android.media.MediaExtractor extractor = new android.media.MediaExtractor();
		android.media.MediaCodec codec = null;
		try {
			extractor.setDataSource(path);
			int audioTrack = -1;
			android.media.MediaFormat inputFormat = null;
			for (int i = 0; i < extractor.getTrackCount(); i++) {
				android.media.MediaFormat format = extractor.getTrackFormat(i);
				String mime = format.getString(android.media.MediaFormat.KEY_MIME);
				if (mime != null && mime.startsWith("audio/")) {
					audioTrack = i;
					inputFormat = format;
					break;
				}
			}
			if (audioTrack < 0 || inputFormat == null) {
				throw new IllegalStateException("no audio track in " + path);
			}
			extractor.selectTrack(audioTrack);

			codec = android.media.MediaCodec.createDecoderByType(
					inputFormat.getString(android.media.MediaFormat.KEY_MIME));
			codec.configure(inputFormat, null, null, 0);
			codec.start();

			// The decoder reports the AUTHORITATIVE rate/channel count on its
			// output format, which can differ from the container's (HE-AAC
			// decoders routinely output double the signalled rate), so both
			// are read from the output format as it arrives, not from
			// `inputFormat`.
			int sourceRate = inputFormat.getInteger(android.media.MediaFormat.KEY_SAMPLE_RATE);
			int sourceChannels = inputFormat.getInteger(android.media.MediaFormat.KEY_CHANNEL_COUNT);

			java.io.ByteArrayOutputStream monoBytes = new java.io.ByteArrayOutputStream();
			android.media.MediaCodec.BufferInfo info = new android.media.MediaCodec.BufferInfo();
			boolean inputDone = false;
			boolean outputDone = false;
			while (!outputDone) {
				if (!inputDone) {
					int inputIndex = codec.dequeueInputBuffer(10_000);
					if (inputIndex >= 0) {
						java.nio.ByteBuffer buffer = codec.getInputBuffer(inputIndex);
						int size = buffer == null ? -1 : extractor.readSampleData(buffer, 0);
						if (size < 0) {
							codec.queueInputBuffer(
									inputIndex, 0, 0, 0, android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM);
							inputDone = true;
						} else {
							codec.queueInputBuffer(inputIndex, 0, size, extractor.getSampleTime(), 0);
							extractor.advance();
						}
					}
				}
				int outputIndex = codec.dequeueOutputBuffer(info, 10_000);
				if (outputIndex == android.media.MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
					android.media.MediaFormat outputFormat = codec.getOutputFormat();
					sourceRate = outputFormat.getInteger(android.media.MediaFormat.KEY_SAMPLE_RATE);
					sourceChannels = outputFormat.getInteger(android.media.MediaFormat.KEY_CHANNEL_COUNT);
				} else if (outputIndex >= 0) {
					java.nio.ByteBuffer buffer = codec.getOutputBuffer(outputIndex);
					if (buffer != null && info.size > 0) {
						buffer.position(info.offset);
						buffer.limit(info.offset + info.size);
						byte[] chunk = new byte[info.size];
						buffer.get(chunk);
						monoBytes.write(chunk, 0, chunk.length);
					}
					codec.releaseOutputBuffer(outputIndex, false);
					if ((info.flags & android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
						outputDone = true;
					}
				}
			}

			return resampleToMono16k(monoBytes.toByteArray(), sourceRate, Math.max(1, sourceChannels));
		} catch (java.io.IOException e) {
			throw new IllegalStateException("cannot decode audio at " + path, e);
		} finally {
			if (codec != null) {
				try {
					codec.stop();
				} catch (IllegalStateException ignored) {
					// Already stopped/released after an error — nothing to do.
				}
				codec.release();
			}
			extractor.release();
		}
	}

	/** 16-bit interleaved PCM → averaged mono → linearly resampled 16kHz float. */
	private static float[] resampleToMono16k(byte[] pcm16, int sourceRate, int channels) {
		java.nio.ShortBuffer shorts =
				java.nio.ByteBuffer.wrap(pcm16).order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer();
		int frames = shorts.remaining() / channels;
		float[] mono = new float[frames];
		for (int frame = 0; frame < frames; frame++) {
			int sum = 0;
			for (int channel = 0; channel < channels; channel++) {
				sum += shorts.get(frame * channels + channel);
			}
			mono[frame] = (sum / (float) channels) / 32768f;
		}
		if (sourceRate == TARGET_SAMPLE_RATE || frames == 0) {
			return mono;
		}
		double ratio = sourceRate / (double) TARGET_SAMPLE_RATE;
		int outFrames = (int) Math.floor(frames / ratio);
		float[] out = new float[outFrames];
		for (int i = 0; i < outFrames; i++) {
			double position = i * ratio;
			int low = (int) position;
			int high = Math.min(low + 1, frames - 1);
			float fraction = (float) (position - low);
			out[i] = mono[low] * (1 - fraction) + mono[high] * fraction;
		}
		return out;
	}

	private static final int TARGET_SAMPLE_RATE = 16_000;

	private static int preferredThreadCount() {
		// Matches examples/whisper.android's own WhisperCpuConfig heuristic
		// (leave one core free for the OS/UI thread), without importing
		// that reference project — this is a two-line equivalent, not
		// worth a dependency.
		int cores = Runtime.getRuntime().availableProcessors();
		return Math.max(1, cores - 1);
	}
}
