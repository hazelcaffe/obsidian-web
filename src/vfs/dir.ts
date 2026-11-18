import type { Buffer } from "buffer";
import { callbackArg } from "./args.ts";
import { nodeError } from "./errors.ts";
import type { Dirent } from "./stats.ts";

type Callback<T> = (error: Error | null, value?: T) => void;

export class Dir {
	readonly path: string;
	readonly #entries: Array<Dirent<string | Buffer>>;
	#closed = false;

	constructor(path: string, entries: Array<Dirent<string | Buffer>>) {
		this.path = path;
		this.#entries = entries;
	}

	#check(): void {
		if (this.#closed) {
			throw nodeError("ERR_DIR_CLOSED", "Directory handle was closed");
		}
	}

	readSync(): Dirent<string | Buffer> | null {
		this.#check();
		return this.#entries.shift() ?? null;
	}

	read(): Promise<Dirent<string | Buffer> | null>;
	read(callback: Callback<Dirent<string | Buffer> | null>): void;
	read(callback?: Callback<Dirent<string | Buffer> | null>): Promise<Dirent<string | Buffer> | null> | undefined {
		const promise = Promise.resolve().then(() => this.readSync());
		if (callback === undefined) {
			return promise;
		}
		const cb = callbackArg(callback);
		promise.then(
			(entry) => queueMicrotask(() => cb(null, entry)),
			(error: unknown) => queueMicrotask(() => cb(error)),
		);
		return undefined;
	}

	closeSync(): void {
		this.#check();
		this.#closed = true;
	}

	close(): Promise<void>;
	close(callback: (error: Error | null) => void): void;
	close(callback?: (error: Error | null) => void): Promise<void> | undefined {
		const promise = Promise.resolve().then(() => this.closeSync());
		if (callback === undefined) {
			return promise;
		}
		const cb = callbackArg(callback);
		promise.then(
			() => queueMicrotask(() => cb(null)),
			(error: unknown) => queueMicrotask(() => cb(error)),
		);
		return undefined;
	}

	async *entries(): AsyncGenerator<Dirent<string | Buffer>, void, undefined> {
		try {
			for (let entry = this.readSync(); entry; entry = this.readSync()) {
				yield entry;
			}
		} finally {
			if (!this.#closed) {
				this.#closed = true;
			}
		}
	}

	[Symbol.asyncIterator](): AsyncGenerator<Dirent<string | Buffer>, void, undefined> {
		return this.entries();
	}
}

const asyncDispose: unknown = Reflect.get(Symbol, "asyncDispose");
const dispose: unknown = Reflect.get(Symbol, "dispose");
if (typeof asyncDispose === "symbol") {
	Object.defineProperty(Dir.prototype, asyncDispose, {
		configurable: true,
		writable: true,
		value(this: Dir) {
			return this.close().catch(() => {});
		},
	});
}
if (typeof dispose === "symbol") {
	Object.defineProperty(Dir.prototype, dispose, {
		configurable: true,
		writable: true,
		value(this: Dir) {
			try {
				this.closeSync();
			} catch {}
		},
	});
}
