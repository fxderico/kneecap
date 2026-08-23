import Foundation

/// kneecap M4 item 1: "Copy or reference-resolve into the app sandbox;
/// exclude from iCloud backup." Path layout + backup-exclusion helpers,
/// shared by the import, proxy, and thumbnail steps.
///
/// Platform-agnostic for the same reason as `MediaProbe.swift` — see its
/// header comment. `FileManager`'s `.applicationSupportDirectory` and
/// `URLResourceValues.isExcludedFromBackupKey` both resolve on macOS too
/// (a no-op there, since macOS's Time Machine model doesn't share iOS's
/// per-file backup-exclusion flag), which is what lets
/// `verify-media-pipeline` exercise the real copy-and-exclude code path on
/// the host Mac.
public enum MediaSandbox {
	/// `Application Support/kneecap/` — never `Documents/` (user-visible via
	/// Files app / iTunes file sharing, wrong custody model for re-derivable
	/// imported media) and never `tmp/` (can be purged by the OS at any time).
	public static func rootDirectory() throws -> URL {
		let base = try FileManager.default.url(
			for: .applicationSupportDirectory,
			in: .userDomainMask,
			appropriateFor: nil,
			create: true
		)
		let dir = base.appendingPathComponent("kneecap", isDirectory: true)
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		return dir
	}

	public static func mediaDirectory() throws -> URL {
		try subdirectory("Media")
	}

	public static func proxyDirectory() throws -> URL {
		try subdirectory("Proxies")
	}

	public static func thumbnailDirectory(assetId: String) throws -> URL {
		let dir = try subdirectory("Thumbnails").appendingPathComponent(assetId, isDirectory: true)
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		return dir
	}

	private static func subdirectory(_ name: String) throws -> URL {
		let dir = try rootDirectory().appendingPathComponent(name, isDirectory: true)
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		return dir
	}

	/// Imported media is re-derivable from the user's photo library (or, for
	/// generated proxies/thumbnails, from the imported original) — not
	/// first-party data worth an iCloud/iTunes backup, and video is exactly
	/// the kind of payload that makes backups slow/expensive if included.
	public static func excludeFromBackup(_ url: URL) {
		var mutableURL = url
		var values = URLResourceValues()
		values.isExcludedFromBackup = true
		try? mutableURL.setResourceValues(values)
	}

	/// Copies `sourceURL` into sandboxed media custody under a UUID-derived
	/// name (never the original filename — avoids collisions and strips any
	/// PII a user-chosen filename might carry), excluded from backup.
	@discardableResult
	public static func copyIntoMediaCustody(
		sourceURL: URL,
		assetId: String,
		fileExtension: String
	) throws -> URL {
		let dir = try mediaDirectory()
		let dest = dir.appendingPathComponent("\(assetId).\(fileExtension)")
		if FileManager.default.fileExists(atPath: dest.path) {
			try FileManager.default.removeItem(at: dest)
		}
		try FileManager.default.copyItem(at: sourceURL, to: dest)
		excludeFromBackup(dest)
		return dest
	}

	public static func proxyURL(assetId: String) throws -> URL {
		try proxyDirectory().appendingPathComponent("\(assetId).mp4")
	}

	/// kneecap M9. Finished exports, unlike proxies/thumbnails, are NOT
	/// re-derivable garbage — they're the user's deliverable — so
	/// deliberately NOT excluded from backup (contrast
	/// `copyIntoMediaCustody`'s `excludeFromBackup` call): losing a
	/// finished export to a restore gap would be a real loss, not a
	/// re-transcode inconvenience.
	public static func exportsDirectory() throws -> URL {
		try subdirectory("Exports")
	}

	public static func exportURL(exportId: String) throws -> URL {
		try exportsDirectory().appendingPathComponent("\(exportId).mp4")
	}

	/// Every finished export is ALSO copied into the Photos library, so the
	/// container's copy is a second full-resolution video on a device that
	/// already holds the originals, their proxies and their thumbnails. Left
	/// unbounded, a few 1080p exports fill the phone — the founder's iPhone
	/// hit 6.7 MB free and Xcode refused to install (2026-08-23).
	///
	/// Keeps the newest `keep` exports (the current one is written after
	/// this runs, so the most recent finished exports stay shareable from
	/// the sheet) and deletes the rest. Returns bytes reclaimed. Never
	/// throws: reclaiming space must not be able to fail an export.
	@discardableResult
	public static func pruneOldExports(keep: Int = 2) -> Int64 {
		guard let directory = try? exportsDirectory() else { return 0 }
		let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
		guard let entries = try? FileManager.default.contentsOfDirectory(
			at: directory,
			includingPropertiesForKeys: keys,
			options: [.skipsHiddenFiles]
		) else { return 0 }

		let sorted = entries.sorted { lhs, rhs in
			let l = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]))?
				.contentModificationDate ?? .distantPast
			let r = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]))?
				.contentModificationDate ?? .distantPast
			return l > r
		}
		var reclaimed: Int64 = 0
		for url in sorted.dropFirst(max(0, keep)) {
			let size = Int64(
				(try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
			)
			if (try? FileManager.default.removeItem(at: url)) != nil {
				reclaimed += size
			}
		}
		if reclaimed > 0 {
			print("[kneecap-storage] pruned old exports, reclaimed \(reclaimed / 1_048_576) MB")
		}
		return reclaimed
	}

	/// Bytes currently held under the custody root, by bucket — for the
	/// storage diagnostics logged before each export.
	public static func usageReport() -> String {
		guard let root = try? rootDirectory() else { return "custody root unavailable" }
		var parts: [String] = []
		for bucket in ["Media", "Proxies", "Thumbnails", "Exports"] {
			let dir = root.appendingPathComponent(bucket, isDirectory: true)
			guard let enumerator = FileManager.default.enumerator(
				at: dir,
				includingPropertiesForKeys: [.fileSizeKey]
			) else { continue }
			var total: Int64 = 0
			for case let url as URL in enumerator {
				total += Int64((try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
			}
			parts.append("\(bucket) \(total / 1_048_576)MB")
		}
		return parts.joined(separator: ", ")
	}
}
