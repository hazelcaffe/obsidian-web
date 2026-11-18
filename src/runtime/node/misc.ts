import { EventEmitter } from "events";
import { Readable, Writable } from "readable-stream";

function enosys(syscall: string, path?: string): Error {
	return Object.assign(new Error(`spawn ${path ?? syscall} ENOENT`), {
		code: "ENOENT",
		errno: -2,
		syscall,
		path,
	});
}

class ChildProcess extends EventEmitter {
	pid = undefined;
	exitCode: number | null = null;
	signalCode: string | null = null;
	killed = false;
	connected = false;
	stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
	stdout = new Readable({ read() {} });
	stderr = new Readable({ read() {} });
	stdio = [this.stdin, this.stdout, this.stderr];

	constructor(command: string) {
		super();
		queueMicrotask(() => {
			this.emit("error", enosys(`spawn ${command}`, command));
			this.stdout.push(null);
			this.stderr.push(null);
			this.exitCode = -2;
			this.emit("close", -2, null);
		});
	}

	kill(): boolean {
		return false;
	}

	ref(): void {}

	unref(): void {}

	disconnect(): void {}
}

/** There are no processes in the browser: spawning fails like a missing executable would. */
export const childProcess = {
	ChildProcess,
	spawn: (command: string) => new ChildProcess(command),
	fork: (command: string) => new ChildProcess(command),
	exec: (command: string, ...args: unknown[]) => {
		const callback = args.find((arg) => typeof arg === "function") as
			| ((error: Error | null, stdout: string, stderr: string) => void)
			| undefined;
		const child = new ChildProcess(command);
		child.on("error", (error: Error) => callback?.(error, "", ""));
		return child;
	},
	execFile: (file: string, ...args: unknown[]) => {
		const callback = args.find((arg) => typeof arg === "function") as
			| ((error: Error | null, stdout: string, stderr: string) => void)
			| undefined;
		const child = new ChildProcess(file);
		child.on("error", (error: Error) => callback?.(error, "", ""));
		return child;
	},
	spawnSync: (command: string) => ({
		pid: 0,
		output: [null, "", ""],
		stdout: "",
		stderr: "",
		status: null,
		signal: null,
		error: enosys("spawnSync", command),
	}),
	execSync: (command: string): never => {
		throw enosys("spawnSync /bin/sh", command);
	},
	execFileSync: (file: string): never => {
		throw enosys("spawnSync", file);
	},
};

export const timers = {
	setTimeout: globalThis.setTimeout.bind(globalThis),
	clearTimeout: globalThis.clearTimeout.bind(globalThis),
	setInterval: globalThis.setInterval.bind(globalThis),
	clearInterval: globalThis.clearInterval.bind(globalThis),
	setImmediate: (callback: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(callback, 0, ...args),
	clearImmediate: (handle: number) => clearTimeout(handle),
	promises: {
		setTimeout: <T>(ms?: number, value?: T) =>
			new Promise<T | undefined>((resolve) => setTimeout(() => resolve(value), ms)),
		setImmediate: <T>(value?: T) => new Promise<T | undefined>((resolve) => setTimeout(() => resolve(value), 0)),
		async *setInterval<T>(ms?: number, value?: T): AsyncGenerator<T | undefined> {
			while (true) {
				await new Promise((resolve) => setTimeout(resolve, ms));
				yield value;
			}
		},
		scheduler: {
			wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
			yield: () => new Promise((resolve) => setTimeout(resolve, 0)),
		},
	},
};

export const workerThreads = {
	isMainThread: true,
	parentPort: null,
	threadId: 0,
	workerData: null,
	resourceLimits: {},
	SHARE_ENV: Symbol("SHARE_ENV"),
	Worker: class Worker extends EventEmitter {
		constructor() {
			super();
			throw new Error("worker_threads is not supported in the browser; use Web Workers instead");
		}
	},
	MessageChannel,
	MessagePort,
	BroadcastChannel,
	markAsUntransferable: () => undefined,
	receiveMessageOnPort: () => undefined,
};

export const tty = {
	isatty: () => false,
	ReadStream: class ReadStream extends Readable {
		isTTY = false;
	},
	WriteStream: class WriteStream extends Writable {
		isTTY = false;
		columns = 80;
		rows = 24;
	},
};

function globalEval(code: string): unknown {
	// biome-ignore lint/security/noGlobalEval: vm.runInThisContext evaluates code in the global scope by definition.
	return globalThis.eval(code);
}

export const vm = {
	runInThisContext: (code: string) => globalEval(code),
	runInNewContext: (code: string, context: Record<string, unknown> = {}) => {
		const keys = Object.keys(context);
		return new Function(...keys, `return eval(${JSON.stringify(code)})`)(...keys.map((key) => context[key]));
	},
	createContext: (context: Record<string, unknown> = {}) => context,
	isContext: () => true,
	Script: class Script {
		readonly code: string;
		constructor(code: string) {
			this.code = code;
		}
		runInThisContext(): unknown {
			return globalEval(this.code);
		}
		runInNewContext(context?: Record<string, unknown>): unknown {
			return vm.runInNewContext(this.code, context);
		}
	},
};

class AsyncLocalStorage<T> {
	#store: T | undefined;

	getStore(): T | undefined {
		return this.#store;
	}

	run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
		const previous = this.#store;
		this.#store = store;
		try {
			return callback(...args);
		} finally {
			this.#store = previous;
		}
	}

	enterWith(store: T): void {
		this.#store = store;
	}

	exit<R>(callback: (...args: unknown[]) => R, ...args: unknown[]): R {
		return this.run(undefined as T, callback, ...args);
	}

	disable(): void {
		this.#store = undefined;
	}
}

export const asyncHooks = {
	AsyncLocalStorage,
	AsyncResource: class AsyncResource {
		runInAsyncScope<R>(fn: (...args: unknown[]) => R, thisArg?: unknown, ...args: unknown[]): R {
			return fn.apply(thisArg, args);
		}
		emitDestroy(): this {
			return this;
		}
		static bind<F>(fn: F): F {
			return fn;
		}
	},
	createHook: () => ({ enable() {}, disable() {} }),
	executionAsyncId: () => 1,
	triggerAsyncId: () => 0,
};

export const v8 = {
	getHeapStatistics: () => ({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: 4 * 1024 ** 3 }),
	serialize: (value: unknown) => new TextEncoder().encode(JSON.stringify(value)),
	deserialize: (data: Uint8Array) => JSON.parse(new TextDecoder().decode(data)) as unknown,
	setFlagsFromString: () => undefined,
};

export const readline = {
	createInterface: () => {
		const emitter = new EventEmitter();
		return Object.assign(emitter, {
			question: (_query: string, callback: (answer: string) => void) => callback(""),
			close: () => emitter.emit("close"),
			setPrompt: () => undefined,
			prompt: () => undefined,
			write: () => undefined,
			[Symbol.asyncIterator]: async function* () {},
		});
	},
	clearLine: () => true,
	cursorTo: () => true,
	moveCursor: () => true,
	emitKeypressEvents: () => undefined,
};

export const perfHooks = {
	performance: globalThis.performance,
	PerformanceObserver: globalThis.PerformanceObserver,
	monitorEventLoopDelay: () => ({ enable() {}, disable() {}, percentile: () => 0, mean: 0, max: 0, min: 0 }),
};
