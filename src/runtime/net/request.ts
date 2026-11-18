import { curlFetch, needsProxy } from "./curl.ts";

export interface RequestUrlParams {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
}

export interface RequestUrlResult {
	status: number;
	headers: Record<string, string>;
	body: ArrayBuffer;
}

/** The main process `request-url` handler: an Electron `net.request` with redirects followed. */
export async function performRequest(params: RequestUrlParams): Promise<RequestUrlResult> {
	const method = (params.method || "GET").toUpperCase();
	const headers = new Headers();
	if (params.contentType) {
		headers.set("Content-Type", params.contentType);
	}
	for (const [key, value] of Object.entries(params.headers ?? {})) {
		try {
			headers.set(key, value);
		} catch (error) {
			console.error(error);
		}
	}
	const body = method === "GET" || method === "HEAD" ? undefined : params.body;
	const url = new URL(params.url, location.href).href;
	const response = needsProxy(url)
		? await curlFetch(url, { method, headers, body: body ?? null, redirect: "follow" })
		: await fetch(url, { method, headers, body: body ?? null, redirect: "follow" });
	const result: Record<string, string> = {};
	const raw = (response as { raw_headers?: Array<[string, string]> }).raw_headers;
	if (raw) {
		for (const [key, value] of raw) {
			const name = key.toLowerCase();
			result[name] = name in result ? `${result[name]}, ${value}` : value;
		}
	} else {
		response.headers.forEach((value, key) => {
			result[key.toLowerCase()] = value;
		});
	}
	return { status: response.status, headers: result, body: await response.arrayBuffer() };
}
