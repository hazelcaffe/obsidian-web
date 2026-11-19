import type { ScramjetServiceWorker } from "@mercuryworkshop/scramjet";
import {
	ASSET_PREFIX,
	type ClientMessage,
	type StartupProgress,
	VFS_URL_PREFIX,
	WEBVIEW_PREFIX,
	type WorkerMessage,
} from "../shared/constants.ts";
import { mimeType } from "../shared/mime.ts";
import { BASE_PATH } from "../shared/paths.ts";
import { getOpfsRoot, OPFS_VFS_DIR } from "../shared/storage.ts";

declare const self: ServiceWorkerGlobalScope;
declare const __BUILD_ID__: string;
declare const __PRECACHE__: string[];

const CACHE_PREFIX = `obsidian-web-${encodeURIComponent(BASE_PATH)}-`;
const CACHE_NAME = `${CACHE_PREFIX}${__BUILD_ID__}`;
const CLIENT_READ_TIMEOUT = 5_000;

const readyClients = new Set<string>();
const pendingReads = new Map<number, (data: ArrayBuffer | null) => void>();
let nextReadId = 1;

// Load code at startup, but instantiate after the controller has initialized Scramjet's database schema.
importScripts(`${ASSET_PREFIX}vendor/scramjet/scramjet.all.js`);
let proxy: ScramjetServiceWorker | null = null;

const startupProgress: StartupProgress = { completed: 0, total: __PRECACHE__.length };
const progressPorts = new Set<MessagePort>();
let precacheDone = false;

async function precache(cache: Cache): Promise<void> {
	let next = 0;
	// Keep downloads bounded and report actual completed files rather than simulated percentages.
	await Promise.all(
		Array.from({ length: 8 }, async () => {
			while (next < __PRECACHE__.length) {
				const path = __PRECACHE__[next++];
				if (!path) {
					continue;
				}
				try {
					await cache.add(path);
					startupProgress.completed++;
					for (const port of progressPorts) {
						port.postMessage(startupProgress);
					}
				} catch (error) {
					console.warn(`Unable to cache ${path}`, error);
				}
			}
		}),
	);
	precacheDone = true;
	for (const port of progressPorts) {
		port.close();
	}
	progressPorts.clear();
}

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE_NAME);
			await precache(cache);
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) {
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
	if (data.type === "startup-progress") {
		const port = event.ports[0];
		if (port) {
			port.postMessage(startupProgress);
			if (precacheDone) {
				port.close();
			} else {
				progressPorts.add(port);
			}
		}
	} else if (data.type === "runtime-ready" && source && "id" in source) {
		readyClients.add(source.id);
	} else if (data.type === "vfs-read-result") {
		pendingReads.get(data.id)?.(data.data);
		pendingReads.delete(data.id);
	}
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE_PATH)) {
		return;
	}
	const path = url.pathname;
	if (
		path.startsWith(WEBVIEW_PREFIX) ||
		(path === `${ASSET_PREFIX}vendor/scramjet/scramjet.wasm.wasm` && request.destination === "script")
	) {
		event.respondWith(
			(async () => {
				proxy ??= new ($scramjetLoadWorker().ScramjetServiceWorker)();
				await proxy.loadConfig();
				return proxy.fetch(event);
			})(),
		);
	} else if (request.method !== "GET" && request.method !== "HEAD") {
		return;
	} else if (path.startsWith(VFS_URL_PREFIX)) {
		event.respondWith(serveVfs(request, path, event.clientId));
	} else {
		event.respondWith(networkFirst(request));
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
