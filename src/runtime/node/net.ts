import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { Duplex } from "readable-stream";
import { type CurlSocket, getWispUrl, type WispConnection, type WispStream } from "../../shared/libcurl.ts";
import { curlFetch, getCurl } from "../net/curl.ts";

type Callback = (error?: Error | null) => void;

let wispConnection: Promise<WispConnection> | null = null;

function getWispConnection(): Promise<WispConnection> {
	wispConnection ??= getCurl().then(
		(libcurl) =>
			new Promise<WispConnection>((resolve, reject) => {
				const Ctor = libcurl.wisp.WispConnection;
				if (!Ctor) {
					reject(new Error("libcurl.js does not expose a Wisp client"));
					return;
				}
				const connection = new Ctor(getWispUrl()) as WispConnection & EventTarget;
				connection.addEventListener("open", () => resolve(connection), { once: true });
				const fail = (): void => {
					wispConnection = null;
					reject(new Error("Unable to connect to the Wisp server"));
				};
				connection.addEventListener("error", fail, { once: true });
				connection.addEventListener("close", () => {
					wispConnection = null;
				});
			}),
	);
	wispConnection.catch(() => {
		wispConnection = null;
	});
	return wispConnection;
}

interface ConnectOptions {
	port?: number | string;
	host?: string;
	servername?: string;
	timeout?: number;
}

function codeError(message: string, code: string): Error {
	return Object.assign(new Error(message), { code });
}

export class Socket extends Duplex {
	connecting = false;
	pending = true;
	encrypted = false;
	remoteAddress: string | undefined;
	remotePort: number | undefined;
	remoteFamily = "IPv4";
	localAddress = "127.0.0.1";
	localPort = 0;
	bytesRead = 0;
	bytesWritten = 0;
	#sendChunk: ((data: Uint8Array) => void) | null = null;
	#closeTransport: (() => void) | null = null;
	#timeout: ReturnType<typeof setTimeout> | null = null;
	#timeoutMs = 0;
	protected readonly secure: boolean;

	constructor(options: { allowHalfOpen?: boolean } = {}, secure = false) {
		super({ allowHalfOpen: options.allowHalfOpen ?? false });
		this.secure = secure;
		this.encrypted = secure;
	}

	get readyState(): string {
		if (this.connecting) {
			return "opening";
		}
		return this.#sendChunk ? "open" : "closed";
	}

