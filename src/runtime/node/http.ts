import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { Readable, Writable } from "readable-stream";
import { curlFetch } from "../net/curl.ts";

export const STATUS_CODES: Record<number, string> = {
	100: "Continue",
	101: "Switching Protocols",
	200: "OK",
	201: "Created",
	202: "Accepted",
	204: "No Content",
	206: "Partial Content",
	301: "Moved Permanently",
	302: "Found",
	303: "See Other",
	304: "Not Modified",
	307: "Temporary Redirect",
	308: "Permanent Redirect",
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	409: "Conflict",
	410: "Gone",
	412: "Precondition Failed",
	413: "Payload Too Large",
	415: "Unsupported Media Type",
	416: "Range Not Satisfiable",
	422: "Unprocessable Entity",
	429: "Too Many Requests",
	500: "Internal Server Error",
	501: "Not Implemented",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
};

export const METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "CONNECT", "TRACE"];

interface RequestOptions {
	protocol?: string;
	host?: string;
	hostname?: string;
	port?: number | string;
	path?: string;
	method?: string;
	headers?: Record<string, string | number | string[]>;
	auth?: string;
	timeout?: number;
	signal?: AbortSignal;
	agent?: unknown;
}

type ResponseListener = (response: IncomingMessage) => void;

export class Agent extends EventEmitter {
	readonly options: Record<string, unknown>;
	maxSockets = Number.POSITIVE_INFINITY;
	maxFreeSockets = 256;
	sockets: Record<string, unknown[]> = {};
	freeSockets: Record<string, unknown[]> = {};
	requests: Record<string, unknown[]> = {};

	constructor(options: Record<string, unknown> = {}) {
		super();
		this.options = options;
	}

	destroy(): void {}
}

export class IncomingMessage extends Readable {
	statusCode = 0;
	statusMessage = "";
	httpVersion = "1.1";
	httpVersionMajor = 1;
	httpVersionMinor = 1;
	headers: Record<string, string | string[]> = {};
	rawHeaders: string[] = [];
	trailers: Record<string, string> = {};
	rawTrailers: string[] = [];
	complete = false;
	url = "";
	method: string | null = null;
	socket = { remoteAddress: "", remotePort: 0, encrypted: true, setTimeout() {}, destroy() {} };
	readonly #reader: ReadableStreamDefaultReader<Uint8Array> | null;
	#reading = false;

	constructor(response: Response | null) {
		super();
		this.#reader = response?.body?.getReader() ?? null;
		if (!response) {
			return;
		}
		this.statusCode = response.status;
		this.statusMessage = response.statusText || STATUS_CODES[response.status] || "";
		const raw = (response as { raw_headers?: Array<[string, string]> }).raw_headers ?? [
			...response.headers.entries(),
		];
		for (const [key, value] of raw) {
			const name = key.toLowerCase();
			if (
				name === "content-encoding" ||
				(name === "content-length" && raw.some(([k]) => k.toLowerCase() === "content-encoding"))
			) {
				continue;
			}
			this.rawHeaders.push(key, value);
			const existing = this.headers[name];
			if (name === "set-cookie") {
				this.headers[name] = [...((existing as string[] | undefined) ?? []), value];
			} else {
				this.headers[name] = existing === undefined ? value : `${existing}, ${value}`;
			}
		}
	}

	override _read(): void {
		if (this.#reading) {
			return;
		}
		if (!this.#reader) {
			this.complete = true;
			this.push(null);
			return;
		}
		this.#reading = true;
		this.#reader.read().then(
			({ done, value }) => {
				this.#reading = false;
				if (done) {
					this.complete = true;
					this.push(null);
				} else if (this.push(Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength))) {
					this._read();
				}
			},
			(error: unknown) => {
				this.#reading = false;
				this.destroy(error instanceof Error ? error : new Error(String(error)));
			},
		);
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		this.#reader?.cancel().catch(() => undefined);
		callback(error);
	}

	setTimeout(_ms: number, callback?: () => void): this {
		if (callback) {
			this.on("timeout", callback);
		}
		return this;
	}
}

export class ClientRequest extends Writable {
	method: string;
	path: string;
	host: string;
	protocol: string;
	aborted = false;
	reusedSocket = false;
	maxHeadersCount: number | null = null;
	socket = { setTimeout() {}, setNoDelay() {}, setKeepAlive() {}, destroy() {}, remoteAddress: "", encrypted: true };
	readonly #url: URL;
	readonly #headers = new Map<string, [string, string | string[]]>();
	readonly #chunks: Buffer[] = [];
	readonly #controller = new AbortController();
	#timeout: ReturnType<typeof setTimeout> | null = null;
	#timeoutMs = 0;

	constructor(url: URL, options: RequestOptions, callback?: ResponseListener) {
		super();
		this.#url = url;
		this.method = (options.method ?? "GET").toUpperCase();
		this.path = `${url.pathname}${url.search}`;
		this.host = url.hostname;
		this.protocol = url.protocol;
		for (const [key, value] of Object.entries(options.headers ?? {})) {
			this.setHeader(key, Array.isArray(value) ? value : String(value));
		}
		if (options.auth && !this.hasHeader("authorization")) {
			this.setHeader("Authorization", `Basic ${Buffer.from(options.auth).toString("base64")}`);
		}
		if (callback) {
			this.once("response", callback);
		}
		if (options.timeout) {
			this.setTimeout(options.timeout);
		}
		options.signal?.addEventListener("abort", () => this.destroy(new Error("The operation was aborted")), {
			once: true,
		});
	}

