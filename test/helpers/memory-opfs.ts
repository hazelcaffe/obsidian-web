// In-memory implementation of the subset of the File System Access API (OPFS) used by src/vfs.

type WriteInput =
	| ArrayBufferView
	| ArrayBuffer
	| Blob
	| string
	| { type: "write"; position?: number | null; data: ArrayBufferView | ArrayBuffer | Blob | string }
	| { type: "seek"; position: number }
	| { type: "truncate"; size: number };

export interface MemoryOpfsOptions {
	/** Which handles implement `move()` (default "files", like Chromium). */
	move?: "all" | "files" | "none";
	/** Awaited by every asynchronous operation; use it to inject latency. */
	delay?: () => Promise<void>;
}

interface Shared {
	options: MemoryOpfsOptions;
	stats: { writes: number; moves: number; removes: number };
}

function notFound(name: string): DOMException {
	return new DOMException(`A requested file or directory could not be found: ${name}`, "NotFoundError");
}

function typeMismatch(name: string): DOMException {
	return new DOMException(
		`The path supplied exists, but was not an entry of requested type: ${name}`,
		"TypeMismatchError",
	);
}

async function toBytes(data: ArrayBufferView | ArrayBuffer | Blob | string): Promise<Uint8Array<ArrayBuffer>> {
	if (typeof data === "string") {
		return new TextEncoder().encode(data);
	}
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data.slice(0));
	}
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
	}
	return new Uint8Array(await data.arrayBuffer());
}

function validName(name: string): void {
	if (name === "" || name === "." || name === ".." || name.includes("/")) {
		throw new TypeError(`Name is not allowed: ${name}`);
	}
}

abstract class MemoryHandle {
	name: string;
	parent: MemoryDirectoryHandle | null = null;
	protected readonly shared: Shared;

	constructor(name: string, shared: Shared) {
		this.name = name;
		this.shared = shared;
	}

	protected async tick(): Promise<void> {
		await this.shared.options.delay?.();
	}

	protected get attached(): boolean {
		let node: MemoryHandle = this;
		while (node.parent) {
			node = node.parent;
		}
		return node instanceof MemoryDirectoryHandle && node.isRoot;
	}

	async isSameEntry(other: { kind: string; name: string }): Promise<boolean> {
		return Object.is(other, this);
	}

	protected async moveTo(
		self: MemoryFileHandle | MemoryDirectoryHandle,
		destination: { kind: "directory" },
		newName: string,
	): Promise<void> {
		await this.tick();
		if (!(destination instanceof MemoryDirectoryHandle)) {
			throw new TypeError("destination must be a MemoryDirectoryHandle");
		}
		validName(newName);
		if (!this.attached) {
			throw notFound(this.name);
		}
		const existing = destination.children.get(newName);
		if (existing && existing !== self) {
			if (existing.kind !== "file" || self.kind === "directory") {
				throw new DOMException("Cannot overwrite", "InvalidModificationError");
			}
		}
		this.parent?.children.delete(this.name);
		destination.children.set(newName, self);
		this.parent = destination;
		this.name = newName;
		this.shared.stats.moves++;
	}
}

export class MemoryWritable {
	readonly #file: MemoryFileHandle;
	#buffer: Uint8Array<ArrayBuffer>;
	#position = 0;
	#closed = false;

	constructor(file: MemoryFileHandle, initial: Uint8Array<ArrayBuffer>) {
		this.#file = file;
		this.#buffer = initial;
	}

	#writeAt(position: number, bytes: Uint8Array): void {
		const end = position + bytes.byteLength;
		if (end > this.#buffer.byteLength) {
			const grown = new Uint8Array(end);
			grown.set(this.#buffer);
			this.#buffer = grown;
		}
		this.#buffer.set(bytes, position);
		this.#position = end;
	}

