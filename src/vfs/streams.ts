import { Buffer } from "buffer";
import { Readable, Writable } from "readable-stream";
import { flagsArg, integerArg, isObject, modeArg, optionsArg } from "./args.ts";
import { O_CREAT, O_RDONLY, O_TRUNC, O_WRONLY } from "./constants.ts";
import { encodeString, parseEncoding } from "./encoding.ts";
import { pathArg } from "./path.ts";

export interface StreamOps {
	open(path: string, flags: number, mode: number): Promise<number>;
	read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<number>;
	write(fd: number, bytes: Uint8Array, position: number | null): Promise<number>;
	close(fd: number): Promise<void>;
	fsync(fd: number): Promise<void>;
}

/** A FileHandle-like object passed as the `fd` option. */
interface HandleLike {
	fd: number;
	close(): Promise<void>;
}

type Callback = (error?: Error | null) => void;

function isHandleLike(value: unknown): value is HandleLike {
	return isObject(value) && typeof value.fd === "number" && typeof value.close === "function";
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function fdOption(value: unknown): { fd: number | null; handle: HandleLike | null } {
	if (value === undefined || value === null) {
		return { fd: null, handle: null };
	}
	if (isHandleLike(value)) {
		return { fd: value.fd, handle: value };
	}
	return { fd: integerArg(value, "fd", 0, 2147483647), handle: null };
}

function closeFd(ops: StreamOps, fd: number, handle: HandleLike | null, error: Error | null, callback: Callback): void {
	const closing = handle ? handle.close() : ops.close(fd);
	closing.then(
		() => callback(error),
		(closeError: unknown) => callback(error ?? toError(closeError)),
	);
}

export class ReadStream extends Readable {
	path: string;
	fd: number | null;
	flags: number;
	mode: number;
	start: number | undefined;
	end: number;
	pos: number | undefined;
	bytesRead = 0;
	pending: boolean;
	readonly #ops: StreamOps;
	readonly #handle: HandleLike | null;
	readonly #autoClose: boolean;

	constructor(ops: StreamOps, path: unknown, options?: unknown) {
		const opts = optionsArg(options);
		super({
			highWaterMark: typeof opts.highWaterMark === "number" ? opts.highWaterMark : 64 * 1024,
			emitClose: opts.emitClose !== false,
			autoDestroy: opts.autoClose !== false,
			signal: opts.signal instanceof AbortSignal ? opts.signal : undefined,
		});
		this.#ops = ops;
		const { fd, handle } = fdOption(opts.fd);
		this.#handle = handle;
		this.fd = fd;
		this.pending = fd === null;
		this.path = fd === null ? pathArg(path) : path === null || path === undefined ? "" : pathArg(path);
		this.flags = flagsArg(opts.flags, O_RDONLY);
		this.mode = modeArg(opts.mode, 0o666);
		this.#autoClose = opts.autoClose !== false;
		this.start = opts.start === undefined ? undefined : integerArg(opts.start, "start");
		this.end =
			opts.end === undefined || opts.end === Number.POSITIVE_INFINITY
				? Number.POSITIVE_INFINITY
				: integerArg(opts.end, "end");
		if (this.start !== undefined && this.start > this.end) {
			throw Object.assign(
				new RangeError(
					`The value of "start" is out of range. It must be <= "end" (here: ${this.end}). Received ${this.start}`,
				),
				{
					code: "ERR_OUT_OF_RANGE",
				},
			);
		}
		if (this.start === undefined && this.end !== Number.POSITIVE_INFINITY) {
			this.start = 0;
		}
		this.pos = this.start;
		const encoding = parseEncoding(opts.encoding);
		if (encoding && encoding !== "buffer") {
			this.setEncoding(encoding);
		}
	}

	override _construct(callback: Callback): void {
		if (this.fd !== null) {
			callback();
			return;
		}
		this.#ops.open(this.path, this.flags, this.mode).then(
			(fd) => {
				this.fd = fd;
				this.pending = false;
				this.emit("open", fd);
				this.emit("ready");
				callback();
			},
			(error: unknown) => callback(toError(error)),
		);
	}

	override _read(size: number): void {
		const fd = this.fd;
		if (fd === null) {
			this.destroy(new Error("ReadStream is not open"));
			return;
		}
		let toRead = size;
		if (this.end !== Number.POSITIVE_INFINITY) {
			toRead = Math.min(size, this.end - (this.pos ?? 0) + 1);
		}
		if (toRead <= 0) {
			this.push(null);
			return;
		}
		const buffer = Buffer.alloc(toRead);
		this.#ops.read(fd, buffer, 0, toRead, this.pos ?? null).then(
			(bytesRead) => {
				if (bytesRead === 0) {
					this.push(null);
					return;
				}
				if (this.pos !== undefined) {
					this.pos += bytesRead;
				}
				this.bytesRead += bytesRead;
				this.push(bytesRead === toRead ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, bytesRead));
			},
			(error: unknown) => this.destroy(toError(error)),
		);
	}

	override _destroy(error: Error | null, callback: Callback): void {
		const fd = this.fd;
		if (fd !== null && this.#autoClose) {
			this.fd = null;
			closeFd(this.#ops, fd, this.#handle, error, callback);
		} else {
			callback(error);
		}
	}

	close(callback?: Callback): void {
		if (callback) {
			this.once("close", () => callback());
		}
		this.destroy();
	}
}

