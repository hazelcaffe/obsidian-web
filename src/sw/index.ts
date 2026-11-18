import {
	APP_PAGES,
	ASSET_PREFIX,
	type ClientMessage,
	VFS_URL_PREFIX,
	type WorkerMessage,
} from "../shared/constants.ts";
import { getOpfsRoot, OPFS_VFS_DIR, type OpenedApp, openInstalledApp } from "../shared/install.ts";
import { mimeType } from "../shared/mime.ts";

declare const self: ServiceWorkerGlobalScope;
declare const __BUILD_ID__: string;
declare const __PRECACHE__: string[];

const CACHE_NAME = `obsidian-web-${__BUILD_ID__}`;
const READY_TIMEOUT = 60_000;
const CLIENT_READ_TIMEOUT = 5_000;

let appPromise: Promise<OpenedApp | null> | null = null;
const readyClients = new Set<string>();
const readyWaiters = new Map<string, Array<() => void>>();
const pendingReads = new Map<number, (data: ArrayBuffer | null) => void>();
let nextReadId = 1;

function getApp(): Promise<OpenedApp | null> {
	appPromise ??= openInstalledApp().then((app) => {
		if (!app) {
			appPromise = null;
		}
		return app;
	});
	return appPromise;
}

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE_NAME);
			await cache.addAll(__PRECACHE__).catch((error: unknown) => console.warn("Precache failed", error));
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key.startsWith("obsidian-web-") && key !== CACHE_NAME) {
					await caches.delete(key);
				}
			}
			await self.clients.claim();
		})(),
	);
});

self.addEventListener("message", (event) => {
	const data = event.data as ClientMessage;
	const source = event.source;
	if (data.type === "runtime-ready" && source && "id" in source) {
		readyClients.add(source.id);
		for (const resolve of readyWaiters.get(source.id) ?? []) {
			resolve();
		}
		readyWaiters.delete(source.id);
	} else if (data.type === "app-updated") {
		appPromise = null;
	} else if (data.type === "vfs-read-result") {
		pendingReads.get(data.id)?.(data.data);
		pendingReads.delete(data.id);
	}
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin || (request.method !== "GET" && request.method !== "HEAD")) {
		return;
	}
	const path = url.pathname;
	if (path.startsWith(VFS_URL_PREFIX)) {
		event.respondWith(serveVfs(request, path, event.clientId));
	} else if (path.startsWith(ASSET_PREFIX) || path === "/sw.js") {
		event.respondWith(networkFirst(request));
	} else if (path === "/") {
		event.respondWith(serveBoot(request));
	} else {
		event.respondWith(serveApp(request, path, event.clientId || event.resultingClientId));
	}
});

async function networkFirst(request: Request): Promise<Response> {
	const cache = await caches.open(CACHE_NAME);
	try {
		const response = await fetch(request);
		if (response.ok && request.method === "GET") {
			await cache.put(request, response.clone());
		}
		return response;
	} catch (error) {
		const cached = await cache.match(request, { ignoreSearch: true });
		if (cached) {
			return cached;
		}
		throw error;
	}
}

function serveBoot(request: Request): Promise<Response> {
	return networkFirst(new Request(new URL("/", request.url), { headers: request.headers }));
}

async function serveApp(request: Request, path: string, clientId: string): Promise<Response> {
	const app = await getApp();
	if (!app) {
		if (path in APP_PAGES) {
			return Response.redirect("/", 302);
		}
		return fetch(request);
	}
	const relative = decodeURIComponent(path.slice(1));
	const location = app.archive.locate(relative);
	if (!location) {
		return fetch(request).catch(() => new Response("Not found", { status: 404 }));
	}
	const blob = app.file.slice(location.start, location.start + location.size);
	const headers: Record<string, string> = { "Content-Type": mimeType(relative), "Cache-Control": "no-cache" };
	if (path in APP_PAGES) {
		return new Response(injectRuntime(await blob.text()), { headers });
	}
	if (Object.values(APP_PAGES).includes(path) && clientId) {
		await waitForRuntime(clientId);
	}
	return rangeResponse(request, blob, headers);
}