	connect(...args: unknown[]): this {
		let options: ConnectOptions = {};
		let listener: (() => void) | undefined;
		for (const arg of args) {
			if (typeof arg === "number" || (typeof arg === "string" && /^\d+$/.test(arg))) {
				options.port = Number(arg);
			} else if (typeof arg === "string") {
				options.host = arg;
			} else if (typeof arg === "function") {
				listener = arg as () => void;
			} else if (arg && typeof arg === "object") {
				options = { ...options, ...(arg as ConnectOptions) };
			}
		}
		const host = options.host ?? "localhost";
		const port = Number(options.port);
		if (listener) {
			this.once(this.secure ? "secureConnect" : "connect", listener);
		}
		if (options.timeout) {
			this.setTimeout(options.timeout);
		}
		this.connecting = true;
		this.remoteAddress = host;
		this.remotePort = port;
		(this.secure ? this.#openTls(host, port) : this.#openTcp(host, port)).catch((error: unknown) => {
			this.connecting = false;
			this.destroy(error instanceof Error ? error : new Error(String(error)));
		});
		return this;
	}

	async #openTcp(host: string, port: number): Promise<void> {
		const connection = await getWispConnection();
		const stream = connection.create_stream(host, port) as WispStream & EventTarget;
		stream.addEventListener("message", (event) => this.#receive((event as MessageEvent<Uint8Array>).data));
		stream.addEventListener("close", (event) => {
			const code = (event as CloseEvent).code;
			if (this.connecting) {
				this.destroy(codeError(`connect ECONNREFUSED ${host}:${port}`, "ECONNREFUSED"));
			} else if (code !== 0x02) {
				this.push(null);
				this.destroy(code === 0x01 ? undefined : codeError("read ECONNRESET", "ECONNRESET"));
			} else {
				this.push(null);
			}
		});
		this.#sendChunk = (data) => stream.send(data);
		this.#closeTransport = () => stream.close(0x02);
		this.#connected();
	}

	async #openTls(host: string, port: number): Promise<void> {
		const libcurl = await getCurl();
		const socket: CurlSocket = new libcurl.TLSSocket(host, port);
		await new Promise<void>((resolve, reject) => {
			socket.onopen = () => resolve();
			socket.onerror = (code) =>
				reject(
					codeError(
						`TLS connection to ${host}:${port} failed: ${libcurl.get_error_string(code)}`,
						"ECONNREFUSED",
					),
				);
		});
		socket.onmessage = (data) => this.#receive(data);
		socket.onclose = () => {
			this.push(null);
			this.destroy();
		};
		socket.onerror = (code) => this.destroy(codeError(libcurl.get_error_string(code), "ECONNRESET"));
		this.#sendChunk = (data) => socket.send(data);
		this.#closeTransport = () => socket.close();
		this.#connected();
	}

	#connected(): void {
		this.connecting = false;
		this.pending = false;
		this.emit("connect");
		this.emit("ready");
		if (this.secure) {
			this.emit("secureConnect");
		}
		this.#touch();
	}

	#receive(data: Uint8Array): void {
		this.bytesRead += data.byteLength;
		this.#touch();
		this.push(Buffer.from(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength));
	}

	#touch(): void {
		if (this.#timeout) {
			clearTimeout(this.#timeout);
		}
		if (this.#timeoutMs > 0) {
			this.#timeout = setTimeout(() => this.emit("timeout"), this.#timeoutMs);
		}
	}

	override _read(): void {}

	override _write(chunk: unknown, encoding: string, callback: Callback): void {
		const data =
			typeof chunk === "string" ? Buffer.from(chunk, encoding as "utf8") : Buffer.from(chunk as Uint8Array);
		const send = (): void => {
			if (!this.#sendChunk) {
				callback(codeError("This socket is closed", "EPIPE"));
				return;
			}
			this.#sendChunk(new Uint8Array(data));
			this.bytesWritten += data.byteLength;
			this.#touch();
			callback();
		};
		if (this.connecting) {
			this.once(this.secure ? "secureConnect" : "connect", send);
		} else {
			send();
		}
	}

	override _final(callback: Callback): void {
		this.#closeTransport?.();
		callback();
	}

	override _destroy(error: Error | null, callback: Callback): void {
		if (this.#timeout) {
			clearTimeout(this.#timeout);
		}
		this.#closeTransport?.();
		this.#sendChunk = null;
		this.#closeTransport = null;
		callback(error);
		queueMicrotask(() => this.emit("close", !!error));
	}

	setTimeout(ms: number, callback?: () => void): this {
		this.#timeoutMs = ms;
		if (callback) {
			this.once("timeout", callback);
		}
		this.#touch();
		return this;
	}

	setNoDelay(): this {
		return this;
	}

	setKeepAlive(): this {
		return this;
	}

	ref(): this {
		return this;
	}

	unref(): this {
		return this;
	}

	address(): { address: string; family: string; port: number } {
		return { address: this.localAddress, family: "IPv4", port: this.localPort };
	}

	getPeerCertificate(): Record<string, unknown> {
		return {};
	}

	getProtocol(): string | null {
		return this.secure ? "TLSv1.3" : null;
	}

	get authorized(): boolean {
		return this.secure;
	}
}

export class TLSSocket extends Socket {
	constructor(options: { allowHalfOpen?: boolean } = {}) {
		super(options, true);
	}
}

function isIP(input: string): 0 | 4 | 6 {
	if (/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(input)) {
		return 4;
	}
	return input.includes(":") && /^[0-9a-f:.]+$/i.test(input) ? 6 : 0;
}

function unsupportedServer(): never {
	throw codeError("Listening for connections is not supported in the browser", "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM");
}

export const net = {
	Socket,
	Stream: Socket,
	connect: (...args: unknown[]) => new Socket().connect(...args),
	createConnection: (...args: unknown[]) => new Socket().connect(...args),
	createServer: unsupportedServer,
	Server: unsupportedServer,
	isIP,
	isIPv4: (input: string) => isIP(input) === 4,
	isIPv6: (input: string) => isIP(input) === 6,
	BlockList: class BlockList {
		addAddress(): void {}
		check(): boolean {
			return false;
		}
	},
	getDefaultAutoSelectFamily: () => true,
	setDefaultAutoSelectFamily: () => undefined,
};

export const tls = {
	TLSSocket,
	connect: (...args: unknown[]) => new TLSSocket().connect(...args),
	createSecureContext: (options: unknown) => ({ context: options }),
	createServer: unsupportedServer,
	Server: unsupportedServer,
	checkServerIdentity: () => undefined,
	getCiphers: () => ["tls_aes_256_gcm_sha384", "tls_chacha20_poly1305_sha256", "tls_aes_128_gcm_sha256"],
	rootCertificates: [] as string[],
	DEFAULT_MIN_VERSION: "TLSv1.2",
	DEFAULT_MAX_VERSION: "TLSv1.3",
	DEFAULT_ECDH_CURVE: "auto",
};

interface DohAnswer {
	name: string;
	type: number;
	TTL: number;
	data: string;
}