	async write(input: WriteInput): Promise<void> {
		if (this.#closed) {
			throw new TypeError("stream is closed");
		}
		await this.#file.delay();
		if (
			typeof input === "string" ||
			input instanceof ArrayBuffer ||
			ArrayBuffer.isView(input) ||
			input instanceof Blob
		) {
			this.#writeAt(this.#position, await toBytes(input));
		} else if (input.type === "write") {
			this.#writeAt(input.position ?? this.#position, await toBytes(input.data));
		} else if (input.type === "seek") {
			this.#position = input.position;
		} else {
			await this.truncate(input.size);
		}
	}

	async seek(position: number): Promise<void> {
		this.#position = position;
	}

	async truncate(size: number): Promise<void> {
		const next = new Uint8Array(size);
		next.set(this.#buffer.subarray(0, Math.min(size, this.#buffer.byteLength)));
		this.#buffer = next;
		if (this.#position > size) {
			this.#position = size;
		}
	}

	async close(): Promise<void> {
		if (this.#closed) {
			throw new TypeError("stream is closed");
		}
		this.#closed = true;
		await this.#file.delay();
		this.#file.commit(this.#buffer);
	}

	async abort(): Promise<void> {
		this.#closed = true;
	}
}

export class MemoryFileHandle extends MemoryHandle {
	readonly kind = "file" as const;
	data: Uint8Array<ArrayBuffer> = new Uint8Array(0);
	lastModified = Date.now();

	delay(): Promise<void> {
		return this.tick();
	}

	commit(data: Uint8Array<ArrayBuffer>): void {
		this.data = data;
		this.lastModified = Date.now();
		this.shared.stats.writes++;
	}

	async getFile(): Promise<File> {
		await this.tick();
		if (!this.attached) {
			throw notFound(this.name);
		}
		return new File([this.data.slice()], this.name, { lastModified: this.lastModified });
	}

	async createWritable(options?: { keepExistingData?: boolean }): Promise<MemoryWritable> {
		await this.tick();
		if (!this.attached) {
			throw notFound(this.name);
		}
		return new MemoryWritable(this, options?.keepExistingData ? this.data.slice() : new Uint8Array(0));
	}

	get move(): ((destination: { kind: "directory" }, newName: string) => Promise<void>) | undefined {
		const mode = this.shared.options.move ?? "files";
		return mode === "none" ? undefined : (destination, newName) => this.moveTo(this, destination, newName);
	}
}

export class MemoryDirectoryHandle extends MemoryHandle {
	readonly kind = "directory" as const;
	readonly children = new Map<string, MemoryFileHandle | MemoryDirectoryHandle>();
	readonly isRoot: boolean;

	constructor(name: string, shared: Shared, isRoot = false) {
		super(name, shared);
		this.isRoot = isRoot;
	}

	get stats(): Shared["stats"] {
		return this.shared.stats;
	}

	async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectoryHandle> {
		await this.tick();
		validName(name);
		if (!this.attached) {
			throw notFound(this.name);
		}
		const existing = this.children.get(name);
		if (existing instanceof MemoryDirectoryHandle) {
			return existing;
		}
		if (existing) {
			throw typeMismatch(name);
		}
		if (!options?.create) {
			throw notFound(name);
		}
		const dir = new MemoryDirectoryHandle(name, this.shared);
		dir.parent = this;
		this.children.set(name, dir);
		return dir;
	}

	async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFileHandle> {
		await this.tick();
		validName(name);
		if (!this.attached) {
			throw notFound(this.name);
		}
		const existing = this.children.get(name);
		if (existing instanceof MemoryFileHandle) {
			return existing;
		}
		if (existing) {
			throw typeMismatch(name);
		}
		if (!options?.create) {
			throw notFound(name);
		}
		const file = new MemoryFileHandle(name, this.shared);
		file.parent = this;
		this.children.set(name, file);
		return file;
	}

	async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
		await this.tick();
		validName(name);
		const existing = this.children.get(name);
		if (!existing) {
			throw notFound(name);
		}
		if (existing instanceof MemoryDirectoryHandle && existing.children.size > 0 && !options?.recursive) {
			throw new DOMException("Directory is not empty", "InvalidModificationError");
		}
		this.children.delete(name);
		existing.parent = null;
		this.shared.stats.removes++;
	}

	async *entries(): AsyncGenerator<[string, MemoryFileHandle | MemoryDirectoryHandle]> {
		for (const entry of [...this.children]) {
			yield entry;
		}
	}