function injectRuntime(html: string): string {
	const tag = `<script src="${ASSET_PREFIX}runtime.js"></script>`;
	const charset = /<meta\s+charset=[^>]*>/i.exec(html);
	if (charset) {
		const end = charset.index + charset[0].length;
		return `${html.slice(0, end)}\n${tag}${html.slice(end)}`;
	}
	return html.replace(/<head[^>]*>/i, (head) => `${head}\n${tag}`);
}

function waitForRuntime(clientId: string): Promise<void> {
	if (readyClients.has(clientId)) {
		return Promise.resolve();
	}
	const promise = new Promise<void>((resolve) => {
		const waiters = readyWaiters.get(clientId) ?? [];
		waiters.push(resolve);
		readyWaiters.set(clientId, waiters);
		setTimeout(resolve, READY_TIMEOUT);
	});
	// The worker may have been restarted since the page reported that it is ready.
	self.clients.get(clientId).then((client) => {
		const message: WorkerMessage = { type: "ready-check" };
		client?.postMessage(message);
	});
	return promise;
}

function rangeResponse(request: Request, blob: Blob, headers: Record<string, string>): Response {
	const range = request.headers.get("Range");
	const size = blob.size;
	if (!range) {
		return new Response(blob, {
			headers: { ...headers, "Content-Length": String(size), "Accept-Ranges": "bytes" },
		});
	}
	const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
	if (!match) {
		return new Response("Range Not Satisfiable", { status: 416 });
	}
	let start: number;
	let end: number;
	if (match[1] === "") {
		const suffix = Number(match[2]);
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	}
	if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
		return new Response("Range Not Satisfiable", {
			status: 416,
			headers: { "Content-Range": `bytes */${size}` },
		});
	}
	return new Response(blob.slice(start, end + 1), {
		status: 206,
		headers: {
			...headers,
			"Accept-Ranges": "bytes",
			"Content-Length": String(end - start + 1),
			"Content-Range": `bytes ${start}-${end}/${size}`,
		},
	});
}

async function serveVfs(request: Request, urlPath: string, clientId: string): Promise<Response> {
	const parts = urlPath
		.slice(VFS_URL_PREFIX.length)
		.split("/")
		.filter((part) => part !== "")
		.map((part) => decodeURIComponent(part));
	if (parts.some((part) => part === "." || part === "..")) {
		return new Response("Bad Request", { status: 400 });
	}
	const path = `/${parts.join("/")}`;
	const headers = { "Content-Type": mimeType(path), "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" };
	const file = await readOpfsFile(parts);
	if (file) {
		return rangeResponse(request, file, headers);
	}
	const data = await readFromClient(clientId, path);
	if (data) {
		return rangeResponse(request, new Blob([data]), headers);
	}
	return new Response("Not Found", { status: 404 });
}

async function readOpfsFile(parts: string[]): Promise<File | null> {
	try {
		let dir = await (await getOpfsRoot()).getDirectoryHandle(OPFS_VFS_DIR);
		for (const part of parts.slice(0, -1)) {
			dir = await dir.getDirectoryHandle(part);
		}
		const name = parts.at(-1);
		return name ? await (await dir.getFileHandle(name)).getFile() : null;
	} catch {
		return null;
	}
}

async function readFromClient(clientId: string, path: string): Promise<ArrayBuffer | null> {
	const candidates: Client[] = [];
	const direct = clientId ? await self.clients.get(clientId) : undefined;
	if (direct) {
		candidates.push(direct);
	}
	for (const client of await self.clients.matchAll({ type: "window" })) {
		if (client.id !== direct?.id && readyClients.has(client.id)) {
			candidates.push(client);
		}
	}
	for (const client of candidates) {
		const id = nextReadId++;
		const result = await new Promise<ArrayBuffer | null>((resolve) => {
			pendingReads.set(id, resolve);
			const message: WorkerMessage = { type: "vfs-read", id, path };
			client.postMessage(message);
			setTimeout(() => {
				pendingReads.delete(id);
				resolve(null);
			}, CLIENT_READ_TIMEOUT);
		});
		if (result) {
			return result;
		}
	}
	return null;
}
