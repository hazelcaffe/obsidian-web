import { type ChangeListener, VfsCore, type VfsOptions } from "./core.ts";
import { createFsModule, type NodeFsModule } from "./fs-module.ts";
import type { BlobLike, OpfsFileHandle } from "./opfs-types.ts";

export type { ChangeEvent, ChangeListener, VfsOptions } from "./core.ts";
export { Dir } from "./dir.ts";
export type { Encoding, EncodingOption } from "./encoding.ts";
export type { FsError } from "./errors.ts";
export { FileHandle } from "./file-handle.ts";
export type { NodeFsModule } from "./fs-module.ts";
export type {
	BlobLike,
	OpfsDirectoryHandle,
	OpfsFile,
	OpfsFileHandle,
	OpfsWritable,
} from "./opfs-types.ts";
export type { PathLike } from "./path.ts";
export { Dirent, StatFs, Stats } from "./stats.ts";
export { ReadStream, WriteStream } from "./streams.ts";
export { FSWatcher, StatWatcher } from "./watch.ts";

/** A Node.js-compatible `fs` module backed by the Origin Private File System. */
export class Vfs {
	readonly fs: NodeFsModule;
	readonly #core: VfsCore;

	constructor(options: VfsOptions) {
		this.#core = new VfsCore(options);
		this.fs = createFsModule(this.#core);
	}

	/** Unique id of this instance (used to ignore its own broadcast messages). */
	get instanceId(): string {
		return this.#core.instanceId;
	}

	/** Build the in-memory tree from OPFS and the metadata sidecar. Must be awaited before use. */
	mount(): Promise<void> {
		return this.#core.mount();
	}

	/** Resolves once every pending change is persisted to OPFS (including the metadata sidecar). */
	flush(): Promise<void> {
		return this.#core.flush();
	}

	/** Stop cross-tab sync and timers. Pending writes still complete; call `flush()` first to wait for them. */
	close(): void {
		this.#core.dispose();
	}

	/** Whether the contents of `path` are cached, i.e. synchronous reads will not throw EAGAIN. */
	isLoaded(path: string): boolean {
		return this.#core.isLoaded(path);
	}

	/** Load the contents of a file (or every small file below a directory) into the cache. */
	preload(path: string): Promise<void> {
		return this.#core.preload(path);
	}

	/** Load the contents of files below `dirPath` (default: files up to `eagerLoadLimit`) and keep them cached. */
	preloadTree(dirPath: string, predicate?: (path: string, size: number) => boolean): Promise<void> {
		return this.#core.preloadTree(dirPath, predicate);
	}

	/**
	 * Subscribe to every change. Local changes are reported once persisted to OPFS (immediately for memory-only
	 * paths), remote ones once applied. Directory removals are reported once for the directory itself.
	 */
	onChange(listener: ChangeListener): () => void {
		return this.#core.onChange(listener);
	}

	/** The persisted OPFS handle of a file (after pending writes to it complete), or null. */
	getHandle(path: string): Promise<OpfsFileHandle | null> {
		return this.#core.getHandle(path);
	}

	/** Set a file's creation time (`birthtime`), like Electron's `btime` module. */
	setBirthtime(path: string, birthtimeMs: number): void {
		this.#core.setBirthtime(path, birthtimeMs);
	}

	/** Mount a read-only, never-persisted file whose contents are loaded lazily from `blob`. */
	registerVirtualFile(path: string, blob: BlobLike): void {
		this.#core.registerVirtualFile(path, blob);
	}
}

export async function createFs(options: VfsOptions): Promise<Vfs> {
	const vfs = new Vfs(options);
	await vfs.mount();
	return vfs;
}
