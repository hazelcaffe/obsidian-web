import { Buffer } from "buffer";
import {
	buffersArg,
	callbackArg,
	checkAborted,
	encodingOption,
	fdArg,
	flagsArg,
	integerArg,
	isObject,
	lengthArg,
	modeArg,
	optionsArg,
	readArgs,
	timeArg,
	writeArgs,
} from "./args.ts";
import { constants, F_OK, O_APPEND, O_CREAT, O_RDONLY, O_TRUNC, O_WRONLY } from "./constants.ts";
import type { VfsCore } from "./core.ts";
import { cpAsync, cpSync } from "./cp.ts";
import { Dir } from "./dir.ts";
import {
	bytesToResult,
	concatBytes,
	dataToBytes,
	type Encoding,
	type EncodingOption,
	encodeString,
	isArrayBufferView,
	stringToResult,
} from "./encoding.ts";
import { abortError, invalidArgType } from "./errors.ts";
import { FileHandle, type FileHandleContext, isFileHandle, readvCore, writevCore } from "./file-handle.ts";
import type { FsNode } from "./nodes.ts";
import { type PathLike, pathArg } from "./path.ts";
import { DIRENT_DIR, DIRENT_FILE, DIRENT_LINK, Dirent, StatFs, Stats } from "./stats.ts";
import { ReadStream, type StreamOps, WriteStream } from "./streams.ts";
import { FSWatcher, type StatWatcher, type WatchEventType } from "./watch.ts";

export type PathOrFd = PathLike | number;
export type Flag = string | number;
export type ReadFileOptions =
	| EncodingOption
	| null
	| { encoding?: EncodingOption | null; flag?: Flag; signal?: AbortSignal };
export type WriteFileOptions =
	| Encoding
	| null
	| { encoding?: Encoding | null; mode?: number | string; flag?: Flag; signal?: AbortSignal; flush?: boolean };
export type WriteData = string | ArrayBufferView;
export type StatOptions = { bigint?: boolean; throwIfNoEntry?: boolean };
export type ReaddirOptions =
	| EncodingOption
	| null
	| { encoding?: EncodingOption | null; withFileTypes?: boolean; recursive?: boolean };
export type MkdirOptions = number | string | { recursive?: boolean; mode?: number | string };
export type RmOptions = { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number };
export type WatchListener = (eventType: WatchEventType, filename: string | Buffer | null) => void;
export type TimeLike = number | string | Date;
export type WatchOptions = {
	recursive?: boolean;
	encoding?: EncodingOption;
	persistent?: boolean;
	signal?: AbortSignal;
};
export type EncodingOptionArg = EncodingOption | { encoding?: EncodingOption | null } | null;
export type StatListener = (current: Stats, previous: Stats) => void;

type Callback = (...args: unknown[]) => void;

const WRITE_FLAGS = O_TRUNC | O_CREAT | O_WRONLY;
const APPEND_FLAGS = O_APPEND | O_CREAT | O_WRONLY;

function direntType(node: FsNode): number {
	return node.kind === "dir" ? DIRENT_DIR : node.kind === "symlink" ? DIRENT_LINK : DIRENT_FILE;
}

function encodeName(name: string, encoding: EncodingOption | undefined): string | Buffer {
	if (encoding === "buffer") {
		return Buffer.from(name);
	}
	if (encoding === undefined || encoding === "utf8" || encoding === "utf-8") {
		return name;
	}
	return Buffer.from(name).toString(encoding);
}

function joinDisplay(base: string, relative: string): string {
	if (!relative) {
		return base;
	}
	const trimmed = base.length > 1 ? base.replace(/\/+$/, "") : base;
	return trimmed === "/" ? `/${relative}` : `${trimmed}/${relative}`;
}

function isIterable(value: unknown): value is Iterable<unknown> {
	return isObject(value) && typeof Reflect.get(value, Symbol.iterator) === "function";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return isObject(value) && typeof Reflect.get(value, Symbol.asyncIterator) === "function";
}

function isStatListener(value: unknown): value is StatListener {
	return typeof value === "function";
}

function isWatchListener(value: unknown): value is WatchListener {
	return typeof value === "function";
}

