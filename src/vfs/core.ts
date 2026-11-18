import {
	COPYFILE_EXCL,
	DEFAULT_DIR_MODE,
	DEFAULT_FILE_MODE,
	O_APPEND,
	O_CREAT,
	O_DIRECTORY,
	O_EXCL,
	O_NOFOLLOW,
	O_RDONLY,
	O_RDWR,
	O_TRUNC,
	O_WRONLY,
	R_OK,
	S_IFDIR,
	S_IFMT,
	S_IFREG,
	SYMLINK_MODE,
	UMASK,
	W_OK,
	X_OK,
} from "./constants.ts";
import { type ErrorCode, type FsError, fromDomError, fsError } from "./errors.ts";
import { type MetaRecord, parseMeta, serializeMeta } from "./meta.ts";
import type { DirNode, FileNode, FsNode, LinkNode, Patch } from "./nodes.ts";
import * as opfs from "./opfs.ts";
import {
	type BlobLike,
	isDirectoryHandle,
	isFileHandle,
	type OpfsDirectoryHandle,
	type OpfsFileHandle,
} from "./opfs-types.ts";
import {
	basename,
	dirname,
	isAncestor,
	isSameOrAncestor,
	joinPath,
	pathArg,
	relativeTo,
	resolvePath,
	splitPath,
} from "./path.ts";
import { PersistQueue } from "./queue.ts";
import { StatFs, Stats } from "./stats.ts";
import { StatWatcher, type WatchEventType } from "./watch.ts";

export interface VfsOptions {
	/** OPFS directory mirrored as "/". */
	root: OpfsDirectoryHandle;
	/** Directory holding the metadata sidecar (outside the mirrored tree). */
	metaDir: OpfsDirectoryHandle;
	/** Default "vfs-meta.json". */
	metaFileName?: string;
	/** Default "obsidian-web-vfs"; `null` disables cross-tab sync. */
	channelName?: string | null;
	/** Files up to this size are loaded on mount (default 1 MiB). */
	eagerLoadLimit?: number;
	/** Decides which files are loaded on mount (default: `size <= eagerLoadLimit`). */
	shouldEagerLoad?: (path: string, size: number) => boolean;
	/** Byte budget for evictable (lazily loaded) file contents (default 256 MiB). */
	lazyCacheLimit?: number;
	/** Path prefixes that live in memory only (default ["/tmp", "/proc", "/dev"]). */
	memoryOnlyPrefixes?: string[];
	cwd?: () => string;
	uid?: number;
	gid?: number;
}

export interface ChangeEvent {
	type: "create" | "modify" | "delete" | "rename";
	path: string;
	oldPath?: string;
	isDirectory: boolean;
	remote: boolean;
}

export type ChangeListener = (event: ChangeEvent) => void;

export interface OpenFile {
	node: FsNode;
	path: string;
	flags: number;
	readable: boolean;
	writable: boolean;
	append: boolean;
	position: number;
}

export interface DirEntry {
	/** Path relative to the listed directory. */
	relative: string;
	name: string;
	node: FsNode;
	/** Relative path of the containing directory ("" for direct children). */
	parentRelative: string;
}

interface Lookup {
	parent: DirNode | null;
	name: string;
	node: FsNode | null;
	/** Real (symlink-free) absolute path of the entry. */
	path: string;
}

interface Resolved {
	abs: string;
	display: string;
	dirOnly: boolean;
}

interface WatchTarget {
	path: string;
	recursive: boolean;
	/** Only events queued after the watcher was created are delivered. */
	since: number;
	emit: (eventType: WatchEventType, filename: string) => void;
}

interface StatWatchEntry {
	watcher: StatWatcher;
	prev: Stats;
}

interface NodeMeta {
	atimeMs: number;
	mtimeMs: number;
	ctimeMs: number;
	birthtimeMs: number;
	mode: number;
}

type RemoteOp =
	| { op: "write"; path: string; size: number; meta: NodeMeta; data?: Uint8Array<ArrayBuffer> }
	| { op: "mkdir"; path: string; meta: NodeMeta }
	| { op: "meta"; path: string; meta: NodeMeta }
	| { op: "symlink"; path: string; target: string; meta: NodeMeta }
	| { op: "remove"; path: string }
	| { op: "rename"; path: string; to: string };

type RemoteMessage = RemoteOp & { id: string };

type ErrorFactory = (code: ErrorCode) => FsError;

const MAX_SYMLINKS = 40;
const DEV = 2049;
const LOAD_CONCURRENCY = 16;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNodeMeta(value: unknown): value is NodeMeta {
	return (
		isObject(value) &&
		typeof value.mtimeMs === "number" &&
		typeof value.ctimeMs === "number" &&
		typeof value.birthtimeMs === "number" &&
		typeof value.atimeMs === "number" &&
		typeof value.mode === "number"
	);
}

function isRemoteMessage(value: unknown): value is RemoteMessage {
	if (!isObject(value) || typeof value.id !== "string" || typeof value.path !== "string") {
		return false;
	}
	switch (value.op) {
		case "write":
			return (
				typeof value.size === "number" &&
				isNodeMeta(value.meta) &&
				(value.data === undefined || value.data instanceof Uint8Array)
			);
		case "mkdir":
		case "meta":
			return isNodeMeta(value.meta);
		case "symlink":
			return typeof value.target === "string" && isNodeMeta(value.meta);
		case "remove":
			return true;
		case "rename":
			return typeof value.to === "string";
		default:
			return false;
	}
}

function limiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async (task) => {
		if (active >= concurrency) {
			await new Promise<void>((resolve) => waiting.push(resolve));
		} else {
			active++;
		}
		try {
			return await task();
		} finally {
			const next = waiting.shift();
			if (next) {
				next();
			} else {
				active--;
			}
		}
	};
}

function applyPatch(data: Uint8Array<ArrayBuffer>, patch: Patch): Uint8Array<ArrayBuffer> {
	if (patch.type === "truncate") {
		return resize(data, patch.size);
	}
	const end = patch.position + patch.data.byteLength;
	const out = end > data.byteLength ? resize(data, end) : data;
	out.set(patch.data, patch.position);
	return out;
}

function resize(data: Uint8Array<ArrayBuffer>, size: number): Uint8Array<ArrayBuffer> {
	if (size === data.byteLength) {
		return data;
	}
	if (size < data.byteLength) {
		return data.slice(0, size);
	}
	const out = new Uint8Array(size);
	out.set(data);
	return out;
}

