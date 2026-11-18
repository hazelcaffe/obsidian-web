import { ASSET_PREFIX } from "./constants.ts";
import { getWispUrl } from "./network-config.ts";

export { getWispUrl } from "./network-config.ts";

export interface LibcurlResponse extends Response {
	raw_headers?: Array<[string, string]>;
}

export interface LibcurlRequestInit extends RequestInit {
	_libcurl_http_version?: number;
	_libcurl_verbose?: number;
	proxy?: string;
}

export interface CurlSocket {
	onopen: (() => void) | null;
	onmessage: ((data: Uint8Array) => void) | null;
	onclose: (() => void) | null;
	onerror: ((code: number) => void) | null;
	send(data: Uint8Array): void;
	close(): void;
}

export interface WispStream {
	onmessage: ((data: Uint8Array) => void) | null;
	onclose: ((reason: number) => void) | null;
	send(data: Uint8Array): void;
	close(reason?: number): void;
}

export interface WispConnection {
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onerror: (() => void) | null;
	connected: boolean;
	create_stream(host: string, port: number, type?: "tcp" | "udp"): WispStream;
	close(): void;
}

export interface Libcurl {
	fetch(input: string | URL | Request, init?: LibcurlRequestInit): Promise<LibcurlResponse>;
	set_websocket(url: string): void;
	load_wasm(url: string): Promise<void>;
	get_error_string(code: number): string;
	readonly ready: boolean;
	readonly websocket_url: string;
	readonly version: { lib: string };
	WebSocket: new (
		url: string | URL,
		protocols?: string | string[],
		options?: { headers?: Record<string, string>; verbose?: boolean },
	) => WebSocket;
	TLSSocket: new (host: string, port: number, options?: { verbose?: boolean }) => CurlSocket;
	wisp: {
		WispConnection?: new (url: string) => WispConnection;
		wisp_connections?: Record<string, WispConnection>;
	};
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	logger: (type: string, text: string) => void;
}

let loading: Promise<Libcurl> | null = null;

/** Loads libcurl.js lazily. It is kept as a separate (LGPL) file instead of being bundled. */
export function loadLibcurl(): Promise<Libcurl> {
	if (!getWispUrl()) {
		return Promise.reject(new Error("This feature needs a Wisp proxy. Configure it in Settings → Obsidian Web."));
	}
	loading ??= (async () => {
		const url = `${ASSET_PREFIX}vendor/libcurl.mjs`;
		const module = (await import(/* @vite-ignore */ url)) as { libcurl: Libcurl };
		const libcurl = module.libcurl;
		libcurl.logger = (type, text) => {
			if (type === "error") {
				console.error("[libcurl]", text);
			} else if (type === "warn") {
				console.warn("[libcurl]", text);
			}
		};
		libcurl.stderr = (text) => console.debug("[libcurl]", text);
		await libcurl.load_wasm(`${ASSET_PREFIX}vendor/libcurl.wasm`);
		libcurl.set_websocket(getWispUrl());
		return libcurl;
	})();
	loading.catch(() => {
		loading = null;
	});
	return loading;
}
