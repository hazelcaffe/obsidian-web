import type { BlobLike } from "./opfs-types.ts";

export type Patch =
	| { type: "write"; position: number; data: Uint8Array<ArrayBuffer> }
	| { type: "truncate"; size: number };

export interface NodeBase {
	ino: number;
	mode: number;
	uid: number;
	gid: number;
	atimeMs: number;
	mtimeMs: number;
	ctimeMs: number;
	birthtimeMs: number;
	parent: DirNode | null;
	name: string;
}

export interface DirNode extends NodeBase {
	kind: "dir";
	children: Map<string, FsNode>;
}

export interface FileNode extends NodeBase {
	kind: "file";
	size: number;
	/** Cached contents; may be larger than `size` (spare capacity). `null` when not loaded. */
	data: Uint8Array<ArrayBuffer> | null;
	/** Incremented whenever the contents are replaced wholesale, invalidating in-flight loads. */
	gen: number;
	loading: Promise<void> | null;
	/** Writes made while a load is in flight, replayed onto the loaded data. */
	loadPatches: Patch[] | null;
	/** Number of queued full-content writes that have not completed. */
	pendingWrites: number;
	/** Source of a virtual file's contents. */
	blob: BlobLike | null;
	/** Never persisted (virtual files). */
	volatile: boolean;
	/** When the contents were last written to OPFS (used to detect a stale metadata sidecar). */
	persistedAt: number;
	/** Explicitly preloaded: exempt from cache eviction while small. */
	resident: boolean;
}

export interface LinkNode extends NodeBase {
	kind: "symlink";
	target: string;
}

export type FsNode = DirNode | FileNode | LinkNode;
