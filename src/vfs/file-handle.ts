import { Buffer } from "buffer";
import { EventEmitter } from "events";
import {
	buffersArg,
	integerArg,
	isObject,
	lengthArg,
	modeArg,
	optionsArg,
	readArgs,
	timeArg,
	writeArgs,
} from "./args.ts";
import type { VfsCore } from "./core.ts";
import { isArrayBufferView } from "./encoding.ts";
import { fsError } from "./errors.ts";
import type { Stats } from "./stats.ts";
import type { ReadStream, WriteStream } from "./streams.ts";

export interface FileHandleContext {
	core: VfsCore;
	readFile(fd: number, options: unknown): Promise<string | Buffer>;
	writeFile(fd: number, data: unknown, options: unknown): Promise<void>;
	createReadStream(handle: FileHandle, options: unknown): ReadStream;
	createWriteStream(handle: FileHandle, options: unknown): WriteStream;
}

export class FileHandle extends EventEmitter {
	#fd: number;
	readonly #context: FileHandleContext;
	#closing: Promise<void> | null = null;

	constructor(fd: number, context: FileHandleContext) {
		super();
		this.#fd = fd;
		this.#context = context;
	}

	get fd(): number {
		return this.#fd;
	}

	#run<T>(syscall: string, fn: (fd: number) => T): Promise<T> {
		const fd = this.#fd;
		if (fd < 0) {
			return Promise.reject(fsError("EBADF", syscall));
		}
		return this.#context.core.run(() => fn(fd));
	}

	async read(
		buffer?: unknown,
		offset?: unknown,
		length?: unknown,
		position?: unknown,
	): Promise<{ bytesRead: number; buffer: ArrayBufferView }> {
		let target: ArrayBufferView;
		let offsetArg = offset;
		if (isArrayBufferView(buffer)) {
			target = buffer;
		} else {
			const options = optionsArg(buffer);
			target = isArrayBufferView(options.buffer) ? options.buffer : Buffer.alloc(16384);
			offsetArg = options;
		}
		const slice = readArgs(target, offsetArg, length, position);
		const bytesRead = await this.#run("read", (fd) =>
			this.#context.core.read(fd, slice.buffer, slice.offset, slice.length, slice.position),
		);
		return { bytesRead, buffer: target };
	}

	async write<T extends ArrayBufferView | string>(
		data: T,
		offsetOrPosition?: unknown,
		lengthOrEncoding?: unknown,
		position?: unknown,
	): Promise<{ bytesWritten: number; buffer: T }> {
		const parsed = writeArgs(data, offsetOrPosition, lengthOrEncoding, position);
		const bytesWritten = await this.#run("write", (fd) =>
			this.#context.core.write(fd, parsed.bytes, parsed.position),
		);
		return { bytesWritten, buffer: data };
	}

	async readv(
		buffers: ArrayBufferView[],
		position?: number | null,
	): Promise<{ bytesRead: number; buffers: ArrayBufferView[] }> {
		const views = buffersArg(buffers);
		const bytesRead = await this.#run("read", (fd) => readvCore(this.#context.core, fd, views, position ?? null));
		return { bytesRead, buffers };
	}

	async writev(
		buffers: ArrayBufferView[],
		position?: number | null,
	): Promise<{ bytesWritten: number; buffers: ArrayBufferView[] }> {
		const views = buffersArg(buffers);
		const bytesWritten = await this.#run("write", (fd) =>
			writevCore(this.#context.core, fd, views, position ?? null),
		);
		return { bytesWritten, buffers };
	}

	readFile(options?: unknown): Promise<string | Buffer> {
		if (this.#fd < 0) {
			return Promise.reject(fsError("EBADF", "read"));
		}
		return this.#context.readFile(this.#fd, options);
	}

	writeFile(data: unknown, options?: unknown): Promise<void> {
		if (this.#fd < 0) {
			return Promise.reject(fsError("EBADF", "write"));
		}
		return this.#context.writeFile(this.#fd, data, options);
	}

	appendFile(data: unknown, options?: unknown): Promise<void> {
		return this.writeFile(data, options);
	}

	stat(_options?: unknown): Promise<Stats> {
		return this.#run("fstat", (fd) => this.#context.core.fstat(fd));
	}

	truncate(length?: number): Promise<void> {
		const len = lengthArg(length);
		return this.#run("ftruncate", (fd) => this.#context.core.ftruncate(fd, len));
	}

	utimes(atime: unknown, mtime: unknown): Promise<void> {
		const atimeMs = timeArg(atime, "atime");
		const mtimeMs = timeArg(mtime, "mtime");
		return this.#run("futime", (fd) => this.#context.core.futimes(fd, atimeMs, mtimeMs));
	}

	chmod(mode: unknown): Promise<void> {
		const value = modeArg(mode, 0);
		return this.#run("fchmod", (fd) => this.#context.core.fchmod(fd, value));
	}

	chown(uid: unknown, gid: unknown): Promise<void> {
		const u = integerArg(uid, "uid", -1);
		const g = integerArg(gid, "gid", -1);
		return this.#run("fchown", (fd) => this.#context.core.fchown(fd, u, g));
	}

	async sync(): Promise<void> {
		if (this.#fd < 0) {
			throw fsError("EBADF", "fsync");
		}
		await this.#context.core.fsync(this.#fd);
	}

	datasync(): Promise<void> {
		return this.sync();
	}

	close(): Promise<void> {
		if (this.#closing) {
			return this.#closing;
		}
		const fd = this.#fd;
		if (fd < 0) {
			return Promise.resolve();
		}
		this.#closing = this.#context.core
			.run(() => this.#context.core.close(fd))
			.then(() => {
				this.#fd = -1;
				this.#closing = null;
				this.emit("close");
			});
		return this.#closing;
	}

	createReadStream(options?: unknown): ReadStream {
		return this.#context.createReadStream(this, options);
	}

	createWriteStream(options?: unknown): WriteStream {
		return this.#context.createWriteStream(this, options);
	}

	async *readLines(options?: unknown): AsyncGenerator<string, void, undefined> {
		const opts = optionsArg(options);
		const text = await this.readFile({ encoding: opts.encoding ?? "utf8" });
		const lines = String(text).split(/\r?\n/);
		if (lines.at(-1) === "") {
			lines.pop();
		}
		yield* lines;
	}
}

export function readvCore(core: VfsCore, fd: number, buffers: Uint8Array[], position: number | null): number {
	let total = 0;
	let pos = position;
	for (const buffer of buffers) {
		const count = core.read(fd, buffer, 0, buffer.byteLength, pos);
		total += count;
		if (pos !== null) {
			pos += count;
		}
		if (count < buffer.byteLength) {
			break;
		}
	}
	return total;
}

export function writevCore(core: VfsCore, fd: number, buffers: Uint8Array[], position: number | null): number {
	const size = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const buffer of buffers) {
		bytes.set(buffer, offset);
		offset += buffer.byteLength;
	}
	return core.write(fd, bytes, position);
}

const asyncDispose: unknown = Reflect.get(Symbol, "asyncDispose");
if (typeof asyncDispose === "symbol") {
	Object.defineProperty(FileHandle.prototype, asyncDispose, {
		configurable: true,
		writable: true,
		value(this: FileHandle) {
			return this.close();
		},
	});
}

export function isFileHandle(value: unknown): value is FileHandle {
	return value instanceof FileHandle || (isObject(value) && value.constructor === FileHandle);
}