	async *keys(): AsyncGenerator<string> {
		for (const key of [...this.children.keys()]) {
			yield key;
		}
	}

	async *values(): AsyncGenerator<MemoryFileHandle | MemoryDirectoryHandle> {
		for (const value of [...this.children.values()]) {
			yield value;
		}
	}

	[Symbol.asyncIterator](): AsyncGenerator<[string, MemoryFileHandle | MemoryDirectoryHandle]> {
		return this.entries();
	}

	get move(): ((destination: { kind: "directory" }, newName: string) => Promise<void>) | undefined {
		return this.shared.options.move === "all"
			? (destination, newName) => this.moveTo(this, destination, newName)
			: undefined;
	}

	// Synchronous helpers for tests ----------------------------------------------------------

	/** Node at `path` (relative to this directory), or undefined. */
	lookup(path: string): MemoryFileHandle | MemoryDirectoryHandle | undefined {
		let node: MemoryFileHandle | MemoryDirectoryHandle = this;
		for (const segment of path.split("/").filter(Boolean)) {
			if (!(node instanceof MemoryDirectoryHandle)) {
				return undefined;
			}
			const child = node.children.get(segment);
			if (!child) {
				return undefined;
			}
			node = child;
		}
		return node;
	}

	/** Create a file (and parent directories) synchronously. */
	put(path: string, content: string | Uint8Array, lastModified = Date.now()): MemoryFileHandle {
		const segments = path.split("/").filter(Boolean);
		const name = segments.pop();
		if (!name) {
			throw new Error(`invalid path ${path}`);
		}
		let dir: MemoryDirectoryHandle = this;
		for (const segment of segments) {
			let child = dir.children.get(segment);
			if (!child) {
				child = new MemoryDirectoryHandle(segment, this.shared);
				child.parent = dir;
				dir.children.set(segment, child);
			}
			if (!(child instanceof MemoryDirectoryHandle)) {
				throw new Error(`${segment} is a file`);
			}
			dir = child;
		}
		const file = new MemoryFileHandle(name, this.shared);
		file.parent = dir;
		file.data = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
		file.lastModified = lastModified;
		dir.children.set(name, file);
		return file;
	}

	/** Create a directory (and parents) synchronously. */
	mkdirp(path: string): MemoryDirectoryHandle {
		let dir: MemoryDirectoryHandle = this;
		for (const segment of path.split("/").filter(Boolean)) {
			let child = dir.children.get(segment);
			if (!child) {
				child = new MemoryDirectoryHandle(segment, this.shared);
				child.parent = dir;
				dir.children.set(segment, child);
			}
			if (!(child instanceof MemoryDirectoryHandle)) {
				throw new Error(`${segment} is a file`);
			}
			dir = child;
		}
		return dir;
	}

	/** Text of the file at `path`, or undefined. */
	read(path: string): string | undefined {
		const node = this.lookup(path);
		return node instanceof MemoryFileHandle ? new TextDecoder().decode(node.data) : undefined;
	}

	/** Flat listing: directories end with "/", files map to their UTF-8 contents. */
	snapshot(): Record<string, string> {
		const out: Record<string, string> = {};
		const visit = (dir: MemoryDirectoryHandle, prefix: string): void => {
			for (const [name, child] of [...dir.children].sort(([a], [b]) => a.localeCompare(b))) {
				const path = `${prefix}/${name}`;
				if (child instanceof MemoryDirectoryHandle) {
					out[`${path}/`] = "";
					visit(child, path);
				} else {
					out[path] = new TextDecoder().decode(child.data);
				}
			}
		};
		visit(this, "");
		return out;
	}
}

export function createMemoryOpfs(options: MemoryOpfsOptions = {}): MemoryDirectoryHandle {
	return new MemoryDirectoryHandle("", { options, stats: { writes: 0, moves: 0, removes: 0 } }, true);
}

/** Random latency of up to `max` milliseconds. */
export function randomDelay(max = 3): () => Promise<void> {
	return () => new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * (max + 1))));
}