export class WriteStream extends Writable {
	path: string;
	fd: number | null;
	flags: number;
	mode: number;
	start: number | undefined;
	pos: number | undefined;
	bytesWritten = 0;
	pending: boolean;
	readonly #ops: StreamOps;
	readonly #handle: HandleLike | null;
	readonly #autoClose: boolean;
	readonly #flush: boolean;
	readonly #encoding: string;
	#closed = false;

	constructor(ops: StreamOps, path: unknown, options?: unknown) {
		const opts = optionsArg(options);
		const encoding = parseEncoding(opts.encoding, "utf8") ?? "utf8";
		super({
			highWaterMark: typeof opts.highWaterMark === "number" ? opts.highWaterMark : 16 * 1024,
			decodeStrings: true,
			defaultEncoding: encoding === "buffer" ? "utf8" : encoding,
			emitClose: opts.emitClose !== false,
			autoDestroy: opts.autoClose !== false,
			signal: opts.signal instanceof AbortSignal ? opts.signal : undefined,
		});
		this.#ops = ops;
		const { fd, handle } = fdOption(opts.fd);
		this.#handle = handle;
		this.fd = fd;
		this.pending = fd === null;
		this.path = fd === null ? pathArg(path) : path === null || path === undefined ? "" : pathArg(path);
		this.flags = flagsArg(opts.flags, O_TRUNC | O_CREAT | O_WRONLY);
		this.mode = modeArg(opts.mode, 0o666);
		this.#autoClose = opts.autoClose !== false;
		this.#flush = opts.flush === true;
		this.#encoding = encoding === "buffer" ? "utf8" : encoding;
		this.start = opts.start === undefined ? undefined : integerArg(opts.start, "start");
		this.pos = this.start;
		this.once("close", () => {
			this.#closed = true;
		});
	}

	override _construct(callback: Callback): void {
		if (this.fd !== null) {
			callback();
			return;
		}
		this.#ops.open(this.path, this.flags, this.mode).then(
			(fd) => {
				this.fd = fd;
				this.pending = false;
				this.emit("open", fd);
				this.emit("ready");
				callback();
			},
			(error: unknown) => callback(toError(error)),
		);
	}

	override _write(chunk: unknown, encoding: string, callback: Callback): void {
		const fd = this.fd;
		if (fd === null) {
			callback(new Error("WriteStream is not open"));
			return;
		}
		const bytes =
			chunk instanceof Uint8Array
				? chunk
				: encodeString(String(chunk), parseEncoding(encoding === "buffer" ? this.#encoding : encoding, "utf8"));
		this.#ops.write(fd, bytes, this.pos ?? null).then(
			(written) => {
				this.bytesWritten += written;
				if (this.pos !== undefined) {
					this.pos += written;
				}
				callback();
			},
			(error: unknown) => callback(toError(error)),
		);
	}

	override _final(callback: Callback): void {
		if (this.#flush && this.fd !== null) {
			this.#ops.fsync(this.fd).then(
				() => callback(),
				(error: unknown) => callback(toError(error)),
			);
		} else {
			callback();
		}
	}

	override _destroy(error: Error | null, callback: Callback): void {
		const fd = this.fd;
		if (fd !== null && this.#autoClose) {
			this.fd = null;
			closeFd(this.#ops, fd, this.#handle, error, callback);
		} else {
			callback(error);
		}
	}

	close(callback?: Callback): void {
		if (callback) {
			if (this.#closed) {
				queueMicrotask(() => callback());
				return;
			}
			this.once("close", () => callback());
		}
		if (!this.#autoClose) {
			this.once("finish", () => this.destroy());
		}
		this.end();
	}

	destroySoon(): void {
		this.end();
	}
}