function attach<F extends object, P extends object>(fn: F, props: P): F & P {
	return Object.assign(fn, props);
}

export function createFsModule(core: VfsCore) {
	const run = <T>(fn: () => T): Promise<T> => core.run(fn);

	/** Callback-style wrapper around a promise-returning implementation. */
	function withCallback<R>(
		fn: (...args: never[]) => Promise<R>,
		spread?: (result: R) => unknown[],
		optionalCallback = false,
	): (...args: unknown[]) => void {
		return (...args: unknown[]): void => {
			const last = args.at(-1);
			let cb: Callback | null = null;
			if (typeof last === "function" || !optionalCallback) {
				cb = callbackArg(args.pop());
			}
			const promise: Promise<R> = Reflect.apply(fn, undefined, args);
			promise.then(
				(result) => {
					if (!cb) {
						return;
					}
					const done = cb;
					queueMicrotask(() => {
						if (spread) {
							done(null, ...spread(result));
						} else if (result === undefined) {
							done(null);
						} else {
							done(null, result);
						}
					});
				},
				(error: unknown) => {
					if (cb) {
						const done = cb;
						queueMicrotask(() => done(error));
					} else {
						console.error(error);
					}
				},
			);
		};
	}

	// ------------------------------------------------------------ sync implementations

	function accessSync(path: PathLike, mode?: number): void {
		core.access(path, mode === undefined || mode === null ? F_OK : integerArg(mode, "mode"));
	}

	function existsSync(path: PathLike): boolean {
		return core.exists(path);
	}

	function statSync(path: PathLike, options?: StatOptions & { throwIfNoEntry?: true }): Stats;
	function statSync(path: PathLike, options: StatOptions): Stats | undefined;
	function statSync(path: PathLike, options?: StatOptions): Stats | undefined {
		return core.stat(path, true, optionsArg(options).throwIfNoEntry !== false);
	}

	function lstatSync(path: PathLike, options?: StatOptions & { throwIfNoEntry?: true }): Stats;
	function lstatSync(path: PathLike, options: StatOptions): Stats | undefined;
	function lstatSync(path: PathLike, options?: StatOptions): Stats | undefined {
		return core.stat(path, false, optionsArg(options).throwIfNoEntry !== false);
	}

	function fstatSync(fd: number, _options?: StatOptions): Stats {
		return core.fstat(fdArg(fd));
	}

	function statfsSync(path: PathLike, _options?: { bigint?: boolean }): StatFs {
		return core.statfs(path);
	}

	function readFileImpl(path: unknown, options: unknown): string | Buffer {
		const opts = optionsArg(options);
		const encoding = encodingOption(opts);
		const target = isFileHandle(path) ? path.fd : typeof path === "number" ? fdArg(path) : path;
		return bytesToResult(core.readFile(target, flagsArg(opts.flag, O_RDONLY)), encoding);
	}

	function readFileSync(path: PathOrFd, options: Encoding | { encoding: Encoding; flag?: Flag }): string;
	function readFileSync(
		path: PathOrFd,
		options?: { encoding?: null | "buffer"; flag?: Flag } | "buffer" | null,
	): Buffer;
	function readFileSync(path: PathOrFd, options?: ReadFileOptions): string | Buffer;
	function readFileSync(path: PathOrFd, options?: ReadFileOptions): string | Buffer {
		return readFileImpl(path, options);
	}

	function writeFileSync(file: PathOrFd, data: WriteData, options?: WriteFileOptions): void {
		writeWithFlags(file, data, options, WRITE_FLAGS);
	}

	function appendFileSync(file: PathOrFd, data: WriteData, options?: WriteFileOptions): void {
		writeWithFlags(file, data, options, APPEND_FLAGS);
	}

	function writeWithFlags(file: unknown, data: unknown, options: unknown, defaultFlags: number): void {
		const opts = optionsArg(options);
		const bytes = dataToBytes(data, encodingOption(opts, "utf8"));
		const target = typeof file === "number" ? fdArg(file) : file;
		core.writeFile(target, bytes, flagsArg(opts.flag, defaultFlags), modeArg(opts.mode, 0o666));
	}

	function readdirSync(
		path: PathLike,
		options?: "buffer" | { encoding: "buffer"; withFileTypes?: false; recursive?: boolean },
	): Buffer[];
	function readdirSync(
		path: PathLike,
		options: { encoding?: EncodingOption | null; withFileTypes: true; recursive?: boolean },
	): Dirent[];
	function readdirSync(
		path: PathLike,
		options?: Encoding | null | { encoding?: Encoding | null; withFileTypes?: false; recursive?: boolean },
	): string[];
	function readdirSync(path: PathLike, options?: ReaddirOptions): Array<string | Buffer | Dirent<string | Buffer>>;
	function readdirSync(path: PathLike, options?: ReaddirOptions): Array<string | Buffer | Dirent<string | Buffer>> {
		const opts = optionsArg(options);
		const encoding = encodingOption(opts, "utf8");
		const entries = core.readdir(path, opts.recursive === true);
		if (opts.withFileTypes === true) {
			const display = pathArg(path);
			return entries.map(
				(entry) =>
					new Dirent<string | Buffer>(
						encodeName(entry.name, encoding),
						direntType(entry.node),
						joinDisplay(display, entry.parentRelative),
					),
			);
		}
		return entries.map((entry) => encodeName(entry.relative, encoding));
	}

	function opendirSync(
		path: PathLike,
		options?: { encoding?: EncodingOption | null; bufferSize?: number; recursive?: boolean },
	): Dir {
		const opts = optionsArg(options);
		const encoding = encodingOption(opts, "utf8");
		const display = pathArg(path);
		const entries = core.readdir(path, opts.recursive === true, "opendir");
		return new Dir(
			display,
			entries.map(
				(entry) =>
					new Dirent<string | Buffer>(
						encodeName(entry.name, encoding),
						direntType(entry.node),
						joinDisplay(display, entry.parentRelative),
					),
			),
		);
	}

	function mkdirSync(path: PathLike, options?: MkdirOptions | null): string | undefined {
		let recursive = false;
		let mode: unknown;
		if (typeof options === "number" || typeof options === "string") {
			mode = options;
		} else if (isObject(options)) {
			recursive = options.recursive === true;
			mode = options.mode;
		}
		return core.mkdir(path, recursive, modeArg(mode, 0o777));
	}

	function mkdtempSync(prefix: string, options?: Encoding | { encoding?: Encoding | null } | null): string;
	function mkdtempSync(prefix: string, options: "buffer" | { encoding: "buffer" }): Buffer;
	function mkdtempSync(prefix: string, options?: EncodingOptionArg): string | Buffer;
	function mkdtempSync(prefix: string, options?: EncodingOptionArg): string | Buffer {
		return stringToResult(core.mkdtemp(prefix), encodingOption(optionsArg(options), "utf8"));
	}

	function rmdirSync(
		path: PathLike,
		options?: { recursive?: boolean; maxRetries?: number; retryDelay?: number },
	): void {
		core.rmdir(path, optionsArg(options).recursive === true);
	}

	function rmSync(path: PathLike, options?: RmOptions): void {
		const opts = optionsArg(options);
		core.rm(path, opts.recursive === true, opts.force === true);
	}

	function unlinkSync(path: PathLike): void {
		core.unlink(path);
	}

	function renameSync(oldPath: PathLike, newPath: PathLike): void {
		core.rename(oldPath, newPath);
	}

	function copyFileSync(src: PathLike, dest: PathLike, mode?: number): void {
		core.copyFile(src, dest, mode === undefined || mode === null ? 0 : integerArg(mode, "mode"));
	}

	function symlinkSync(target: PathLike, path: PathLike, _type?: string | null): void {
		core.symlink(target, path);
	}

	function readlinkSync(path: PathLike, options?: Encoding | { encoding?: Encoding | null } | null): string;
	function readlinkSync(path: PathLike, options: "buffer" | { encoding: "buffer" }): Buffer;
	function readlinkSync(path: PathLike, options?: EncodingOptionArg): string | Buffer;
	function readlinkSync(path: PathLike, options?: EncodingOptionArg): string | Buffer {
		return stringToResult(core.readlink(path), encodingOption(optionsArg(options), "utf8"));
	}

	function linkSync(existingPath: PathLike, newPath: PathLike): void {
		core.link(existingPath, newPath);
	}

	function truncateSync(path: PathOrFd, len?: number | null): void {
		const length = lengthArg(len);
		if (typeof path === "number") {
			core.ftruncate(fdArg(path), length);
		} else {
			core.truncate(path, length);
		}
	}

	function ftruncateSync(fd: number, len?: number | null): void {
		core.ftruncate(fdArg(fd), lengthArg(len));
	}

	function utimesSync(path: PathLike, atime: TimeLike, mtime: TimeLike): void {
		core.utimes(path, timeArg(atime, "atime"), timeArg(mtime, "mtime"), true);
	}

	function lutimesSync(path: PathLike, atime: TimeLike, mtime: TimeLike): void {
		core.utimes(path, timeArg(atime, "atime"), timeArg(mtime, "mtime"), false);
	}

	function futimesSync(fd: number, atime: TimeLike, mtime: TimeLike): void {
		core.futimes(fdArg(fd), timeArg(atime, "atime"), timeArg(mtime, "mtime"));
	}

	function chmodSync(path: PathLike, mode: number | string): void {
		core.chmod(path, modeArg(mode, 0), true);
	}

	function fchmodSync(fd: number, mode: number | string): void {
		core.fchmod(fdArg(fd), modeArg(mode, 0));
	}

	function chownSync(path: PathLike, uid: number, gid: number): void {
		core.chown(path, integerArg(uid, "uid", -1), integerArg(gid, "gid", -1), true);
	}

	function lchownSync(path: PathLike, uid: number, gid: number): void {
		core.chown(path, integerArg(uid, "uid", -1), integerArg(gid, "gid", -1), false);
	}

	function fchownSync(fd: number, uid: number, gid: number): void {
		core.fchown(fdArg(fd), integerArg(uid, "uid", -1), integerArg(gid, "gid", -1));
	}

	function realpathSyncImpl(path: PathLike, options?: Encoding | { encoding?: Encoding | null } | null): string;
	function realpathSyncImpl(path: PathLike, options: "buffer" | { encoding: "buffer" }): Buffer;
	function realpathSyncImpl(path: PathLike, options?: EncodingOptionArg): string | Buffer;
	function realpathSyncImpl(path: PathLike, options?: EncodingOptionArg): string | Buffer {
		return stringToResult(core.realpath(path, "lstat"), encodingOption(optionsArg(options), "utf8"));
	}

	function realpathNativeSync(path: PathLike, options?: Encoding | { encoding?: Encoding | null } | null): string;
	function realpathNativeSync(path: PathLike, options: "buffer" | { encoding: "buffer" }): Buffer;
	function realpathNativeSync(path: PathLike, options?: EncodingOptionArg): string | Buffer;
	function realpathNativeSync(path: PathLike, options?: EncodingOptionArg): string | Buffer {
		return stringToResult(core.realpath(path, "realpath"), encodingOption(optionsArg(options), "utf8"));
	}

	function openSync(path: PathLike, flags?: Flag | null, mode?: number | string | null): number {
		return core.open(path, flagsArg(flags, O_RDONLY), modeArg(mode, 0o666));
	}

	function closeSync(fd: number): void {
		core.close(fdArg(fd));
	}

	function readSync(
		fd: number,
		buffer: ArrayBufferView,
		offsetOrOptions?: unknown,
		length?: number | null,
		position?: unknown,
	): number {
		const slice = readArgs(buffer, offsetOrOptions, length, position);
		return core.read(fdArg(fd), slice.buffer, slice.offset, slice.length, slice.position);
	}

	function writeSync(fd: number, data: WriteData, a?: unknown, b?: unknown, c?: unknown): number {
		const parsed = writeArgs(data, a, b, c);
		return core.write(fdArg(fd), parsed.bytes, parsed.position);
	}

	function readvSync(fd: number, buffers: ArrayBufferView[], position?: number | null): number {
		return readvCore(core, fdArg(fd), buffersArg(buffers), position ?? null);
	}

	function writevSync(fd: number, buffers: ArrayBufferView[], position?: number | null): number {
		return writevCore(core, fdArg(fd), buffersArg(buffers), position ?? null);
	}

	function fsyncSync(fd: number): void {
		core.fdNode(fdArg(fd), "fsync");
	}

	function fdatasyncSync(fd: number): void {
		core.fdNode(fdArg(fd), "fdatasync");
	}

	// ------------------------------------------------------------ async implementations

	async function readFileAsync(path: unknown, options?: unknown): Promise<string | Buffer> {
		const opts = optionsArg(options);
		checkAborted(opts.signal);
		const result = await run(() => readFileImpl(path, options));
		checkAborted(opts.signal);
		return result;
	}

	async function collectData(
		data: unknown,
		encoding: EncodingOption | undefined,
		signal: unknown,
	): Promise<Uint8Array<ArrayBuffer>> {
		if (typeof data === "string" || isArrayBufferView(data) || data instanceof ArrayBuffer) {
			return dataToBytes(data, encoding);
		}
		if (!isAsyncIterable(data) && !isIterable(data)) {
			throw invalidArgType(
				"data",
				"of type string or an instance of Buffer, TypedArray, DataView, or Iterable",
				data,
			);
		}
		const chunks: Uint8Array[] = [];
		const iterable: AsyncIterable<unknown> | Iterable<unknown> = data;
		for await (const chunk of iterable) {
			checkAborted(signal);
			chunks.push(
				typeof chunk === "string" ? encodeString(chunk, encoding) : dataToBytes(chunk, encoding, "chunk"),
			);
		}
		return concatBytes(chunks);
	}

	async function writeAsync(file: unknown, data: unknown, options: unknown, defaultFlags: number): Promise<void> {
		const opts = optionsArg(options);
		checkAborted(opts.signal);
		const bytes = await collectData(data, encodingOption(opts, "utf8"), opts.signal);
		checkAborted(opts.signal);
		const target = isFileHandle(file) ? file.fd : typeof file === "number" ? fdArg(file) : file;
		const flags = flagsArg(opts.flag, defaultFlags);
		const mode = modeArg(opts.mode, 0o666);
		await run(() => core.writeFile(target, bytes, flags, mode));
	}

	const writeFileAsync = (file: PathOrFd | FileHandle, data: unknown, options?: WriteFileOptions): Promise<void> =>
		writeAsync(file, data, options, WRITE_FLAGS);
	const appendFileAsync = (file: PathOrFd | FileHandle, data: unknown, options?: WriteFileOptions): Promise<void> =>
		writeAsync(file, data, options, APPEND_FLAGS);

	function promisify<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => Promise<R> {
		return (...args: A) => run(() => fn(...args));
	}

	async function readAsync(
		fd: number,
		bufferOrOptions?: unknown,
		offsetOrOptions?: unknown,
		length?: unknown,
		position?: unknown,
	): Promise<{ bytesRead: number; buffer: ArrayBufferView }> {
		let buffer: ArrayBufferView;
		let offsetArg = offsetOrOptions;
		if (isArrayBufferView(bufferOrOptions)) {
			buffer = bufferOrOptions;
		} else {
			const opts = optionsArg(bufferOrOptions);
			buffer = isArrayBufferView(opts.buffer) ? opts.buffer : Buffer.alloc(16384);
			offsetArg = opts;
		}
		const slice = readArgs(buffer, offsetArg, length, position);
		const bytesRead = await run(() =>
			core.read(fdArg(fd), slice.buffer, slice.offset, slice.length, slice.position),
		);
		return { bytesRead, buffer };
	}

	async function writeAsyncFd<T>(
		fd: number,
		data: T,
		a?: unknown,
		b?: unknown,
		c?: unknown,
	): Promise<{ bytesWritten: number; buffer: T }> {
		const parsed = writeArgs(data, a, b, c);
		const bytesWritten = await run(() => core.write(fdArg(fd), parsed.bytes, parsed.position));
		return { bytesWritten, buffer: data };
	}

	async function readvAsync(fd: number, buffers: ArrayBufferView[], position?: number | null) {
		const bytesRead = await run(() => readvSync(fd, buffers, position));
		return { bytesRead, buffers };
	}

	async function writevAsync(fd: number, buffers: ArrayBufferView[], position?: number | null) {
		const bytesWritten = await run(() => writevSync(fd, buffers, position));
		return { bytesWritten, buffers };
	}

	async function fsyncAsync(fd: number): Promise<void> {
		await core.fsync(fdArg(fd));
	}

	const streamOps: StreamOps = {
		open: (path, flags, mode) => run(() => core.open(path, flags, mode)),
		read: (fd, buffer, offset, length, position) => run(() => core.read(fd, buffer, offset, length, position)),
		write: (fd, bytes, position) => run(() => core.write(fd, bytes, position)),
		close: (fd) => run(() => core.close(fd)),
		fsync: (fd) => core.fsync(fd),
	};

	/** `fs.ReadStream` bound to this file system, constructible like Node's `new fs.ReadStream(path, options)`. */
	class FsReadStream extends ReadStream {
		constructor(path: PathLike | null, options?: unknown) {
			super(streamOps, path, typeof options === "string" ? { encoding: options } : options);
		}
	}

	class FsWriteStream extends WriteStream {
		constructor(path: PathLike | null, options?: unknown) {
			super(streamOps, path, typeof options === "string" ? { encoding: options } : options);
		}
	}

	function createReadStream(path: PathLike | null, options?: unknown): ReadStream {
		return new FsReadStream(path, options);
	}

	function createWriteStream(path: PathLike | null, options?: unknown): WriteStream {
		return new FsWriteStream(path, options);
	}

	const handleContext: FileHandleContext = {
		core,
		readFile: readFileAsync,
		writeFile: (fd, data, options) => writeAsync(fd, data, options, WRITE_FLAGS),
		createReadStream: (handle, options) => new FsReadStream(null, { ...optionsArg(options), fd: handle }),
		createWriteStream: (handle, options) => new FsWriteStream(null, { ...optionsArg(options), fd: handle }),
	};

	async function openAsync(path: PathLike, flags?: Flag | null, mode?: number | string | null): Promise<FileHandle> {
		const fd = await run(() => openSync(path, flags, mode));
		return new FileHandle(fd, handleContext);
	}

	async function opendirAsync(
		path: PathLike,
		options?: { encoding?: EncodingOption | null; bufferSize?: number; recursive?: boolean },
	): Promise<Dir> {
		return run(() => opendirSync(path, options));
	}

	async function openAsBlob(path: PathLike, options?: { type?: string }): Promise<Blob> {
		const bytes = await run(() => {
			const data = core.readFile(path, O_RDONLY);
			return data.slice();
		});
		return new Blob([bytes], { type: typeof options?.type === "string" ? options.type : "" });
	}

	// ------------------------------------------------------------ watching

	function watch(filename: PathLike, listener?: WatchListener): FSWatcher;
	function watch(
		filename: PathLike,
		options?: WatchOptions | EncodingOption | null,
		listener?: WatchListener,
	): FSWatcher;
	function watch(filename: PathLike, options?: unknown, listener?: WatchListener): FSWatcher {
		let opts = options;
		let callback = listener;
		if (isWatchListener(options)) {
			callback = options;
			opts = undefined;
		}
		const parsed = optionsArg(opts);
		const encoding = encodingOption(parsed, "utf8");
		const watcher: FSWatcher = new FSWatcher(() => unsubscribe());
		const unsubscribe = core.watch(filename, parsed.recursive === true, (eventType, name) => {
			watcher.emit("change", eventType, encoding === "buffer" ? Buffer.from(name) : name);
		});
		if (callback) {
			watcher.on("change", callback);
		}
		const signal = parsed.signal;
		if (signal instanceof AbortSignal) {
			if (signal.aborted) {
				queueMicrotask(() => watcher.close());
			} else {
				signal.addEventListener("abort", () => watcher.close(), { once: true });
			}
		}
		return watcher;
	}

	async function* watchAsync(
		filename: PathLike,
		options?: WatchOptions,
	): AsyncGenerator<{ eventType: WatchEventType; filename: string | Buffer }, void, undefined> {
		const parsed = optionsArg(options);
		const encoding = encodingOption(parsed, "utf8");
		const signal = parsed.signal instanceof AbortSignal ? parsed.signal : undefined;
		const queue: Array<{ eventType: WatchEventType; filename: string | Buffer }> = [];
		let wake: (() => void) | null = null;
		checkAborted(signal);
		const unsubscribe = core.watch(filename, parsed.recursive === true, (eventType, name) => {
			queue.push({ eventType, filename: encoding === "buffer" ? Buffer.from(name) : name });
			wake?.();
		});
		const onAbort = (): void => wake?.();
		signal?.addEventListener("abort", onAbort);
		try {
			for (;;) {
				if (signal?.aborted) {
					throw abortError(signal);
				}
				const next = queue.shift();
				if (next) {
					yield next;
					continue;
				}
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				wake = null;
			}
		} finally {
			unsubscribe();
			signal?.removeEventListener("abort", onAbort);
		}
	}

	function watchFile(filename: PathLike, listener: StatListener): StatWatcher;
	function watchFile(
		filename: PathLike,
		options: { interval?: number; persistent?: boolean; bigint?: boolean } | undefined,
		listener: StatListener,
	): StatWatcher;
	function watchFile(filename: PathLike, options?: unknown, listener?: StatListener): StatWatcher {
		const callback: unknown = typeof options === "function" ? options : listener;
		if (!isStatListener(callback)) {
			throw invalidArgType("listener", "of type function", callback);
		}
		const watcher = core.watchFile(filename);
		watcher.on("change", callback);
		return watcher;
	}

	function unwatchFile(filename: PathLike, listener?: StatListener): void {
		core.unwatchFile(filename, listener);
	}

	// ------------------------------------------------------------ module object

	const promises = {
		access: promisify(accessSync),
		appendFile: appendFileAsync,
		chmod: promisify(chmodSync),
		chown: promisify(chownSync),
		copyFile: promisify(copyFileSync),
		cp: (src: PathLike, dest: PathLike, options?: unknown): Promise<void> => cpAsync(core, src, dest, options),
		lchown: promisify(lchownSync),
		lutimes: promisify(lutimesSync),
		link: promisify(linkSync),
		lstat: (path: PathLike, options?: StatOptions): Promise<Stats> =>
			run(() => lstatSync(path, { ...options, throwIfNoEntry: true })),
		mkdir: promisify(mkdirSync),
		mkdtemp: promisify(mkdtempSync),
		open: openAsync,
		opendir: opendirAsync,
		readdir: promisify(readdirSync) as {
			(
				path: PathLike,
				options?: Encoding | null | { encoding?: Encoding | null; withFileTypes?: false; recursive?: boolean },
			): Promise<string[]>;
			(
				path: PathLike,
				options: { encoding?: EncodingOption | null; withFileTypes: true; recursive?: boolean },
			): Promise<Dirent[]>;
			(path: PathLike, options?: ReaddirOptions): Promise<Array<string | Buffer | Dirent<string | Buffer>>>;
		},
		readFile: readFileAsync as {
			(
				path: PathOrFd | FileHandle,
				options: Encoding | { encoding: Encoding; flag?: Flag; signal?: AbortSignal },
			): Promise<string>;
			(
				path: PathOrFd | FileHandle,
				options?: { encoding?: null | "buffer"; flag?: Flag; signal?: AbortSignal } | "buffer" | null,
			): Promise<Buffer>;
			(path: PathOrFd | FileHandle, options?: ReadFileOptions): Promise<string | Buffer>;
		},
		readlink: promisify(readlinkSync),
		realpath: promisify(realpathSyncImpl),
		rename: promisify(renameSync),
		rm: promisify(rmSync),
		rmdir: promisify(rmdirSync),
		stat: (path: PathLike, options?: StatOptions): Promise<Stats> =>
			run(() => statSync(path, { ...options, throwIfNoEntry: true })),
		statfs: promisify(statfsSync),
		symlink: promisify(symlinkSync),
		truncate: promisify(truncateSync),
		unlink: promisify(unlinkSync),
		utimes: promisify(utimesSync),
		watch: watchAsync,
		writeFile: writeFileAsync,
		constants,
		FileHandle,
	};

	const realpathSync = attach(realpathSyncImpl, { native: realpathNativeSync });
	const realpath = attach(withCallback(promisify(realpathSyncImpl)), {
		native: withCallback(promisify(realpathNativeSync)),
	});

	const fs = {
		...constants,
		constants,
		promises,

		Stats,
		Dirent,
		Dir,
		StatFs,
		ReadStream: FsReadStream,
		WriteStream: FsWriteStream,
		FileReadStream: FsReadStream,
		FileWriteStream: FsWriteStream,
		FSWatcher,

		accessSync,
		existsSync,
		statSync,
		lstatSync,
		fstatSync,
		statfsSync,
		readFileSync,
		writeFileSync,
		appendFileSync,
		readdirSync,
		opendirSync,
		mkdirSync,
		mkdtempSync,
		rmdirSync,
		rmSync,
		unlinkSync,
		renameSync,
		copyFileSync,
		cpSync: (src: PathLike, dest: PathLike, options?: unknown): void => cpSync(core, src, dest, options),
		symlinkSync,
		readlinkSync,
		linkSync,
		truncateSync,
		ftruncateSync,
		utimesSync,
		lutimesSync,
		futimesSync,
		chmodSync,
		fchmodSync,
		chownSync,
		lchownSync,
		fchownSync,
		realpathSync,
		openSync,
		closeSync,
		readSync,
		writeSync,
		readvSync,
		writevSync,
		fsyncSync,
		fdatasyncSync,

		access: withCallback(promises.access),
		appendFile: withCallback(appendFileAsync),
		chmod: withCallback(promises.chmod),
		chown: withCallback(promises.chown),
		close: withCallback(promisify(closeSync), undefined, true),
		copyFile: withCallback(promises.copyFile),
		cp: withCallback(promises.cp),
		exists(path: PathLike, callback: (exists: boolean) => void): void {
			const cb = callbackArg(callback);
			const result = core.exists(path);
			queueMicrotask(() => cb(result));
		},
		fchmod: withCallback(promisify(fchmodSync)),
		fchown: withCallback(promisify(fchownSync)),
		fdatasync: withCallback(fsyncAsync),
		fstat: withCallback(promisify(fstatSync)),
		fsync: withCallback(fsyncAsync),
		ftruncate: withCallback(promisify(ftruncateSync)),
		futimes: withCallback(promisify(futimesSync)),
		lchown: withCallback(promises.lchown),
		link: withCallback(promises.link),
		lstat: withCallback(promises.lstat),
		lutimes: withCallback(promises.lutimes),
		mkdir: withCallback(promises.mkdir),
		mkdtemp: withCallback(promises.mkdtemp),
		open: withCallback(promisify(openSync)),
		opendir: withCallback(opendirAsync),
		read: withCallback(readAsync, (result) => [result.bytesRead, result.buffer]),
		readdir: withCallback(promises.readdir),
		readFile: withCallback(readFileAsync),
		readlink: withCallback(promises.readlink),
		readv: withCallback(readvAsync, (result) => [result.bytesRead, result.buffers]),
		realpath,
		rename: withCallback(promises.rename),
		rm: withCallback(promises.rm),
		rmdir: withCallback(promises.rmdir),
		stat: withCallback(promises.stat),
		statfs: withCallback(promises.statfs),
		symlink: withCallback(promises.symlink),
		truncate: withCallback(promises.truncate),
		unlink: withCallback(promises.unlink),
		utimes: withCallback(promises.utimes),
		write: withCallback(writeAsyncFd, (result) => [result.bytesWritten, result.buffer]),
		writeFile: withCallback(writeFileAsync),
		writev: withCallback(writevAsync, (result) => [result.bytesWritten, result.buffers]),

		createReadStream,
		createWriteStream,
		openAsBlob,
		watch,
		watchFile,
		unwatchFile,
	};
	return fs;
}

export type NodeFsModule = ReturnType<typeof createFsModule>;
