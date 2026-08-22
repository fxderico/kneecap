import type { MediaType } from "@/media/types";
import type {
	TProject,
	TProjectMetadata,
	TTimelineViewState,
} from "@/project/types";
import type { TScene } from "@/timeline";

export interface StorageAdapter<T> {
	get(key: string): Promise<T | null>;
	set(args: { key: string; value: T }): Promise<void>;
	remove(key: string): Promise<void>;
	list(): Promise<string[]>;
	clear(): Promise<void>;
}

export interface MediaAssetData {
	id: string;
	name: string;
	type: MediaType;
	size: number;
	lastModified: number;
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	hasAudio?: boolean;
	ephemeral?: boolean;
	thumbnailUrl?: string;
	/** Persisted playback URI — ONLY for native-custody assets whose stored
	 *  `file` is the zero-byte stub (media/native-import.ts): the bytes live
	 *  on the native filesystem, so the converted proxy URL is the asset's
	 *  identity across launches. Never set for blob-backed assets (their
	 *  object URLs die with the session and are regenerated at load).
	 *  Known limit: the URI embeds the iOS app-container UUID, which
	 *  changes on app REINSTALL — so this absolute form is only a FALLBACK;
	 *  the durable identity is `nativeRelativePath` below. */
	url?: string;
	/** Custody-root-relative path of the native proxy (see
	 *  media/native-paths.ts) — survives iOS container-UUID rotation across
	 *  app updates, which kills any persisted absolute path/URL. Present
	 *  only for native-custody assets imported on a build whose native side
	 *  implements `getMediaRoot`. */
	nativeRelativePath?: string;
	/** Same, for the persisted thumbnail. */
	thumbnailNativeRelativePath?: string;
	/** Custody-root-relative path of the ORIGINAL imported file — what the
	 *  native EXPORT pipeline reads (full resolution; the proxy is
	 *  preview-only). Missing on assets imported before 2026-08-20; export
	 *  falls back to the proxy for those (degraded, but not a failure). */
	sourceNativeRelativePath?: string;
	/** The original's display rotation (EXIF/track transform), needed when
	 *  exporting from the source (the proxy is already baked upright). */
	sourceRotationDegrees?: 0 | 90 | 180 | 270;
	/** The ORIGINAL file's pixel dimensions. `width`/`height` above are the
	 *  PROXY's for native imports (deliberate — the preview compositor works
	 *  against the proxy), so anything sizing OUTPUT-quality decisions
	 *  (canvas aspect adoption → export resolution) must read these instead:
	 *  adopting from proxy dims silently pinned brand-new projects — and
	 *  therefore every export — to the proxy's 540p class (founder's
	 *  "grainy export", 2026-08-22). Missing on assets imported before this
	 *  field existed and on web-fallback imports (where the proxy IS the
	 *  source, so width/height are already the true dims). */
	sourceWidth?: number;
	sourceHeight?: number;
}

export type SerializedScene = Omit<TScene, "createdAt" | "updatedAt"> & {
	createdAt: string;
	updatedAt: string;
};

export type SerializedProjectMetadata = Omit<
	TProjectMetadata,
	"createdAt" | "updatedAt"
> & {
	createdAt: string;
	updatedAt: string;
};

export type SerializedProject = Omit<TProject, "metadata" | "scenes"> & {
	metadata: SerializedProjectMetadata;
	scenes: SerializedScene[];
	timelineViewState?: TTimelineViewState;
};

export interface StorageConfig {
	projectsDb: string;
	mediaDb: string;
	savedSoundsDb: string;
	version: number;
}

// TypeScript type augmentation to add async iterator methods to FileSystemDirectoryHandle
// These methods are part of the File System Access API spec but may not be in all type definitions
declare global {
	interface FileSystemDirectoryHandle {
		keys(): AsyncIterableIterator<string>;
		values(): AsyncIterableIterator<FileSystemHandle>;
		entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
	}
}
