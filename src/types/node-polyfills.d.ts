declare module "events" {
	type Listener = (...args: never[]) => unknown;
	export class EventEmitter {
		static defaultMaxListeners: number;
		static once(emitter: EventEmitter, event: string): Promise<unknown[]>;
		on(event: string | symbol, listener: Listener): this;
		addListener(event: string | symbol, listener: Listener): this;
		prependListener(event: string | symbol, listener: Listener): this;
		once(event: string | symbol, listener: Listener): this;
		prependOnceListener(event: string | symbol, listener: Listener): this;
		off(event: string | symbol, listener: Listener): this;
		removeListener(event: string | symbol, listener: Listener): this;
		removeAllListeners(event?: string | symbol): this;
		emit(event: string | symbol, ...args: unknown[]): boolean;
		listeners(event: string | symbol): Listener[];
		rawListeners(event: string | symbol): Listener[];
		listenerCount(event: string | symbol): number;
		eventNames(): Array<string | symbol>;
		setMaxListeners(count: number): this;
		getMaxListeners(): number;
	}
	export default EventEmitter;
}

declare module "util" {
	const util: Record<string, unknown> & {
		inherits(ctor: unknown, superCtor: unknown): void;
		promisify<T extends (...args: never[]) => unknown>(fn: T): (...args: unknown[]) => Promise<unknown>;
		format(format: unknown, ...args: unknown[]): string;
		inspect(value: unknown, options?: unknown): string;
	};
	export default util;
}

declare module "readable-stream" {
	import { EventEmitter } from "events";

	type Callback = (error?: Error | null) => void;

	export interface ReadableOptions {
		highWaterMark?: number;
		encoding?: string;
		objectMode?: boolean;
		emitClose?: boolean;
		autoDestroy?: boolean;
		signal?: AbortSignal;
		read?(this: Readable, size: number): void;
		destroy?(this: Readable, error: Error | null, callback: Callback): void;
	}

	export interface WritableOptions {
		highWaterMark?: number;
		decodeStrings?: boolean;
		defaultEncoding?: string;
		objectMode?: boolean;
		emitClose?: boolean;
		autoDestroy?: boolean;
		signal?: AbortSignal;
		write?(this: Writable, chunk: unknown, encoding: string, callback: Callback): void;
		final?(this: Writable, callback: Callback): void;
		destroy?(this: Writable, error: Error | null, callback: Callback): void;
	}

	export interface DuplexOptions extends ReadableOptions, WritableOptions {
		allowHalfOpen?: boolean;
		readableObjectMode?: boolean;
		writableObjectMode?: boolean;
	}

	export class Stream extends EventEmitter {
		pipe<T>(destination: T, options?: { end?: boolean }): T;
	}

	export class Readable extends Stream {
		constructor(options?: ReadableOptions);
		static from(iterable: unknown, options?: ReadableOptions): Readable;
		readable: boolean;
		readonly readableEnded: boolean;
		readonly readableLength: number;
		readonly destroyed: boolean;
		_construct?(callback: Callback): void;
		_read(size: number): void;
		_destroy(error: Error | null, callback: Callback): void;
		read(size?: number): unknown;
		push(chunk: unknown, encoding?: string): boolean;
		unshift(chunk: unknown): void;
		pause(): this;
		resume(): this;
		isPaused(): boolean;
		setEncoding(encoding: string): this;
		unpipe(destination?: unknown): this;
		destroy(error?: Error): this;
		[Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
	}

	export class Writable extends Stream {
		constructor(options?: WritableOptions);
		writable: boolean;
		readonly writableEnded: boolean;
		readonly writableFinished: boolean;
		readonly destroyed: boolean;
		_construct?(callback: Callback): void;
		_write(chunk: unknown, encoding: string, callback: Callback): void;
		_final(callback: Callback): void;
		_destroy(error: Error | null, callback: Callback): void;
		write(chunk: unknown, encoding?: string | Callback, callback?: Callback): boolean;
		end(chunk?: unknown, encoding?: string | Callback, callback?: Callback): this;
		cork(): void;
		uncork(): void;
		setDefaultEncoding(encoding: string): this;
		destroy(error?: Error): this;
	}

	export class Duplex extends Readable {
		constructor(options?: DuplexOptions);
		writable: boolean;
		readonly writableEnded: boolean;
		readonly writableFinished: boolean;
		_write(chunk: unknown, encoding: string, callback: Callback): void;
		_final(callback: Callback): void;
		write(chunk: unknown, encoding?: string | Callback, callback?: Callback): boolean;
		end(chunk?: unknown, encoding?: string | Callback, callback?: Callback): this;
		cork(): void;
		uncork(): void;
		setDefaultEncoding(encoding: string): this;
	}

	export class Transform extends Duplex {
		_transform(chunk: unknown, encoding: string, callback: (error?: Error | null, data?: unknown) => void): void;
		_flush(callback: (error?: Error | null, data?: unknown) => void): void;
	}

	export class PassThrough extends Transform {}

	export function pipeline(...args: unknown[]): unknown;
	export function finished(...args: unknown[]): unknown;
	export function addAbortSignal(signal: AbortSignal, stream: Stream): Stream;
	export const promises: Record<string, (...args: unknown[]) => Promise<unknown>>;
}

declare module "string_decoder" {
	export class StringDecoder {
		constructor(encoding?: string);
		write(buffer: Uint8Array): string;
		end(buffer?: Uint8Array): string;
	}
}

declare module "assert" {
	const assert: ((value: unknown, message?: string) => void) & Record<string, unknown>;
	export default assert;
}
