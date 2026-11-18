import assert from "assert";
import zlib from "browserify-zlib";
import { Buffer } from "buffer";
import events, { type EventEmitter } from "events";
import path from "path-browserify";
import querystring from "querystring-es3";
import * as stream from "readable-stream";
import * as stringDecoder from "string_decoder";
import util from "util";
import { createElectronModule } from "../electron/index.ts";
import { getVfs } from "../vfs-instance.ts";
import { nodeCrypto } from "./crypto.ts";
import { createHttpModule } from "./http.ts";
import { asyncHooks, childProcess, perfHooks, readline, timers, tty, v8, vm, workerThreads } from "./misc.ts";
import { dns, net, tls } from "./net.ts";
import { os } from "./os.ts";
import { process } from "./process.ts";
import { builtinModules, createRequire, defineModule, defineWindowModule, loadModule } from "./registry.ts";
import { url } from "./url.ts";

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function eventsModule(): unknown {
	const emitter = events as unknown as Record<string, unknown>;
	emitter.on ??= (target: EventEmitter, name: string) => {
		const queue: unknown[][] = [];
		const waiting: Array<(value: IteratorResult<unknown[]>) => void> = [];
		target.on(name, (...args: unknown[]) => {
			const next = waiting.shift();
			if (next) {
				next({ value: args, done: false });
			} else {
				queue.push(args);
			}
		});
		return {
			next: () =>
				new Promise<IteratorResult<unknown[]>>((resolve) => {
					const value = queue.shift();
					if (value) {
						resolve({ value, done: false });
					} else {
						waiting.push(resolve);
					}
				}),
			return: async () => ({ value: undefined, done: true }),
			[Symbol.asyncIterator]() {
				return this;
			},
		};
	};
	emitter.getEventListeners ??= (target: EventEmitter, name: string) => target.listeners(name);
	emitter.setMaxListeners ??= () => undefined;
	emitter.errorMonitor ??= Symbol("events.errorMonitor");
	emitter.captureRejectionSymbol ??= Symbol.for("nodejs.rejection");
	return emitter;
}

function utilModule(): unknown {
	const extra = util as Record<string, unknown>;
	extra.TextEncoder = TextEncoder;
	extra.TextDecoder = TextDecoder;
	extra.styleText ??= (_format: unknown, text: string) => text;
	extra.stripVTControlCharacters ??= (text: string) => text.replace(ANSI_ESCAPE, "");
	extra.isDeepStrictEqual ??= (a: unknown, b: unknown) => {
		try {
			(assert as unknown as { deepStrictEqual(a: unknown, b: unknown): void }).deepStrictEqual(a, b);
			return true;
		} catch {
			return false;
		}
	};
	extra.toUSVString ??= (text: string) => text.toWellFormed();
	extra.aborted ??= (signal: AbortSignal) =>
		new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	return extra;
}

function fontModule(): unknown {
	return {
		getFonts: async (): Promise<string[]> => {
			const query = (window as Window & { queryLocalFonts?: () => Promise<Array<{ family: string }>> })
				.queryLocalFonts;
			if (!query) {
				return [];
			}
			try {
				return [...new Set((await query()).map((font) => font.family))];
			} catch {
				return [];
			}
		},
	};
}

export function registerNodeModules(): void {
	defineModule("process", () => process);
	defineModule("buffer", () => ({
		Buffer,
		Blob,
		File,
		atob,
		btoa,
		kMaxLength: 2 ** 32 - 1,
		constants: { MAX_LENGTH: 2 ** 32 - 1, MAX_STRING_LENGTH: 2 ** 29 - 24 },
		SlowBuffer: Buffer,
		isUtf8: (input: Uint8Array) => {
			try {
				new TextDecoder("utf-8", { fatal: true }).decode(input);
				return true;
			} catch {
				return false;
			}
		},
	}));
	defineModule("events", eventsModule);
	defineModule("util", utilModule);
	defineModule("util/types", () => (util as { types?: unknown }).types ?? {});
	defineModule(["path", "path/posix"], () => Object.assign(path, { win32: path }));
	defineModule("url", () => url);
	defineModule("querystring", () => querystring);
	defineModule("string_decoder", () => stringDecoder);
	defineModule("stream", () => stream);
	defineModule("stream/promises", () => (stream as unknown as { promises: unknown }).promises);
	defineModule("stream/web", () => ({
		ReadableStream,
		WritableStream,
		TransformStream,
		TextEncoderStream,
		TextDecoderStream,
		CompressionStream,
		DecompressionStream,
		ByteLengthQueuingStrategy,
		CountQueuingStrategy,
	}));
	defineModule(["assert", "assert/strict"], () => assert);
	defineModule("zlib", () => ({
		...zlib,
		brotliCompress: () => {
			throw new Error("Brotli is not supported in the browser");
		},
		brotliDecompress: () => {
			throw new Error("Brotli is not supported in the browser");
		},
	}));
	defineModule("os", () => os);
	defineModule("crypto", () => nodeCrypto);
	defineModule("http", () => createHttpModule("http:"));
	defineModule("https", () => createHttpModule("https:"));
	defineModule("http2", () => ({
		connect: () => {
			throw new Error("http2 is not supported in the browser");
		},
	}));
	defineModule("net", () => net);
	defineModule("tls", () => tls);
	defineModule("dns", () => dns);
	defineModule("dns/promises", () => dns.promises);
	defineModule("child_process", () => childProcess);
	defineModule("timers", () => timers);
	defineModule("timers/promises", () => timers.promises);
	defineModule("worker_threads", () => workerThreads);
	defineModule("tty", () => tty);
	defineModule("vm", () => vm);
	defineModule("async_hooks", () => asyncHooks);
	defineModule("v8", () => v8);
	defineModule(["readline", "readline/promises"], () => readline);
	defineModule("perf_hooks", () => perfHooks);
	defineModule("constants", () => ({ ...os.constants.errno, ...os.constants.signals, ...getVfs().fs.constants }));
	defineModule(["fs", "original-fs"], () => getVfs().fs);
	defineModule("fs/promises", () => getVfs().fs.promises);
	defineModule("btime", () => ({
		btime: (file: string, time: number) => getVfs().setBirthtime(file, time),
	}));
	defineModule("get-fonts", fontModule);
	defineModule("module", () => ({
		builtinModules: builtinModules(),
		createRequire: () => createRequire(window),
		isBuiltin: (name: string) => builtinModules().includes(name.replace(/^node:/, "")),
		Module: function Module() {},
	}));
	defineWindowModule("electron", createElectronModule);
	defineWindowModule("@electron/remote", (win) => (loadModule(win, "electron") as { remote: unknown }).remote);
}