function randomId(): string {
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class VfsCore {
	readonly root: OpfsDirectoryHandle;
	readonly metaDir: OpfsDirectoryHandle;
	readonly metaFileName: string;
	readonly channelName: string | null;
	readonly eagerLoadLimit: number;
	readonly lazyCacheLimit: number;
	readonly memoryOnlyPrefixes: readonly string[];
	readonly uid: number;
	readonly gid: number;
	readonly cwd: () => string;
	readonly queue = new PersistQueue(8);
	readonly instanceId = randomId();
	readonly #shouldEagerLoad: (path: string, size: number) => boolean;

	tree: DirNode;
	#nextIno = 2;
	#lastTime = 0;
	#mounted = false;
	#mountPromise: Promise<void> | null = null;
	#closed = false;

	#collector: Promise<void>[] | null = null;
	readonly #missing = new WeakMap<object, FileNode>();
	readonly #pinned = new Map<FileNode, number>();
	readonly #lru = new Map<FileNode, number>();
	#lruBytes = 0;

	readonly #fds = new Map<number, OpenFile>();

	readonly #watchers = new Set<WatchTarget>();
	readonly #statWatchers = new Map<string, StatWatchEntry>();
	readonly #changeListeners = new Set<ChangeListener>();
	#pendingEvents: Array<[WatchEventType, string, number]> = [];
	#eventSeq = 0;
	#flushScheduled = false;

	#channel: { postMessage(message: unknown): void; close(): void } | null = null;
	#bufferedRemote: RemoteMessage[] = [];

	#metaDirty = false;
	#metaTimer: ReturnType<typeof setTimeout> | null = null;
	#metaWriting: Promise<void> | null = null;

	constructor(options: VfsOptions) {
		this.root = options.root;
		this.metaDir = options.metaDir;
		this.metaFileName = options.metaFileName ?? "vfs-meta.json";
		this.channelName = options.channelName === undefined ? "obsidian-web-vfs" : options.channelName;
		this.eagerLoadLimit = options.eagerLoadLimit ?? 1024 * 1024;
		this.lazyCacheLimit = options.lazyCacheLimit ?? 256 * 1024 * 1024;
		const limit = this.eagerLoadLimit;
		this.#shouldEagerLoad = options.shouldEagerLoad ?? ((_path, size) => size <= limit);
		this.memoryOnlyPrefixes = (options.memoryOnlyPrefixes ?? ["/tmp", "/proc", "/dev"]).map((prefix) =>
			resolvePath("/", prefix),
		);
		this.uid = options.uid ?? 1000;
		this.gid = options.gid ?? 1000;
		this.cwd = options.cwd ?? (() => "/");
		this.tree = this.#newDir(DEFAULT_DIR_MODE, this.#now());
	}

	// ---------------------------------------------------------------- paths & lookup

	resolve(path: unknown, syscall: string, argName = "path"): Resolved {
		const display = pathArg(path, argName);
		if (display === "") {
			throw fsError("ENOENT", syscall, display);
		}
		const abs = resolvePath(this.cwd(), display);
		const dirOnly = abs !== "/" && /\/\.?$/.test(display);
		return { abs, display, dirOnly };
	}

	#lookup(abs: string, follow: boolean, err: ErrorFactory): Lookup {
		let parts = splitPath(abs);
		if (parts.length === 0) {
			return { parent: null, name: "", node: this.tree, path: "/" };
		}
		let dir = this.tree;
		let dirPath = "/";
		let links = 0;
		let index = 0;
		for (;;) {
			const name = parts[index];
			if (name === undefined) {
				return { parent: dir.parent, name: dir.name, node: dir, path: dirPath };
			}
			const last = index === parts.length - 1;
			if (name === "..") {
				if (dir.parent) {
					dir = dir.parent;
					dirPath = dirname(dirPath);
				}
				index++;
				continue;
			}
			const child = dir.children.get(name);
			const childPath = joinPath(dirPath, name);
			if (!child) {
				if (last) {
					return { parent: dir, name, node: null, path: childPath };
				}
				throw err("ENOENT");
			}
			if (child.kind === "symlink" && (!last || follow)) {
				if (++links > MAX_SYMLINKS) {
					throw err("ELOOP");
				}
				if (child.target === "") {
					throw err("ENOENT");
				}
				if (child.target.startsWith("/")) {
					dir = this.tree;
					dirPath = "/";
				}
				parts = [...splitPath(child.target), ...parts.slice(index + 1)];
				index = 0;
				continue;
			}
			if (last) {
				return { parent: dir, name, node: child, path: childPath };
			}
			if (child.kind !== "dir") {
				throw err("ENOTDIR");
			}
			dir = child;
			dirPath = childPath;
			index++;
		}
	}

	/** Resolve a path argument and look it up. */
	#find(path: unknown, syscall: string, follow: boolean): Lookup & Resolved & { err: ErrorFactory } {
		const resolved = this.resolve(path, syscall);
		const err: ErrorFactory = (code) => fsError(code, syscall, resolved.display);
		const lookup = this.#lookup(resolved.abs, follow || resolved.dirOnly, err);
		if (resolved.dirOnly && lookup.node && lookup.node.kind !== "dir") {
			throw err("ENOTDIR");
		}
		return { ...lookup, ...resolved, err };
	}

	#existing(path: unknown, syscall: string, follow: boolean): { node: FsNode; path: string; display: string } {
		const found = this.#find(path, syscall, follow);
		if (!found.node) {
			throw found.err("ENOENT");
		}
		return { node: found.node, path: found.path, display: found.display };
	}

	/** Node at a real path without following symlinks. */
	#nodeAt(path: string, tree: DirNode = this.tree): FsNode | null {
		let node: FsNode = tree;
		for (const segment of splitPath(path)) {
			if (node.kind !== "dir") {
				return null;
			}
			const child = node.children.get(segment);
			if (!child) {
				return null;
			}
			node = child;
		}
		return node;
	}

	pathOf(node: FsNode): string | null {
		const names: string[] = [];
		let current: FsNode = node;
		while (current !== this.tree) {
			if (!current.parent) {
				return null;
			}
			names.push(current.name);
			current = current.parent;
		}
		return `/${names.reverse().join("/")}`;
	}

	isMemoryOnly(path: string): boolean {
		return this.memoryOnlyPrefixes.some((prefix) => isSameOrAncestor(prefix, path));
	}

	#inOpfs(node: FsNode, path: string): boolean {
		if (this.isMemoryOnly(path)) {
			return false;
		}
		return node.kind === "dir" || (node.kind === "file" && !node.volatile);
	}

	// ---------------------------------------------------------------- nodes

	#now(): number {
		const now = Date.now();
		this.#lastTime = now > this.#lastTime ? now : this.#lastTime + 0.001;
		return this.#lastTime;
	}

	#base(mode: number, now: number) {
		return {
			ino: this.#nextIno++,
			mode,
			uid: this.uid,
			gid: this.gid,
			atimeMs: now,
			mtimeMs: now,
			ctimeMs: now,
			birthtimeMs: now,
			parent: null,
			name: "",
		};
	}

	#newDir(mode: number, now: number): DirNode {
		return { ...this.#base(mode, now), kind: "dir", children: new Map() };
	}

	#newFile(mode: number, now: number, data: Uint8Array<ArrayBuffer> | null, size = data?.byteLength ?? 0): FileNode {
		return {
			...this.#base(mode, now),
			kind: "file",
			size,
			data,
			gen: 0,
			loading: null,
			loadPatches: null,
			pendingWrites: 0,
			blob: null,
			volatile: false,
			persistedAt: now,
			resident: false,
		};
	}

	#newLink(target: string, now: number): LinkNode {
		return { ...this.#base(SYMLINK_MODE, now), kind: "symlink", target };
	}

	#attach(parent: DirNode, name: string, node: FsNode, now: number | null): void {
		parent.children.set(name, node);
		node.parent = parent;
		node.name = name;
		if (now !== null) {
			parent.mtimeMs = now;
			parent.ctimeMs = now;
		}
	}

	#detach(node: FsNode, now: number | null): void {
		const parent = node.parent;
		if (parent && parent.children.get(node.name) === node) {
			parent.children.delete(node.name);
			if (now !== null) {
				parent.mtimeMs = now;
				parent.ctimeMs = now;
			}
		}
		node.parent = null;
	}

	/** Detach a subtree, release its cached contents and return its paths (deepest first) for events. */
	#removeSubtree(node: FsNode, path: string, now: number | null): string[] {
		const paths: string[] = [];
		const visit = (current: FsNode, currentPath: string): void => {
			if (current.kind === "dir") {
				for (const [name, child] of current.children) {
					visit(child, joinPath(currentPath, name));
				}
			} else if (current.kind === "file") {
				this.#untrack(current);
			}
			paths.push(currentPath);
		};
		visit(node, path);
		this.#detach(node, now);
		return paths;
	}

	#forEachFile(node: FsNode, fn: (file: FileNode) => void): void {
		if (node.kind === "file") {
			fn(node);
		} else if (node.kind === "dir") {
			for (const child of node.children.values()) {
				this.#forEachFile(child, fn);
			}
		}
	}

	#metaOf(node: FsNode): NodeMeta {
		return {
			atimeMs: node.atimeMs,
			mtimeMs: node.mtimeMs,
			ctimeMs: node.ctimeMs,
			birthtimeMs: node.birthtimeMs,
			mode: node.mode,
		};
	}

	#applyMeta(node: FsNode, meta: NodeMeta): void {
		node.atimeMs = meta.atimeMs;
		node.mtimeMs = meta.mtimeMs;
		node.ctimeMs = meta.ctimeMs;
		node.birthtimeMs = meta.birthtimeMs;
		if ((meta.mode & S_IFMT) === (node.mode & S_IFMT)) {
			node.mode = meta.mode;
		}
	}

	statNode(node: FsNode): Stats {
		let size = 0;
		let blocks = 0;
		let nlink = 1;
		if (node.kind === "file") {
			size = node.size;
			blocks = Math.ceil(size / 4096) * 8;
		} else if (node.kind === "dir") {
			size = 4096;
			blocks = 8;
			nlink = 2;
			for (const child of node.children.values()) {
				if (child.kind === "dir") {
					nlink++;
				}
			}
		} else {
			size = new TextEncoder().encode(node.target).byteLength;
		}
		return new Stats({
			dev: DEV,
			ino: node.ino,
			mode: node.mode,
			nlink,
			uid: node.uid,
			gid: node.gid,
			rdev: 0,
			size,
			blksize: 4096,
			blocks,
			atimeMs: node.atimeMs,
			mtimeMs: node.mtimeMs,
			ctimeMs: node.ctimeMs,
			birthtimeMs: node.birthtimeMs,
		});
	}

	#checkAccess(node: FsNode, mode: number, err: ErrorFactory): void {
		if (node.kind === "symlink") {
			return;
		}
		if (
			((mode & R_OK) !== 0 && (node.mode & 0o400) === 0) ||
			((mode & W_OK) !== 0 && (node.mode & 0o200) === 0) ||
			((mode & X_OK) !== 0 && (node.mode & 0o100) === 0)
		) {
			throw err("EACCES");
		}
	}

	// ---------------------------------------------------------------- persistence

	#enqueue(paths: string[], label: string, run: () => Promise<void>, coalesceKey?: unknown): boolean {
		const { promise, coalesced } = this.queue.enqueue(paths, run, coalesceKey);
		if (!coalesced) {
			promise.catch((error: unknown) => console.error(`[vfs] failed to persist ${label}:`, error));
		}
		this.#collector?.push(promise);
		return coalesced;
	}

	#post(message: RemoteOp): void {
		if (this.#channel && !this.#closed) {
			this.#channel.postMessage({ ...message, id: this.instanceId });
		}
	}

	#persistContent(node: FileNode, path: string): void {
		if (node.volatile || this.isMemoryOnly(path)) {
			return;
		}
		const coalesced = this.#enqueue(
			[path],
			`write ${path}`,
			async () => {
				try {
					const data = node.data;
					if (!data) {
						return;
					}
					const snapshot = data.slice(0, node.size);
					const meta = this.#metaOf(node);
					await opfs.writeFile(this.root, path, snapshot).catch((error: unknown) => {
						throw fromDomError(error, "write", path);
					});
					node.persistedAt = Date.now();
					this.#markMeta();
					// Small contents travel with the message so other tabs never read a path that has changed since.
					this.#post({
						op: "write",
						path,
						size: snapshot.byteLength,
						meta,
						data: snapshot.byteLength <= this.eagerLoadLimit ? snapshot : undefined,
					});
				} finally {
					node.pendingWrites--;
					this.#trackContent(node);
				}
			},
			node,
		);
		if (!coalesced) {
			node.pendingWrites++;
		}
	}

	#persistPatch(node: FileNode, path: string, patch: Patch): void {
		this.#enqueue([path], `write ${path}`, async () => {
			await opfs.patchFile(this.root, path, patch).catch((error: unknown) => {
				throw fromDomError(error, "write", path);
			});
			node.persistedAt = Date.now();
			this.#markMeta();
			this.#post({ op: "write", path, size: node.size, meta: this.#metaOf(node) });
		});
	}

	#persistMkdir(node: DirNode, path: string): void {
		if (this.isMemoryOnly(path)) {
			return;
		}
		this.#enqueue([path], `mkdir ${path}`, async () => {
			await opfs.makeDirectory(this.root, path).catch((error: unknown) => {
				throw fromDomError(error, "mkdir", path);
			});
			this.#post({ op: "mkdir", path, meta: this.#metaOf(node) });
		});
	}

	/** Persist a whole subtree that was not in OPFS before (moved in from a memory-only location). */
	#persistSubtree(node: FsNode, path: string): void {
		if (node.kind === "dir") {
			this.#persistMkdir(node, path);
			for (const [name, child] of node.children) {
				this.#persistSubtree(child, joinPath(path, name));
			}
		} else if (node.kind === "file") {
			node.volatile = false;
			node.blob = null;
			this.#persistContent(node, path);
		} else {
			this.#persistSymlink(node, path);
		}
	}

	#persistSymlink(node: LinkNode, path: string): void {
		if (this.isMemoryOnly(path)) {
			return;
		}
		this.#markMeta();
		this.#enqueue([path], `symlink ${path}`, async () => {
			this.#post({ op: "symlink", path, target: node.target, meta: this.#metaOf(node) });
		});
	}

	#persistRemove(node: FsNode, path: string): void {
		if (this.isMemoryOnly(path)) {
			return;
		}
		this.#markMeta();
		const inOpfs = this.#inOpfs(node, path);
		if (!inOpfs && node.kind === "file") {
			return;
		}
		this.#enqueue([path], `remove ${path}`, async () => {
			if (inOpfs) {
				await opfs.removeEntry(this.root, path).catch((error: unknown) => {
					throw fromDomError(error, "rm", path);
				});
			}
			this.#post({ op: "remove", path });
		});
	}

	#persistMeta(node: FsNode, path: string): void {
		if (this.isMemoryOnly(path) || (node.kind === "file" && node.volatile)) {
			return;
		}
		this.#markMeta();
		this.#enqueue([path], `metadata ${path}`, async () => {
			this.#post({ op: "meta", path, meta: this.#metaOf(node) });
		});
	}

	#markMeta(): void {
		this.#metaDirty = true;
		if (this.#metaTimer === null && this.#mounted && !this.#closed) {
			this.#metaTimer = setTimeout(() => {
				this.#metaTimer = null;
				void this.#writeMeta();
			}, 300);
		}
	}

	#writeMeta(): Promise<void> {
		if (!this.#metaWriting) {
			this.#metaWriting = (async () => {
				while (this.#metaDirty) {
					this.#metaDirty = false;
					try {
						await opfs.writeText(this.metaDir, this.metaFileName, this.#serializeMeta());
					} catch (error) {
						console.error("[vfs] failed to write metadata:", error);
					}
				}
			})().finally(() => {
				this.#metaWriting = null;
			});
		}
		return this.#metaWriting;
	}

	#serializeMeta(): string {
		const entries: Record<string, MetaRecord> = {};
		const symlinks: Record<string, string> = {};
		const visit = (node: FsNode, path: string): void => {
			if (this.isMemoryOnly(path)) {
				return;
			}
			if (node.kind === "symlink") {
				symlinks[path] = node.target;
				return;
			}
			if (node.kind === "file") {
				if (!node.volatile) {
					entries[path] = [node.mtimeMs, node.ctimeMs, node.birthtimeMs, node.mode, node.persistedAt];
				}
				return;
			}
			entries[path] = [node.mtimeMs, node.ctimeMs, node.birthtimeMs, node.mode];
			for (const [name, child] of node.children) {
				visit(child, joinPath(path, name));
			}
		};
		visit(this.tree, "/");
		return serializeMeta(entries, symlinks);
	}

	async flush(): Promise<void> {
		await this.queue.drain();
		if (this.#metaTimer !== null) {
			clearTimeout(this.#metaTimer);
			this.#metaTimer = null;
		}
		await this.#writeMeta();
		await this.queue.drain();
	}

	// ---------------------------------------------------------------- contents

	/** Contents of `node`, or throws EAGAIN (and starts loading it). */
	requireContent(node: FileNode, syscall: string, display?: string): Uint8Array<ArrayBuffer> {
		if (node.data) {
			this.#touch(node);
			return node.data;
		}
		const error = fsError(
			"EAGAIN",
			syscall,
			display,
			undefined,
			"file contents are still being loaded from storage; retry later or use the async API",
		);
		this.#missing.set(error, node);
		this.load(node).catch(() => {});
		throw error;
	}

	load(node: FileNode): Promise<void> {
		if (node.data) {
			return Promise.resolve();
		}
		if (node.loading) {
			return node.loading;
		}
		let source: () => Promise<Uint8Array<ArrayBuffer>>;
		const blob = node.blob;
		if (blob) {
			source = async () => new Uint8Array(await blob.arrayBuffer());
		} else {
			const path = this.pathOf(node);
			if (path === null || node.volatile || this.isMemoryOnly(path)) {
				return Promise.reject(
					fsError("EIO", "read", path ?? undefined, undefined, "file contents are no longer available"),
				);
			}
			source = () =>
				new Promise((resolve, reject) => {
					this.queue.enqueue([path], async () => {
						try {
							resolve(await opfs.readFile(this.root, path));
						} catch (error) {
							reject(fromDomError(error, "read", path));
						}
					});
				});
		}
		const gen = node.gen;
		node.loadPatches = [];
		let loading: Promise<void> | undefined;
		loading = (async () => {
			try {
				const loaded = await source();
				if (node.gen !== gen || node.data) {
					return;
				}
				let data = loaded;
				for (const patch of node.loadPatches ?? []) {
					data = applyPatch(data, patch);
				}
				node.data = resize(data, node.size);
				this.#trackContent(node);
			} finally {
				if (node.loading === loading) {
					node.loading = null;
					node.loadPatches = null;
				}
			}
		})();
		node.loading = loading;
		return loading;
	}

	#pin(node: FileNode): void {
		this.#pinned.set(node, (this.#pinned.get(node) ?? 0) + 1);
	}

	#unpin(node: FileNode): void {
		const count = (this.#pinned.get(node) ?? 1) - 1;
		if (count > 0) {
			this.#pinned.set(node, count);
		} else {
			this.#pinned.delete(node);
			this.#evict();
		}
	}

	#isResident(node: FileNode, path: string): boolean {
		if (!node.blob && (node.volatile || this.isMemoryOnly(path))) {
			return true;
		}
		return node.size <= this.eagerLoadLimit && (node.resident || this.#shouldEagerLoad(path, node.size));
	}

	#trackContent(node: FileNode): void {
		this.#untrack(node);
		if (!node.data) {
			return;
		}
		const path = this.pathOf(node);
		if (path === null || this.#isResident(node, path)) {
			return;
		}
		this.#lru.set(node, node.data.byteLength);
		this.#lruBytes += node.data.byteLength;
		this.#evict();
	}

	#untrack(node: FileNode): void {
		const bytes = this.#lru.get(node);
		if (bytes !== undefined) {
			this.#lru.delete(node);
			this.#lruBytes -= bytes;
		}
	}

	#touch(node: FileNode): void {
		const bytes = this.#lru.get(node);
		if (bytes !== undefined) {
			this.#lru.delete(node);
			this.#lru.set(node, bytes);
		}
	}

	#evict(): void {
		if (this.#lruBytes <= this.lazyCacheLimit) {
			return;
		}
		for (const [node, bytes] of this.#lru) {
			if (this.#lruBytes <= this.lazyCacheLimit) {
				break;
			}
			if (node.pendingWrites > 0 || node.loading || this.#pinned.has(node) || this.#hasOpenFd(node)) {
				continue;
			}
			node.data = null;
			this.#lru.delete(node);
			this.#lruBytes -= bytes;
		}
	}

	#hasOpenFd(node: FileNode): boolean {
		for (const file of this.#fds.values()) {
			if (file.node === node) {
				return true;
			}
		}
		return false;
	}

	/** Run a core operation, loading missing file contents and waiting for persistence. */
	async run<T>(fn: () => T): Promise<T> {
		const pinned: FileNode[] = [];
		try {
			for (let attempt = 0; ; attempt++) {
				const collector: Promise<void>[] = [];
				const previous = this.#collector;
				this.#collector = collector;
				let missing: FileNode | undefined;
				let result: { value: T } | undefined;
				try {
					result = { value: fn() };
				} catch (error) {
					missing = isObject(error) ? this.#missing.get(error) : undefined;
					if (!missing || attempt > 100) {
						throw error;
					}
				} finally {
					this.#collector = previous;
				}
				if (result) {
					await Promise.all(collector);
					return result.value;
				}
				if (missing) {
					this.#pin(missing);
					pinned.push(missing);
					await this.load(missing);
				}
			}
		} finally {
			for (const node of pinned) {
				this.#unpin(node);
			}
		}
	}

	// ---------------------------------------------------------------- content mutation

	#touchTimes(node: FsNode, now: number): void {
		node.mtimeMs = now;
		node.ctimeMs = now;
	}

	#ensureCapacity(node: FileNode, data: Uint8Array<ArrayBuffer>, size: number): Uint8Array<ArrayBuffer> {
		if (data.byteLength >= size) {
			return data;
		}
		const grown = new Uint8Array(Math.max(size, Math.floor(data.byteLength * 1.5)));
		grown.set(data.subarray(0, node.size));
		node.data = grown;
		return grown;
	}

	/** Content checks that must run before any mutation of a write operation. */
	#prepareWrite(node: FileNode, path: string | null, syscall: string, display?: string): void {
		if (!node.data && (node.blob || node.volatile || path === null || this.isMemoryOnly(path))) {
			this.requireContent(node, syscall, display);
		}
	}

	#replaceContent(node: FileNode, data: Uint8Array<ArrayBuffer>, path: string | null, now: number): void {
		node.data = data;
		node.size = data.byteLength;
		node.gen++;
		node.loading = null;
		node.loadPatches = null;
		node.blob = null;
		this.#touchTimes(node, now);
		if (path !== null) {
			this.#persistContent(node, path);
		}
		this.#trackContent(node);
	}

	#writeAt(node: FileNode, position: number, bytes: Uint8Array, path: string | null, now: number): void {
		const end = position + bytes.byteLength;
		if (node.data) {
			const data = this.#ensureCapacity(node, node.data, end);
			data.set(bytes, position);
			if (end > node.size) {
				node.size = end;
			}
			node.blob = null;
			if (path !== null) {
				this.#persistContent(node, path);
			}
		} else if (path !== null) {
			if (end > node.size) {
				node.size = end;
			}
			const copy = new Uint8Array(bytes.byteLength);
			copy.set(bytes);
			const patch: Patch = { type: "write", position, data: copy };
			node.loadPatches?.push(patch);
			this.#persistPatch(node, path, patch);
		}
		this.#touchTimes(node, now);
		this.#trackContent(node);
	}

	#truncateNode(node: FileNode, length: number, path: string | null, now: number): void {
		if (length === 0 && !node.data) {
			this.#replaceContent(node, new Uint8Array(0), path, now);
			return;
		}
		if (node.data) {
			if (length < node.size) {
				node.data.fill(0, length, node.size);
			} else {
				this.#ensureCapacity(node, node.data, length);
			}
			node.size = length;
			node.blob = null;
			if (path !== null) {
				this.#persistContent(node, path);
			}
		} else if (path !== null) {
			node.size = length;
			const patch: Patch = { type: "truncate", size: length };
			node.loadPatches?.push(patch);
			this.#persistPatch(node, path, patch);
		}
		this.#touchTimes(node, now);
		this.#trackContent(node);
	}

	#createFile(parent: DirNode, name: string, path: string, mode: number, data: Uint8Array<ArrayBuffer>): FileNode {
		const now = this.#now();
		const node = this.#newFile(S_IFREG | (mode & 0o7777), now, data);
		this.#attach(parent, name, node, now);
		this.#persistContent(node, path);
		this.#trackContent(node);
		this.#notify([["rename", path]], { type: "create", path, isDirectory: false, remote: false });
		return node;
	}

	#notifyModified(node: FsNode, path: string | null): void {
		if (path !== null) {
			this.#notify([["change", path]], { type: "modify", path, isDirectory: node.kind === "dir", remote: false });
		}
	}

	// ---------------------------------------------------------------- events

	onChange(listener: ChangeListener): () => void {
		this.#changeListeners.add(listener);
		return () => {
			this.#changeListeners.delete(listener);
		};
	}

	#notify(events: Array<[WatchEventType, string]>, change: ChangeEvent | null): void {
		for (const [eventType, path] of events) {
			const last = this.#pendingEvents.at(-1);
			if (!last || last[0] !== eventType || last[1] !== path) {
				this.#pendingEvents.push([eventType, path, ++this.#eventSeq]);
			}
		}
		if (!this.#flushScheduled) {
			this.#flushScheduled = true;
			queueMicrotask(() => this.#flushEvents());
		}
		if (change && this.#changeListeners.size > 0) {
			const persisted = change.remote
				? Promise.resolve()
				: Promise.all([
						this.queue.barrier(change.path),
						change.oldPath === undefined ? undefined : this.queue.barrier(change.oldPath),
					]);
			void persisted.then(() => {
				for (const listener of this.#changeListeners) {
					try {
						listener(change);
					} catch (error) {
						console.error("[vfs] change listener failed:", error);
					}
				}
			});
		}
	}

	#flushEvents(): void {
		this.#flushScheduled = false;
		const events = this.#pendingEvents;
		this.#pendingEvents = [];
		for (const [eventType, path, seq] of events) {
			for (const watcher of this.#watchers) {
				if (seq <= watcher.since) {
					continue;
				}
				let filename: string;
				if (path === watcher.path) {
					filename = basename(path);
				} else if (isAncestor(watcher.path, path)) {
					filename = relativeTo(watcher.path, path);
					if (!watcher.recursive && filename.includes("/")) {
						continue;
					}
				} else {
					continue;
				}
				try {
					watcher.emit(eventType, filename);
				} catch (error) {
					console.error("[vfs] watch listener failed:", error);
				}
			}
		}
		for (const [path, entry] of this.#statWatchers) {
			const current = this.#statOrEmpty(path);
			const prev = entry.prev;
			if (
				current.mtimeMs !== prev.mtimeMs ||
				current.ctimeMs !== prev.ctimeMs ||
				current.size !== prev.size ||
				current.ino !== prev.ino ||
				current.mode !== prev.mode ||
				current.nlink !== prev.nlink
			) {
				entry.prev = current;
				entry.watcher.emit("change", current, prev);
			}
		}
	}

	#statOrEmpty(abs: string): Stats {
		try {
			const node = this.#lookup(abs, true, (code) => fsError(code, "stat", abs)).node;
			return node ? this.statNode(node) : new Stats();
		} catch {
			return new Stats();
		}
	}

	watch(path: unknown, recursive: boolean, emit: WatchTarget["emit"]): () => void {
		const found = this.#existing(path, "watch", true);
		const target: WatchTarget = { path: found.path, recursive, since: this.#eventSeq, emit };
		this.#watchers.add(target);
		return () => {
			this.#watchers.delete(target);
		};
	}

	watchFile(path: unknown): StatWatcher {
		const { abs } = this.resolve(path, "watch");
		let entry = this.#statWatchers.get(abs);
		if (!entry) {
			entry = { watcher: new StatWatcher(), prev: this.#statOrEmpty(abs) };
			this.#statWatchers.set(abs, entry);
		}
		return entry.watcher;
	}

	unwatchFile(path: unknown, listener?: (current: Stats, previous: Stats) => void): void {
		const { abs } = this.resolve(path, "watch");
		const entry = this.#statWatchers.get(abs);
		if (!entry) {
			return;
		}
		if (listener) {
			entry.watcher.removeListener("change", listener);
		} else {
			entry.watcher.removeAllListeners("change");
		}
		if (entry.watcher.listenerCount("change") === 0) {
			this.#statWatchers.delete(abs);
			entry.watcher.emit("stop");
		}
	}

	// ---------------------------------------------------------------- mount

	mount(): Promise<void> {
		this.#mountPromise ??= this.#mount();
		return this.#mountPromise;
	}

	async #mount(): Promise<void> {
		if (this.channelName !== null && typeof BroadcastChannel !== "undefined") {
			const channel = new BroadcastChannel(this.channelName);
			channel.onmessage = (event: unknown) => {
				if (isObject(event)) {
					this.#onMessage(event.data);
				}
			};
			if ("unref" in channel && typeof channel.unref === "function") {
				channel.unref();
			}
			this.#channel = channel;
		}
		const now = Date.now();
		const tree = this.#newDir(DEFAULT_DIR_MODE, now);
		const sameDir = this.root === this.metaDir || ((await this.root.isSameEntry?.(this.metaDir)) ?? false);
		const skipName = sameDir ? this.metaFileName : null;
		const limit = limiter(LOAD_CONCURRENCY);
		const fileTasks: Promise<void>[] = [];
		const fileTimes = new Map<FileNode, number>();

		const walk = async (handle: OpfsDirectoryHandle, dir: DirNode, dirPath: string): Promise<void> => {
			const subdirs: Promise<void>[] = [];
			for await (const entry of opfs.listEntries(handle)) {
				const name = entry.name;
				const path = joinPath(dirPath, name);
				if (name === "." || name === ".." || (dir === tree && name === skipName) || this.isMemoryOnly(path)) {
					continue;
				}
				if (isDirectoryHandle(entry)) {
					const node = this.#newDir(DEFAULT_DIR_MODE, now);
					this.#attach(dir, name, node, null);
					subdirs.push(walk(entry, node, path));
				} else if (isFileHandle(entry)) {
					const node = this.#newFile(DEFAULT_FILE_MODE, now, null);
					this.#attach(dir, name, node, null);
					fileTasks.push(
						limit(async () => {
							try {
								const file = await entry.getFile();
								node.size = file.size;
								fileTimes.set(node, file.lastModified);
								if (this.#shouldEagerLoad(path, file.size)) {
									node.data = new Uint8Array(await file.arrayBuffer());
									node.size = node.data.byteLength;
								}
							} catch (error) {
								console.warn(`[vfs] skipping unreadable file ${path}:`, error);
								this.#detach(node, null);
							}
						}),
					);
				}
			}
			await Promise.all(subdirs);
		};
		await walk(this.root, tree, "/");
		await Promise.all(fileTasks);

		let text: string | null = null;
		try {
			text = await opfs.readText(this.metaDir, this.metaFileName);
		} catch (error) {
			console.warn("[vfs] failed to read metadata:", error);
		}
		const meta = parseMeta(text);
		const applyTimes = (node: FsNode, path: string): number => {
			const record = meta.entries.get(path);
			if (node.kind === "file") {
				const lastModified = fileTimes.get(node) ?? now;
				node.mtimeMs = node.ctimeMs = node.atimeMs = node.birthtimeMs = lastModified;
				node.persistedAt = lastModified;
				if (record) {
					const [mtimeMs, ctimeMs, birthtimeMs, mode, persistedAt] = record;
					const stale = persistedAt !== undefined && lastModified > persistedAt + 2000;
					if (!stale) {
						node.mtimeMs = node.atimeMs = mtimeMs;
						node.ctimeMs = ctimeMs;
						node.persistedAt = persistedAt ?? lastModified;
					}
					node.birthtimeMs = Math.min(birthtimeMs, node.mtimeMs);
					if ((mode & S_IFMT) === S_IFREG) {
						node.mode = mode;
					}
				}
				return node.mtimeMs;
			}
			if (node.kind !== "dir") {
				return 0;
			}
			let newest = 0;
			for (const [name, child] of node.children) {
				newest = Math.max(newest, applyTimes(child, joinPath(path, name)));
			}
			if (record) {
				const [mtimeMs, ctimeMs, birthtimeMs, mode] = record;
				node.mtimeMs = node.atimeMs = mtimeMs;
				node.ctimeMs = ctimeMs;
				node.birthtimeMs = birthtimeMs;
				if ((mode & S_IFMT) === S_IFDIR) {
					node.mode = mode;
				}
			} else {
				const time = newest || now;
				node.mtimeMs = node.ctimeMs = node.atimeMs = node.birthtimeMs = time;
			}
			return node.mtimeMs;
		};
		applyTimes(tree, "/");
		for (const [path, target] of meta.symlinks) {
			const parent = this.#nodeAt(dirname(path), tree);
			const name = basename(path);
			if (parent?.kind !== "dir" || parent.children.has(name) || this.isMemoryOnly(path) || !name) {
				continue;
			}
			const link = this.#newLink(target, now);
			const record = meta.entries.get(path);
			if (record) {
				link.mtimeMs = link.atimeMs = record[0];
				link.ctimeMs = record[1];
				link.birthtimeMs = record[2];
			}
			this.#attach(parent, name, link, null);
		}

		this.tree = tree;
		for (const prefix of this.memoryOnlyPrefixes) {
			let dir = tree;
			for (const segment of splitPath(prefix)) {
				let child = dir.children.get(segment);
				if (child?.kind !== "dir") {
					child = this.#newDir(prefix === "/tmp" ? S_IFDIR | 0o1777 : DEFAULT_DIR_MODE, now);
					this.#attach(dir, segment, child, null);
				}
				dir = child;
			}
		}
		this.#mounted = true;
		const buffered = this.#bufferedRemote;
		this.#bufferedRemote = [];
		for (const message of buffered) {
			this.#onMessage(message);
		}
	}

	dispose(): void {
		this.#closed = true;
		this.#channel?.close();
		this.#channel = null;
		if (this.#metaTimer !== null) {
			clearTimeout(this.#metaTimer);
			this.#metaTimer = null;
		}
		this.#watchers.clear();
		this.#statWatchers.clear();
	}

	// ---------------------------------------------------------------- remote changes

	#onMessage(data: unknown): void {
		if (!isRemoteMessage(data) || data.id === this.instanceId || this.#closed) {
			return;
		}
		if (!this.#mounted) {
			this.#bufferedRemote.push(data);
			return;
		}
		try {
			this.#applyRemote(data);
			// Every tab keeps the sidecar current in case the originating tab closes before writing it.
			this.#markMeta();
		} catch (error) {
			console.error("[vfs] failed to apply remote change:", error);
		}
	}

	#ensureDirRemote(path: string, now: number): DirNode | null {
		let dir = this.tree;
		let dirPath = "/";
		for (const segment of splitPath(path)) {
			dirPath = joinPath(dirPath, segment);
			const child = dir.children.get(segment);
			if (child?.kind === "dir") {
				dir = child;
				continue;
			}
			if (child) {
				return null;
			}
			const created = this.#newDir(DEFAULT_DIR_MODE, now);
			this.#attach(dir, segment, created, now);
			this.#notify([["rename", dirPath]], { type: "create", path: dirPath, isDirectory: true, remote: true });
			dir = created;
		}
		return dir;
	}

	#applyRemote(message: RemoteMessage): void {
		const path = resolvePath("/", message.path);
		if (path === "/" || this.isMemoryOnly(path)) {
			return;
		}
		const name = basename(path);
		switch (message.op) {
			case "write": {
				const now = this.#now();
				const parent = this.#ensureDirRemote(dirname(path), now);
				if (!parent) {
					return;
				}
				let node = parent.children.get(name);
				const wasLoaded = node?.kind === "file" && node.data !== null;
				const data =
					message.data && (wasLoaded || this.#shouldEagerLoad(path, message.size)) ? message.data : null;
				let created = false;
				if (node?.kind !== "file") {
					if (node) {
						this.#removeSubtree(node, path, now);
					}
					node = this.#newFile(message.meta.mode, now, null);
					this.#attach(parent, name, node, now);
					created = true;
				}
				node.gen++;
				node.loading = null;
				node.loadPatches = null;
				node.blob = null;
				node.volatile = false;
				node.data = data;
				node.size = data ? data.byteLength : message.size;
				node.persistedAt = Date.now();
				this.#applyMeta(node, message.meta);
				this.#trackContent(node);
				this.#notify([[created ? "rename" : "change", path]], {
					type: created ? "create" : "modify",
					path,
					isDirectory: false,
					remote: true,
				});
				return;
			}
			case "mkdir": {
				const now = this.#now();
				const existing = this.#nodeAt(path);
				if (existing && existing.kind !== "dir") {
					return;
				}
				const dir = this.#ensureDirRemote(path, now);
				if (dir) {
					this.#applyMeta(dir, message.meta);
				}
				return;
			}
			case "meta": {
				const node = this.#nodeAt(path);
				if (node) {
					this.#applyMeta(node, message.meta);
					this.#notify([["change", path]], {
						type: "modify",
						path,
						isDirectory: node.kind === "dir",
						remote: true,
					});
				}
				return;
			}
			case "symlink": {
				const now = this.#now();
				const parent = this.#ensureDirRemote(dirname(path), now);
				const existing = parent?.children.get(name);
				if (!parent || (existing && existing.kind !== "symlink")) {
					return;
				}
				const link = this.#newLink(message.target, now);
				this.#applyMeta(link, message.meta);
				this.#attach(parent, name, link, now);
				this.#notify([[existing ? "change" : "rename", path]], {
					type: existing ? "modify" : "create",
					path,
					isDirectory: false,
					remote: true,
				});
				return;
			}
			case "remove": {
				const node = this.#nodeAt(path);
				if (node) {
					const paths = this.#removeSubtree(node, path, this.#now());
					this.#notify(
						paths.map((removed) => ["rename", removed]),
						{ type: "delete", path, isDirectory: node.kind === "dir", remote: true },
					);
				}
				return;
			}
			case "rename": {
				const to = resolvePath("/", message.to);
				const node = this.#nodeAt(path);
				if (!node || to === "/" || this.isMemoryOnly(to) || isAncestor(path, to)) {
					return;
				}
				const now = this.#now();
				const parent = this.#ensureDirRemote(dirname(to), now);
				if (!parent) {
					return;
				}
				const replaced = parent.children.get(basename(to));
				if (replaced === node) {
					return;
				}
				if (replaced) {
					this.#removeSubtree(replaced, to, now);
				}
				this.#detach(node, now);
				this.#attach(parent, basename(to), node, now);
				node.ctimeMs = now;
				// In-flight loads read the old location, which may already hold something else.
				this.#forEachFile(node, (file) => {
					if (file.loading) {
						file.gen++;
						file.loading = null;
						file.loadPatches = null;
					}
				});
				this.#notify(
					[
						["rename", path],
						["rename", to],
					],
					{ type: "rename", path: to, oldPath: path, isDirectory: node.kind === "dir", remote: true },
				);
				return;
			}
		}
	}

	// ---------------------------------------------------------------- helpers for the public API

	isLoaded(path: string): boolean {
		try {
			const { node } = this.#existing(path, "stat", true);
			return node.kind !== "file" || node.data !== null;
		} catch {
			return false;
		}
	}

	async preload(path: string): Promise<void> {
		const { node } = this.#existing(path, "open", true);
		if (node.kind === "file") {
			await this.load(node);
			node.resident = node.size <= this.eagerLoadLimit;
			this.#trackContent(node);
		} else {
			await this.preloadTree(path);
		}
	}

	async preloadTree(path: string, predicate?: (path: string, size: number) => boolean): Promise<void> {
		const found = this.#existing(path, "scandir", true);
		const accept = predicate ?? ((_path: string, size: number) => size <= this.eagerLoadLimit);
		const files: FileNode[] = [];
		const visit = (node: FsNode, nodePath: string): void => {
			if (node.kind === "dir") {
				for (const [name, child] of node.children) {
					visit(child, joinPath(nodePath, name));
				}
			} else if (node.kind === "file" && accept(nodePath, node.size)) {
				files.push(node);
			}
		};
		visit(found.node, found.path);
		const limit = limiter(LOAD_CONCURRENCY);
		await Promise.all(
			files.map((node) =>
				limit(async () => {
					node.resident = true;
					await this.load(node).catch((error: unknown) => console.warn("[vfs] preload failed:", error));
					this.#trackContent(node);
				}),
			),
		);
	}

	async getHandle(path: string): Promise<OpfsFileHandle | null> {
		let found: { node: FsNode; path: string };
		try {
			found = this.#existing(path, "open", true);
		} catch {
			return null;
		}
		if (found.node.kind !== "file" || !this.#inOpfs(found.node, found.path)) {
			return null;
		}
		await this.queue.barrier(found.path);
		const handle = await opfs.getHandle(this.root, found.path);
		return handle && isFileHandle(handle) ? handle : null;
	}

	registerVirtualFile(path: string, blob: BlobLike): void {
		const { abs } = this.resolve(path, "open");
		const parentPath = dirname(abs);
		this.mkdir(parentPath, true, 0o777);
		const found = this.#find(abs, "open", false);
		if (!found.parent) {
			throw found.err("EISDIR");
		}
		if (found.node?.kind === "dir") {
			throw found.err("EISDIR");
		}
		const now = this.#now();
		if (found.node) {
			this.#removeEntry(found.node, found.path, now);
		}
		const node = this.#newFile(S_IFREG | 0o444, now, null, blob.size);
		node.blob = blob;
		node.volatile = true;
		if (typeof blob.lastModified === "number") {
			node.mtimeMs = node.ctimeMs = node.atimeMs = node.birthtimeMs = blob.lastModified;
		}
		this.#attach(found.parent, found.name, node, now);
		this.#notify([["rename", found.path]], { type: "create", path: found.path, isDirectory: false, remote: false });
	}

	// ---------------------------------------------------------------- operations

	stat(path: unknown, follow: boolean): Stats;
	stat(path: unknown, follow: boolean, throwIfNoEntry: boolean): Stats | undefined;
	stat(path: unknown, follow: boolean, throwIfNoEntry = true): Stats | undefined {
		const syscall = follow ? "stat" : "lstat";
		let found: Lookup & Resolved & { err: ErrorFactory };
		try {
			found = this.#find(path, syscall, follow);
		} catch (error) {
			if (!throwIfNoEntry && isObject(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
				return undefined;
			}
			throw error;
		}
		if (!found.node) {
			if (!throwIfNoEntry) {
				return undefined;
			}
			throw found.err("ENOENT");
		}
		return this.statNode(found.node);
	}

	exists(path: unknown): boolean {
		try {
			return this.#find(path, "access", true).node !== null;
		} catch {
			return false;
		}
	}

	access(path: unknown, mode: number): void {
		const found = this.#existing(path, "access", true);
		this.#checkAccess(found.node, mode, (code) => fsError(code, "access", found.display));
	}

	realpath(path: unknown, syscall = "realpath"): string {
		return this.#existing(path, syscall, true).path;
	}

	readlink(path: unknown): string {
		const found = this.#existing(path, "readlink", false);
		if (found.node.kind !== "symlink") {
			throw fsError("EINVAL", "readlink", found.display);
		}
		return found.node.target;
	}

	readdir(path: unknown, recursive: boolean, syscall = "scandir"): DirEntry[] {
		const found = this.#existing(path, syscall, true);
		if (found.node.kind !== "dir") {
			throw fsError("ENOTDIR", syscall, found.display);
		}
		const result: DirEntry[] = [];
		const queue: Array<[DirNode, string]> = [[found.node, ""]];
		for (let next = queue.shift(); next; next = queue.shift()) {
			const [dir, prefix] = next;
			for (const [name, child] of dir.children) {
				const relative = prefix ? `${prefix}/${name}` : name;
				result.push({ relative, name, node: child, parentRelative: prefix });
				if (recursive && child.kind === "dir") {
					queue.push([child, relative]);
				}
			}
		}
		return result;
	}

	mkdir(path: unknown, recursive: boolean, mode: number): string | undefined {
		const resolved = this.resolve(path, "mkdir");
		const err: ErrorFactory = (code) => fsError(code, "mkdir", resolved.display);
		const permissions = mode & 0o7777 & ~UMASK;
		if (!recursive) {
			const found = this.#lookup(resolved.abs, false, err);
			if (found.node || !found.parent) {
				throw err("EEXIST");
			}
			this.#makeDir(found.parent, found.name, found.path, permissions);
			return undefined;
		}
		const segments = splitPath(resolved.abs);
		let first: string | undefined;
		for (let i = 1; i <= segments.length; i++) {
			const prefix = `/${segments.slice(0, i).join("/")}`;
			const found = this.#lookup(prefix, true, err);
			if (found.node) {
				if (found.node.kind !== "dir") {
					throw err(i === segments.length ? "EEXIST" : "ENOTDIR");
				}
				continue;
			}
			if (!found.parent) {
				throw err("ENOENT");
			}
			this.#makeDir(found.parent, found.name, found.path, permissions);
			first ??= prefix;
		}
		return first;
	}

	#makeDir(parent: DirNode, name: string, path: string, permissions: number): DirNode {
		const now = this.#now();
		const node = this.#newDir(S_IFDIR | permissions, now);
		this.#attach(parent, name, node, now);
		this.#persistMkdir(node, path);
		this.#markMeta();
		this.#notify([["rename", path]], { type: "create", path, isDirectory: true, remote: false });
		return node;
	}

	mkdtemp(prefix: unknown): string {
		const base = pathArg(prefix, "prefix");
		const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
		for (let attempt = 0; attempt < 100; attempt++) {
			let suffix = "";
			for (let i = 0; i < 6; i++) {
				suffix += chars[Math.floor(Math.random() * chars.length)];
			}
			const candidate = base + suffix;
			const err: ErrorFactory = (code) => fsError(code, "mkdtemp", `${base}XXXXXX`);
			const found = this.#lookup(resolvePath(this.cwd(), candidate), false, err);
			if (found.node) {
				continue;
			}
			if (!found.parent) {
				throw err("ENOENT");
			}
			this.#makeDir(found.parent, found.name, found.path, 0o700);
			return candidate;
		}
		throw fsError("EEXIST", "mkdtemp", `${base}XXXXXX`);
	}

	#removeEntry(node: FsNode, path: string, now: number): void {
		this.#persistRemove(node, path);
		const paths = this.#removeSubtree(node, path, now);
		this.#notify(
			paths.map((removed) => ["rename", removed]),
			{ type: "delete", path, isDirectory: node.kind === "dir", remote: false },
		);
	}

	unlink(path: unknown): void {
		const found = this.#existing(path, "unlink", false);
		if (found.node === this.tree) {
			throw fsError("EBUSY", "unlink", found.display);
		}
		if (found.node.kind === "dir") {
			throw fsError("EISDIR", "unlink", found.display);
		}
		this.#removeEntry(found.node, found.path, this.#now());
	}

	rmdir(path: unknown, recursive = false): void {
		const found = this.#existing(path, "rmdir", recursive);
		const err: ErrorFactory = (code) => fsError(code, "rmdir", found.display);
		if (found.node.kind !== "dir") {
			throw err("ENOTDIR");
		}
		if (found.node === this.tree) {
			throw err("EBUSY");
		}
		if (!recursive && found.node.children.size > 0) {
			throw err("ENOTEMPTY");
		}
		this.#removeEntry(found.node, found.path, this.#now());
	}

	rm(path: unknown, recursive: boolean, force: boolean): void {
		let found: Lookup & Resolved & { err: ErrorFactory };
		try {
			found = this.#find(path, "lstat", false);
		} catch (error) {
			if (force && isObject(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
				return;
			}
			throw error;
		}
		if (!found.node) {
			if (force) {
				return;
			}
			throw found.err("ENOENT");
		}
		if (found.node.kind === "dir" && !recursive) {
			throw Object.assign(
				new Error(`Path is a directory: rm returned EISDIR (is a directory) ${found.display}`),
				{ code: "ERR_FS_EISDIR", errno: 21, syscall: "rm", path: found.display },
			);
		}
		if (found.node === this.tree) {
			throw fsError("EBUSY", "rm", found.display);
		}
		this.#removeEntry(found.node, found.path, this.#now());
	}

	rename(oldPath: unknown, newPath: unknown): void {
		const from = this.resolve(oldPath, "rename", "oldPath");
		const to = this.resolve(newPath, "rename", "newPath");
		const err: ErrorFactory = (code) => fsError(code, "rename", from.display, to.display);
		const src = this.#lookup(from.abs, false, err);
		if (!src.node) {
			throw err("ENOENT");
		}
		const node = src.node;
		const dst = this.#lookup(to.abs, false, err);
		if (node === this.tree || dst.node === this.tree || !dst.parent) {
			throw err("EBUSY");
		}
		if (dst.node === node) {
			return;
		}
		if (node.kind === "dir" && isSameOrAncestor(src.path, dst.path)) {
			throw err("EINVAL");
		}
		if ((from.dirOnly || to.dirOnly) && node.kind !== "dir") {
			throw err("ENOTDIR");
		}
		if (dst.node) {
			if (node.kind === "dir") {
				if (dst.node.kind !== "dir") {
					throw err("ENOTDIR");
				}
				if (dst.node.children.size > 0) {
					throw err("ENOTEMPTY");
				}
			} else if (dst.node.kind === "dir") {
				throw err("EISDIR");
			}
		}
		const srcPersistable = !this.isMemoryOnly(src.path);
		const dstPersistable = !this.isMemoryOnly(dst.path);
		if (dstPersistable && !srcPersistable) {
			this.#forEachFile(node, (file) => {
				this.requireContent(file, "rename", from.display);
			});
		} else if (srcPersistable && !dstPersistable) {
			this.#forEachFile(node, (file) => {
				if (!file.volatile) {
					this.requireContent(file, "rename", from.display);
				}
			});
		}
		const now = this.#now();
		const srcInOpfs = this.#inOpfs(node, src.path);
		if (dst.node) {
			const replaced = dst.node;
			if (!(srcInOpfs && dstPersistable) || !this.#inOpfs(replaced, dst.path)) {
				this.#persistRemove(replaced, dst.path);
			}
			this.#removeSubtree(replaced, dst.path, now);
		}
		this.#detach(node, now);
		this.#attach(dst.parent, dst.name, node, now);
		node.ctimeMs = now;
		if (srcPersistable && dstPersistable) {
			if (srcInOpfs || node.kind === "symlink") {
				this.#markMeta();
				this.#enqueue([src.path, dst.path], `rename ${src.path}`, async () => {
					if (srcInOpfs) {
						await opfs.moveEntry(this.root, src.path, dst.path).catch((error: unknown) => {
							throw fromDomError(error, "rename", src.path);
						});
					}
					this.#post({ op: "rename", path: src.path, to: dst.path });
				});
			}
		} else if (srcPersistable) {
			this.#persistRemove(node, src.path);
		} else if (dstPersistable) {
			this.#persistSubtree(node, dst.path);
		}
		this.#forEachFile(node, (file) => this.#trackContent(file));
		this.#notify(
			[
				["rename", src.path],
				["rename", dst.path],
			],
			{ type: "rename", path: dst.path, oldPath: src.path, isDirectory: node.kind === "dir", remote: false },
		);
	}

	readFile(path: unknown, flags: number): Uint8Array<ArrayBuffer> {
		if (typeof path === "number") {
			return this.#readRest(path);
		}
		if ((flags & 3) !== O_RDONLY || (flags & O_CREAT) !== 0) {
			const fd = this.open(path, flags, 0o666);
			try {
				return this.#readRest(fd);
			} finally {
				this.close(fd);
			}
		}
		const found = this.#existing(path, "open", true);
		const node = found.node;
		if (node.kind === "dir") {
			throw fsError("EISDIR", "read");
		}
		if (node.kind !== "file") {
			throw fsError("EINVAL", "read");
		}
		this.#checkAccess(node, R_OK, (code) => fsError(code, "open", found.display));
		if (node.size === 0) {
			return new Uint8Array(0);
		}
		return this.requireContent(node, "open", found.display).subarray(0, node.size);
	}

	#readRest(fd: number): Uint8Array<ArrayBuffer> {
		const file = this.#fd(fd, "read");
		if (!file.readable) {
			throw fsError("EBADF", "read");
		}
		const node = file.node;
		if (node.kind !== "file") {
			throw fsError("EISDIR", "read");
		}
		if (file.position >= node.size) {
			return new Uint8Array(0);
		}
		const data = this.requireContent(node, "read", file.path);
		const out = data.subarray(file.position, node.size);
		file.position = node.size;
		return out;
	}

	writeFile(path: unknown, data: Uint8Array<ArrayBuffer>, flags: number, mode: number): void {
		if (typeof path === "number") {
			this.write(path, data, null);
			return;
		}
		const resolved = this.resolve(path, "open");
		const err: ErrorFactory = (code) => fsError(code, "open", resolved.display);
		const exclusive = (flags & O_CREAT) !== 0 && (flags & O_EXCL) !== 0;
		const found = this.#lookup(resolved.abs, !exclusive, err);
		const node = found.node;
		if (!node) {
			if ((flags & O_CREAT) === 0 || !found.parent) {
				throw err("ENOENT");
			}
			if (resolved.dirOnly) {
				throw err("EISDIR");
			}
			this.#createFile(found.parent, found.name, found.path, mode & ~UMASK, data);
			return;
		}
		if (exclusive) {
			throw err("EEXIST");
		}
		if (node.kind === "dir") {
			throw err("EISDIR");
		}
		if (node.kind !== "file" || resolved.dirOnly) {
			throw err("ENOTDIR");
		}
		this.#checkAccess(node, (flags & 3) === O_RDWR ? R_OK | W_OK : W_OK, err);
		const now = this.#now();
		if ((flags & O_APPEND) !== 0) {
			this.#prepareWrite(node, found.path, "open", resolved.display);
			this.#writeAt(node, node.size, data, found.path, now);
		} else if ((flags & O_TRUNC) !== 0) {
			this.#replaceContent(node, data, found.path, now);
		} else {
			this.#prepareWrite(node, found.path, "open", resolved.display);
			this.#writeAt(node, 0, data, found.path, now);
		}
		this.#notifyModified(node, found.path);
	}

	truncate(path: unknown, length: number): void {
		const found = this.#existing(path, "open", true);
		const node = found.node;
		const err: ErrorFactory = (code) => fsError(code, "open", found.display);
		if (node.kind === "dir") {
			throw err("EISDIR");
		}
		if (node.kind !== "file") {
			throw err("EINVAL");
		}
		this.#checkAccess(node, W_OK, err);
		if (length > 0) {
			this.#prepareWrite(node, found.path, "open", found.display);
		}
		this.#truncateNode(node, length, found.path, this.#now());
		this.#notifyModified(node, found.path);
	}

	copyFile(source: unknown, destination: unknown, mode: number): void {
		const src = this.resolve(source, "copyfile", "src");
		const dst = this.resolve(destination, "copyfile", "dest");
		const err: ErrorFactory = (code) => fsError(code, "copyfile", src.display, dst.display);
		const from = this.#lookup(src.abs, true, err);
		if (!from.node) {
			throw err("ENOENT");
		}
		if (from.node.kind === "dir") {
			throw err("EISDIR");
		}
		if (from.node.kind !== "file") {
			throw err("EINVAL");
		}
		const to = this.#lookup(dst.abs, true, err);
		if (to.node) {
			if ((mode & COPYFILE_EXCL) !== 0) {
				throw err("EEXIST");
			}
			if (to.node.kind === "dir") {
				throw err("EISDIR");
			}
			if (to.node === from.node) {
				return;
			}
		}
		this.#checkAccess(from.node, R_OK, err);
		if (to.node) {
			this.#checkAccess(to.node, W_OK, err);
		}
		const bytes =
			from.node.size === 0
				? new Uint8Array(0)
				: this.requireContent(from.node, "copyfile", src.display).slice(0, from.node.size);
		if (to.node?.kind === "file") {
			this.#replaceContent(to.node, bytes, to.path, this.#now());
			this.#notifyModified(to.node, to.path);
		} else if (to.parent) {
			this.#createFile(to.parent, to.name, to.path, from.node.mode, bytes);
		} else {
			throw err("EISDIR");
		}
	}

	symlink(target: unknown, path: unknown): void {
		const targetString = pathArg(target, "target");
		const resolved = this.resolve(path, "symlink");
		const err: ErrorFactory = (code) => fsError(code, "symlink", targetString, resolved.display);
		const found = this.#lookup(resolved.abs, false, err);
		if (found.node || !found.parent) {
			throw err("EEXIST");
		}
		const now = this.#now();
		const link = this.#newLink(targetString, now);
		this.#attach(found.parent, found.name, link, now);
		this.#persistSymlink(link, found.path);
		this.#notify([["rename", found.path]], { type: "create", path: found.path, isDirectory: false, remote: false });
	}

	link(existingPath: unknown, newPath: unknown): void {
		const src = this.resolve(existingPath, "link", "existingPath");
		const dst = this.resolve(newPath, "link", "newPath");
		const err: ErrorFactory = (code) => fsError(code, "link", src.display, dst.display);
		const from = this.#lookup(src.abs, false, err);
		if (!from.node) {
			throw err("ENOENT");
		}
		if (from.node.kind === "dir") {
			throw err("EPERM");
		}
		const to = this.#lookup(dst.abs, false, err);
		if (to.node || !to.parent) {
			throw err("EEXIST");
		}
		if (from.node.kind === "symlink") {
			const now = this.#now();
			const link = this.#newLink(from.node.target, now);
			this.#attach(to.parent, to.name, link, now);
			this.#persistSymlink(link, to.path);
			this.#notify([["rename", to.path]], { type: "create", path: to.path, isDirectory: false, remote: false });
			return;
		}
		const bytes =
			from.node.size === 0
				? new Uint8Array(0)
				: this.requireContent(from.node, "link", src.display).slice(0, from.node.size);
		const created = this.#createFile(to.parent, to.name, to.path, from.node.mode, bytes);
		created.mtimeMs = from.node.mtimeMs;
	}

	utimes(path: unknown, atimeMs: number, mtimeMs: number, follow: boolean): void {
		const syscall = follow ? "utime" : "lutime";
		const found = this.#existing(path, syscall, follow);
		this.#setTimes(found.node, found.path, atimeMs, mtimeMs);
	}

	/** Electron's `btime` native module: sets the creation time, which `utimes` cannot change. */
	setBirthtime(path: unknown, birthtimeMs: number): void {
		const found = this.#existing(path, "utime", true);
		found.node.birthtimeMs = birthtimeMs;
		if (found.path !== null) {
			this.#persistMeta(found.node, found.path);
		}
		this.#notifyModified(found.node, found.path);
	}

	#setTimes(node: FsNode, path: string | null, atimeMs: number, mtimeMs: number): void {
		node.atimeMs = atimeMs;
		node.mtimeMs = mtimeMs;
		node.ctimeMs = this.#now();
		if (path !== null) {
			this.#persistMeta(node, path);
		}
		this.#notifyModified(node, path);
	}

	chmod(path: unknown, mode: number, follow: boolean): void {
		const found = this.#existing(path, follow ? "chmod" : "lchmod", follow);
		this.#setMode(found.node, found.path, mode);
	}

	#setMode(node: FsNode, path: string | null, mode: number): void {
		node.mode = (node.mode & S_IFMT) | (mode & 0o7777);
		node.ctimeMs = this.#now();
		if (path !== null) {
			this.#persistMeta(node, path);
		}
		this.#notifyModified(node, path);
	}

	chown(path: unknown, uid: number, gid: number, follow: boolean): void {
		const found = this.#existing(path, follow ? "chown" : "lchown", follow);
		this.#setOwner(found.node, found.path, uid, gid);
	}

	#setOwner(node: FsNode, path: string | null, uid: number, gid: number): void {
		if (uid !== -1) {
			node.uid = uid;
		}
		if (gid !== -1) {
			node.gid = gid;
		}
		node.ctimeMs = this.#now();
		this.#notifyModified(node, path);
	}

	statfs(path: unknown): StatFs {
		this.#existing(path, "statfs", true);
		return new StatFs();
	}

	// ---------------------------------------------------------------- file descriptors

	#fd(fd: number, syscall: string): OpenFile {
		const file = this.#fds.get(fd);
		if (!file) {
			throw fsError("EBADF", syscall);
		}
		return file;
	}

	fdNode(fd: number, syscall: string): OpenFile {
		return this.#fd(fd, syscall);
	}

	open(path: unknown, flags: number, mode: number): number {
		const resolved = this.resolve(path, "open");
		const err: ErrorFactory = (code) => fsError(code, "open", resolved.display);
		const exclusive = (flags & O_CREAT) !== 0 && (flags & O_EXCL) !== 0;
		const follow = !exclusive && (flags & O_NOFOLLOW) === 0;
		const found = this.#lookup(resolved.abs, follow || resolved.dirOnly, err);
		const accessMode = flags & 3;
		const readable = accessMode === O_RDONLY || accessMode === O_RDWR;
		const writable = accessMode === O_WRONLY || accessMode === O_RDWR;
		let node = found.node;
		if (node) {
			if (exclusive) {
				throw err("EEXIST");
			}
			if (node.kind === "symlink") {
				throw err("ELOOP");
			}
			if ((resolved.dirOnly || (flags & O_DIRECTORY) !== 0) && node.kind !== "dir") {
				throw err("ENOTDIR");
			}
			if (node.kind === "dir") {
				if (writable) {
					throw err("EISDIR");
				}
			} else {
				this.#checkAccess(node, (readable ? R_OK : 0) | (writable ? W_OK : 0), err);
				if (writable && (flags & O_TRUNC) !== 0) {
					this.#truncateNode(node, 0, found.path, this.#now());
					this.#notifyModified(node, found.path);
				}
			}
		} else {
			if ((flags & O_CREAT) === 0 || (flags & O_DIRECTORY) !== 0 || !found.parent) {
				throw err("ENOENT");
			}
			if (resolved.dirOnly) {
				throw err("EISDIR");
			}
			node = this.#createFile(found.parent, found.name, found.path, mode & ~UMASK, new Uint8Array(0));
		}
		let fd = 3;
		while (this.#fds.has(fd)) {
			fd++;
		}
		this.#fds.set(fd, {
			node,
			path: resolved.display,
			flags,
			readable,
			writable,
			append: (flags & O_APPEND) !== 0,
			position: 0,
		});
		return fd;
	}

	close(fd: number): void {
		this.#fd(fd, "close");
		this.#fds.delete(fd);
	}

	read(fd: number, target: Uint8Array, offset: number, length: number, position: number | null): number {
		const file = this.#fd(fd, "read");
		if (!file.readable) {
			throw fsError("EBADF", "read");
		}
		const node = file.node;
		if (node.kind !== "file") {
			throw fsError("EISDIR", "read");
		}
		const start = position ?? file.position;
		if (length <= 0 || start >= node.size) {
			return 0;
		}
		const data = this.requireContent(node, "read", file.path);
		const count = Math.min(length, node.size - start);
		target.set(data.subarray(start, start + count), offset);
		if (position === null) {
			file.position = start + count;
		}
		return count;
	}

	write(fd: number, bytes: Uint8Array, position: number | null): number {
		const file = this.#fd(fd, "write");
		if (!file.writable) {
			throw fsError("EBADF", "write");
		}
		const node = file.node;
		if (node.kind !== "file") {
			throw fsError("EISDIR", "write");
		}
		const path = this.pathOf(node);
		this.#prepareWrite(node, path, "write", file.path);
		const start = file.append ? node.size : (position ?? file.position);
		this.#writeAt(node, start, bytes, path, this.#now());
		if (position === null || file.append) {
			file.position = start + bytes.byteLength;
		}
		this.#notifyModified(node, path);
		return bytes.byteLength;
	}

	fstat(fd: number): Stats {
		return this.statNode(this.#fd(fd, "fstat").node);
	}

	ftruncate(fd: number, length: number): void {
		const file = this.#fd(fd, "ftruncate");
		const node = file.node;
		if (!file.writable || node.kind !== "file") {
			throw fsError("EINVAL", "ftruncate");
		}
		const path = this.pathOf(node);
		if (length > 0) {
			this.#prepareWrite(node, path, "ftruncate", file.path);
		}
		this.#truncateNode(node, length, path, this.#now());
		this.#notifyModified(node, path);
	}

	futimes(fd: number, atimeMs: number, mtimeMs: number): void {
		const node = this.#fd(fd, "futime").node;
		this.#setTimes(node, this.pathOf(node), atimeMs, mtimeMs);
	}

	fchmod(fd: number, mode: number): void {
		const node = this.#fd(fd, "fchmod").node;
		this.#setMode(node, this.pathOf(node), mode);
	}

	fchown(fd: number, uid: number, gid: number): void {
		const node = this.#fd(fd, "fchown").node;
		this.#setOwner(node, this.pathOf(node), uid, gid);
	}

	/** Wait until everything written through `fd` is persisted. */
	async fsync(fd: number): Promise<void> {
		const node = this.#fd(fd, "fsync").node;
		const path = this.pathOf(node);
		if (path !== null) {
			await this.queue.barrier(path);
		}
	}
}
