import { electronUserAgent, getCurl, needsProxy } from "./curl.ts";

interface CurlWebSocketHandle {
	onopen: () => void;
	onmessage: (data: string | Uint8Array) => void;
	onclose: () => void;
	onerror: (code: number) => void;
	send(data: string | Uint8Array): void;
	close(): void;
}

type CurlWebSocketCtor = new (
	url: string,
	protocols: string[],
	options: { headers?: Record<string, string> },
) => CurlWebSocketHandle;

type Handler = ((this: WebSocket, event: Event) => unknown) | null;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** A DOM `WebSocket` tunneled through libcurl.js, used for cross-origin sockets (like Electron, no mixed content rules). */
class CurlBackedWebSocket extends EventTarget {
	static readonly CONNECTING = CONNECTING;
	static readonly OPEN = OPEN;
	static readonly CLOSING = CLOSING;
	static readonly CLOSED = CLOSED;
	readonly CONNECTING = CONNECTING;
	readonly OPEN = OPEN;
	readonly CLOSING = CLOSING;
	readonly CLOSED = CLOSED;

	readonly url: string;
	readonly extensions = "";
	readonly protocol: string;
	binaryType: BinaryType = "blob";
	onopen: Handler = null;
	onmessage: Handler = null;
	onerror: Handler = null;
	onclose: Handler = null;

	#readyState = CONNECTING;
	#socket: CurlWebSocketHandle | null = null;
	#closeCode = 1000;
	#closeReason = "";

	constructor(url: string, protocols: string[]) {
		super();
		this.url = url;
		this.protocol = protocols[0] ?? "";
		getCurl().then(
			(libcurl) => {
				if (this.#readyState !== CONNECTING) {
					return;
				}
				const Ctor = (libcurl as unknown as { CurlWebSocket: CurlWebSocketCtor }).CurlWebSocket;
				const headers: Record<string, string> = {
					Origin: "app://obsidian.md",
					"User-Agent": electronUserAgent(),
				};
				if (protocols.length > 0) {
					headers["Sec-WebSocket-Protocol"] = protocols.join(", ");
				}
				try {
					const socket = new Ctor(url, protocols, { headers });
					this.#socket = socket;
					socket.onopen = () => this.#onOpen();
					socket.onmessage = (data) => this.#onMessage(data);
					socket.onclose = () => this.#finish(this.#closeCode, this.#closeReason, true);
					socket.onerror = () => this.#fail();
				} catch (error) {
					console.error(error);
					this.#fail();
				}
			},
			(error: unknown) => {
				console.error("Unable to load libcurl.js", error);
				this.#fail();
			},
		);
	}

	static override [Symbol.hasInstance](value: unknown): boolean {
		return (
			(typeof value === "object" &&
				value !== null &&
				Object.getPrototypeOf(value) === CurlBackedWebSocket.prototype) ||
			value instanceof nativeWebSocket
		);
	}

	get readyState(): number {
		return this.#readyState;
	}

	get bufferedAmount(): number {
		return 0;
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (this.#readyState === CONNECTING) {
			throw new DOMException(
				"Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
				"InvalidStateError",
			);
		}
		if (this.#readyState !== OPEN || !this.#socket) {
			return;
		}
		const socket = this.#socket;
		if (typeof data === "string") {
			socket.send(data);
		} else if (data instanceof Blob) {
			data.arrayBuffer().then((buffer) => socket.send(new Uint8Array(buffer)));
		} else if (ArrayBuffer.isView(data)) {
			socket.send(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
		} else {
			socket.send(new Uint8Array(data).slice());
		}
	}

	close(code?: number, reason?: string): void {
		if (this.#readyState === CLOSING || this.#readyState === CLOSED) {
			return;
		}
		this.#closeCode = code ?? 1005;
		this.#closeReason = reason ?? "";
		const socket = this.#socket;
		if (!socket) {
			this.#finish(1006, "", false);
			return;
		}
		this.#readyState = CLOSING;
		socket.close();
		setTimeout(() => this.#finish(this.#closeCode, this.#closeReason, true), 0);
	}

	#dispatch(event: Event): void {
		const handler = (this as unknown as Record<string, Handler>)[`on${event.type}`];
		if (typeof handler === "function") {
			try {
				handler.call(this as unknown as WebSocket, event);
			} catch (error) {
				reportError(error);
			}
		}
		this.dispatchEvent(event);
	}

	#onOpen(): void {
		this.#readyState = OPEN;
		this.#dispatch(new Event("open"));
	}

	#onMessage(data: string | Uint8Array): void {
		let payload: string | ArrayBuffer | Blob;
		if (typeof data === "string") {
			payload = data;
		} else if (this.binaryType === "arraybuffer") {
			payload = data.slice().buffer;
		} else {
			payload = new Blob([data.slice()]);
		}
		this.#dispatch(new MessageEvent("message", { data: payload, origin: new URL(this.url).origin }));
	}

	#fail(): void {
		if (this.#readyState === CLOSED) {
			return;
		}
		this.#dispatch(new Event("error"));
		this.#finish(1006, "", false);
	}

	#finish(code: number, reason: string, wasClean: boolean): void {
		if (this.#readyState === CLOSED) {
			return;
		}
		this.#readyState = CLOSED;
		this.#socket = null;
		this.#dispatch(new CloseEvent("close", { code, reason, wasClean }));
	}
}

let nativeWebSocket: typeof WebSocket = WebSocket;

/** Replaces `WebSocket` so that sockets to other hosts go through the proxy, keeping same-host sockets native. */
export function installWebSocket(win: Window & typeof globalThis): void {
	nativeWebSocket = win.WebSocket;
	const native = nativeWebSocket;
	const Wrapper = function WebSocket(this: unknown, url: string | URL, protocols?: string | string[]): object {
		if (!new.target) {
			throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator.");
		}
		const href = new URL(url, win.location.href).href;
		const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
		if (!needsProxy(href, win.location.href)) {
			return new native(href, list);
		}
		return new CurlBackedWebSocket(href, list);
	} as unknown as typeof WebSocket;
	Object.defineProperties(Wrapper, {
		CONNECTING: { value: CONNECTING },
		OPEN: { value: OPEN },
		CLOSING: { value: CLOSING },
		CLOSED: { value: CLOSED },
		prototype: { value: native.prototype },
		[Symbol.hasInstance]: {
			value: (value: unknown) => value instanceof native || value instanceof CurlBackedWebSocket,
		},
	});
	Object.defineProperty(win, "WebSocket", { value: Wrapper, writable: true, configurable: true });
}