	setHeader(name: string, value: string | number | string[]): this {
		this.#headers.set(name.toLowerCase(), [name, Array.isArray(value) ? value : String(value)]);
		return this;
	}

	getHeader(name: string): string | string[] | undefined {
		return this.#headers.get(name.toLowerCase())?.[1];
	}

	getHeaders(): Record<string, string | string[]> {
		return Object.fromEntries([...this.#headers.entries()].map(([key, [, value]]) => [key, value]));
	}

	getHeaderNames(): string[] {
		return [...this.#headers.keys()];
	}

	getRawHeaderNames(): string[] {
		return [...this.#headers.values()].map(([name]) => name);
	}

	hasHeader(name: string): boolean {
		return this.#headers.has(name.toLowerCase());
	}

	removeHeader(name: string): void {
		this.#headers.delete(name.toLowerCase());
	}

	flushHeaders(): void {}

	setNoDelay(): void {}

	setSocketKeepAlive(): void {}

	setTimeout(ms: number, callback?: () => void): this {
		this.#timeoutMs = ms;
		if (callback) {
			this.once("timeout", callback);
		}
		this.#armTimeout();
		return this;
	}

	abort(): void {
		if (this.aborted) {
			return;
		}
		this.aborted = true;
		this.#controller.abort();
		this.emit("abort");
		this.destroy();
	}

	#armTimeout(): void {
		if (this.#timeout) {
			clearTimeout(this.#timeout);
		}
		if (this.#timeoutMs > 0) {
			this.#timeout = setTimeout(() => this.emit("timeout"), this.#timeoutMs);
		}
	}

	override _write(chunk: unknown, encoding: string, callback: (error?: Error | null) => void): void {
		this.#chunks.push(
			typeof chunk === "string" ? Buffer.from(chunk, encoding as "utf8") : Buffer.from(chunk as Uint8Array),
		);
		callback();
	}

	override _final(callback: (error?: Error | null) => void): void {
		callback();
		this.#send();
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		this.#controller.abort();
		if (this.#timeout) {
			clearTimeout(this.#timeout);
		}
		callback(error);
	}

	#send(): void {
		const headers: Record<string, string> = {};
		for (const [key, [name, value]] of this.#headers) {
			if (key === "accept-encoding" || key === "host" || key === "connection" || key === "content-length") {
				continue;
			}
			headers[name] = Array.isArray(value) ? value.join(", ") : value;
		}
		const body = this.method === "GET" || this.method === "HEAD" ? null : Buffer.concat(this.#chunks);
		curlFetch(this.#url.href, {
			method: this.method,
			headers,
			body,
			redirect: "manual",
			signal: this.#controller.signal,
		}).then(
			(response) => {
				if (this.#timeout) {
					clearTimeout(this.#timeout);
				}
				const message = new IncomingMessage(response);
				message.url = this.path;
				this.emit("response", message);
				this.emit("finish");
			},
			(error: unknown) => {
				if (this.#timeout) {
					clearTimeout(this.#timeout);
				}
				if (this.aborted) {
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				const code =
					typeof (error as { code?: unknown })?.code === "string"
						? (error as { code: string }).code
						: "ECONNRESET";
				this.emit("error", Object.assign(new Error(message, { cause: error }), { code }));
			},
		);
	}
}

function resolveArgs(
	defaultProtocol: string,
	args: unknown[],
): { url: URL; options: RequestOptions; callback?: ResponseListener } {
	let url: URL | null = null;
	let options: RequestOptions = {};
	let callback: ResponseListener | undefined;
	for (const arg of args) {
		if (typeof arg === "string") {
			url = new URL(arg);
		} else if (arg instanceof URL) {
			url = arg;
		} else if (typeof arg === "function") {
			callback = arg as ResponseListener;
		} else if (arg && typeof arg === "object") {
			options = { ...options, ...(arg as RequestOptions) };
		}
	}
	if (!url) {
		const protocol = options.protocol ?? defaultProtocol;
		const hostname = options.hostname ?? options.host?.replace(/:\d+$/, "") ?? "localhost";
		const port = options.port ? `:${options.port}` : "";
		const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
		url = new URL(`${protocol}//${host}${port}${options.path ?? "/"}`);
	} else if (options.path || options.hostname || options.port) {
		url = new URL(url.href);
		if (options.hostname) {
			url.hostname = options.hostname;
		}
		if (options.port) {
			url.port = String(options.port);
		}
		if (options.path) {
			const [pathname, search] = options.path.split("?");
			url.pathname = pathname ?? "/";
			url.search = search ? `?${search}` : "";
		}
	}
	return callback ? { url, options, callback } : { url, options };
}

function unsupportedServer(): never {
	throw Object.assign(new Error("Creating servers is not supported in the browser"), {
		code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
	});
}

export function createHttpModule(defaultProtocol: "http:" | "https:"): Record<string, unknown> {
	const request = (...args: unknown[]): ClientRequest => {
		const { url, options, callback } = resolveArgs(defaultProtocol, args);
		return new ClientRequest(url, options, callback);
	};
	const get = (...args: unknown[]): ClientRequest => {
		const req = request(...args);
		req.end();
		return req;
	};
	return {
		request,
		get,
		Agent,
		globalAgent: new Agent(),
		ClientRequest,
		IncomingMessage,
		STATUS_CODES,
		METHODS,
		maxHeaderSize: 16384,
		createServer: unsupportedServer,
		Server: unsupportedServer,
		validateHeaderName: () => undefined,
		validateHeaderValue: () => undefined,
		setMaxIdleHTTPParsers: () => undefined,
	};
}
