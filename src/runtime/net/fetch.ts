import { curlFetch, needsProxy } from "./curl.ts";

const DESKTOP_ORIGIN = "app://obsidian.md";

async function toCurlRequest(input: RequestInfo | URL, init: RequestInit | undefined): Promise<[string, RequestInit]> {
	if (input instanceof Request) {
		const method = init?.method ?? input.method;
		const body =
			init?.body ?? (method === "GET" || method === "HEAD" ? undefined : await input.clone().arrayBuffer());
		return [
			input.url,
			{
				method,
				headers: init?.headers ?? input.headers,
				body,
				redirect: init?.redirect ?? input.redirect,
				signal: init?.signal ?? input.signal,
			},
		];
	}
	return [String(input), { ...init }];
}

async function normalizeBody(body: BodyInit | null | undefined): Promise<BodyInit | undefined> {
	if (body == null) {
		return undefined;
	}
	if (body instanceof ReadableStream) {
		return new Uint8Array(await new Response(body).arrayBuffer());
	}
	if (body instanceof FormData || body instanceof URLSearchParams) {
		return body;
	}
	return body;
}

/**
 * Electron's renderer `fetch` reaches any server that allows the `app://obsidian.md` origin. In the browser the
 * same requests would be blocked by CORS, so cross-origin requests are tunneled through libcurl.js instead.
 */
export function installFetch(win: Window & typeof globalThis): void {
	const nativeFetch = win.fetch.bind(win);
	const proxiedFetch = async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url = input instanceof Request ? input.url : String(input);
		if (!needsProxy(url, win.location.href)) {
			return nativeFetch(input, init);
		}
		const [target, options] = await toCurlRequest(input, init);
		const headers = new Headers(options.headers);
		let body = await normalizeBody(options.body);
		if (body instanceof FormData || body instanceof URLSearchParams) {
			const encoded = new Response(body);
			const type = encoded.headers.get("Content-Type");
			if (type && !headers.has("Content-Type")) {
				headers.set("Content-Type", type);
			}
			body = new Uint8Array(await encoded.arrayBuffer());
		} else if (body instanceof Blob) {
			if (body.type && !headers.has("Content-Type")) {
				headers.set("Content-Type", body.type);
			}
			body = new Uint8Array(await body.arrayBuffer());
		} else if (typeof body === "string" && !headers.has("Content-Type")) {
			headers.set("Content-Type", "text/plain;charset=UTF-8");
		}
		if (!headers.has("Origin") && (options.method ?? "GET").toUpperCase() !== "GET") {
			headers.set("Origin", DESKTOP_ORIGIN);
		}
		return curlFetch(new URL(target, win.location.href).href, {
			method: options.method ?? "GET",
			headers,
			body: body ?? null,
			redirect: options.redirect ?? "follow",
			signal: options.signal ?? null,
		});
	};
	Object.defineProperty(win, "fetch", { value: proxiedFetch, writable: true, configurable: true });
}