const RECORD_TYPES: Record<string, number> = {
	A: 1,
	NS: 2,
	CNAME: 5,
	SOA: 6,
	PTR: 12,
	MX: 15,
	TXT: 16,
	AAAA: 28,
	SRV: 33,
	CAA: 257,
};

async function query(hostname: string, type: string): Promise<DohAnswer[]> {
	const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
	const response = await curlFetch(url, { headers: { Accept: "application/dns-json" } });
	if (!response.ok) {
		throw codeError(`queryA ESERVFAIL ${hostname}`, "ESERVFAIL");
	}
	const result = (await response.json()) as { Status: number; Answer?: DohAnswer[] };
	const answers = (result.Answer ?? []).filter((answer) => answer.type === RECORD_TYPES[type]);
	if (result.Status === 3 || answers.length === 0) {
		throw Object.assign(codeError(`query${type} ENOTFOUND ${hostname}`, "ENOTFOUND"), { hostname });
	}
	return answers;
}

async function lookupAddresses(hostname: string, family: number): Promise<Array<{ address: string; family: number }>> {
	if (isIP(hostname)) {
		return [{ address: hostname, family: isIP(hostname) }];
	}
	if (hostname === "localhost") {
		return [{ address: "127.0.0.1", family: 4 }];
	}
	const results: Array<{ address: string; family: number }> = [];
	if (family !== 6) {
		const answers = await query(hostname, "A").catch(() => []);
		results.push(...answers.map((answer) => ({ address: answer.data, family: 4 })));
	}
	if (family !== 4) {
		const answers = await query(hostname, "AAAA").catch(() => []);
		results.push(...answers.map((answer) => ({ address: answer.data, family: 6 })));
	}
	if (results.length === 0) {
		throw Object.assign(codeError(`getaddrinfo ENOTFOUND ${hostname}`, "ENOTFOUND"), {
			hostname,
			syscall: "getaddrinfo",
		});
	}
	return results;
}

interface LookupOptions {
	family?: number;
	all?: boolean;
}

async function lookupPromise(hostname: string, options: LookupOptions | number = {}): Promise<unknown> {
	const opts = typeof options === "number" ? { family: options } : options;
	const addresses = await lookupAddresses(hostname, opts.family ?? 0);
	return opts.all ? addresses : addresses[0];
}

function resolver(type: string, map: (answer: DohAnswer) => unknown = (answer) => answer.data) {
	return async (hostname: string): Promise<unknown[]> => (await query(hostname, type)).map(map);
}

const txt = (answer: DohAnswer): string[] => [answer.data.replace(/^"|"$/g, "")];
const mx = (answer: DohAnswer): { priority: number; exchange: string } => {
	const [priority, exchange] = answer.data.split(" ");
	return { priority: Number(priority), exchange: (exchange ?? "").replace(/\.$/, "") };
};

const promises = {
	lookup: lookupPromise,
	resolve: (hostname: string, type = "A") => resolver(type)(hostname),
	resolve4: resolver("A"),
	resolve6: resolver("AAAA"),
	resolveCname: resolver("CNAME"),
	resolveTxt: resolver("TXT", txt),
	resolveMx: resolver("MX", mx),
	resolveNs: resolver("NS"),
	resolveSrv: resolver("SRV"),
	reverse: async () => [] as string[],
	setServers: () => undefined,
	getServers: () => ["1.1.1.1"],
};

function callbackify(fn: (...args: never[]) => Promise<unknown>) {
	return (...args: unknown[]): void => {
		const callback = args.pop() as (error: Error | null, ...results: unknown[]) => void;
		(fn as (...a: unknown[]) => Promise<unknown>)(...args).then(
			(result) => {
				if (fn === lookupPromise && result && !Array.isArray(result)) {
					const { address, family } = result as { address: string; family: number };
					callback(null, address, family);
				} else {
					callback(null, result);
				}
			},
			(error: unknown) => callback(error as Error),
		);
	};
}

export const dns = {
	lookup: callbackify(lookupPromise),
	resolve: callbackify(promises.resolve),
	resolve4: callbackify(promises.resolve4),
	resolve6: callbackify(promises.resolve6),
	resolveCname: callbackify(promises.resolveCname),
	resolveTxt: callbackify(promises.resolveTxt),
	resolveMx: callbackify(promises.resolveMx),
	resolveNs: callbackify(promises.resolveNs),
	resolveSrv: callbackify(promises.resolveSrv),
	reverse: callbackify(promises.reverse),
	setServers: () => undefined,
	getServers: () => ["1.1.1.1"],
	setDefaultResultOrder: () => undefined,
	promises,
	Resolver: class Resolver extends EventEmitter {
		resolve4 = promises.resolve4;
		resolve6 = promises.resolve6;
		setServers(): void {}
		cancel(): void {}
	},
	ADDRCONFIG: 1024,
	V4MAPPED: 2048,
	NOTFOUND: "ENOTFOUND",
};
