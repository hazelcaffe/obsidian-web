#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { dirname, extname, join, normalize, sep } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { logging, server as wisp } from "@mercuryworkshop/wisp-js/server";

const { values: args } = parseArgs({
	options: {
		host: { type: "string", default: process.env.HOST ?? "127.0.0.1" },
		port: { type: "string", short: "p", default: process.env.PORT ?? "8080" },
		root: { type: "string" },
		cert: { type: "string" },
		key: { type: "string" },
		"allow-private": { type: "boolean" },
		"no-wisp": { type: "boolean" },
		"trust-proxy": { type: "boolean" },
		verbose: { type: "boolean", short: "v" },
		help: { type: "boolean", short: "h" },
	},
});

if (args.help) {
	console.log(`Usage: obsidian-web [options]

Serves Obsidian Web and a Wisp proxy for its network requests.

Options:
  --host <host>       Interface to listen on (default 127.0.0.1, env HOST)
  -p, --port <port>   Port to listen on (default 8080, env PORT)
  --cert <file>       TLS certificate (PEM). Needed to use it from other devices,
  --key <file>        because browsers only allow service workers in secure contexts.
  --allow-private     Let the proxy reach private and loopback addresses
                      (default: only when listening on localhost)
  --no-wisp           Do not run the Wisp proxy (use an external one)
  --trust-proxy       Trust X-Forwarded-* headers from a reverse proxy
  -v, --verbose       Log proxy connections
  -h, --help          Show this help`);
	process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = normalize(args.root ?? join(here, "../../dist/public"));
const port = Number(args.port);
const host = args.host ?? "127.0.0.1";
const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".map": "application/json; charset=utf-8",
	".wasm": "application/wasm",
	".svg": "image/svg+xml",
	".png": "image/png",
	".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "same-origin",
	"Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};

async function serveStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		response.writeHead(405, { Allow: "GET, HEAD" }).end();
		return;
	}
	const url = new URL(request.url ?? "/", "http://localhost");
	let pathname: string;
	try {
		pathname = decodeURIComponent(url.pathname);
	} catch {
		response.writeHead(400).end();
		return;
	}
	if (pathname === "/" || pathname === "/index.html") {
		pathname = "/index.html";
	}
	const file = normalize(join(root, pathname));
	if (file !== root && !file.startsWith(root + sep)) {
		response.writeHead(403).end();
		return;
	}
	try {
		const info = await stat(file);
		if (!info.isFile()) {
			throw new Error("Not a file");
		}
		const headers: Record<string, string> = {
			...SECURITY_HEADERS,
			"Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
			"Content-Length": String(info.size),
			"Cache-Control": "no-cache",
			"Last-Modified": info.mtime.toUTCString(),
		};
		if (pathname === "/sw.js") {
			headers["Service-Worker-Allowed"] = "/";
		}
		if (request.headers["if-modified-since"] === headers["Last-Modified"]) {
			response.writeHead(304, headers).end();
			return;
		}
		response.writeHead(200, headers);
		if (request.method === "HEAD") {
			response.end();
			return;
		}
		createReadStream(file).pipe(response);
	} catch {
		const notFound = pathname.endsWith(".html") ? await readFile(join(root, "index.html")).catch(() => null) : null;
		if (notFound) {
			// App pages are served by the service worker; without it, the boot page installs it.
			response.writeHead(200, {
				...SECURITY_HEADERS,
				"Content-Type": TYPES[".html"],
				"Cache-Control": "no-cache",
			});
			response.end(notFound);
			return;
		}
		response.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain" }).end("Not found");
	}
}

function originAllowed(request: IncomingMessage): boolean {
	const origin = request.headers.origin;
	if (!origin) {
		return false;
	}
	const forwardedHost = args["trust-proxy"] ? request.headers["x-forwarded-host"] : undefined;
	const expected = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers.host;
	try {
		return new URL(origin).host === expected;
	} catch {
		return false;
	}
}

function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
	const path = new URL(request.url ?? "/", "http://localhost").pathname;
	if (args["no-wisp"] || !path.startsWith("/wisp/")) {
		socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
		return;
	}
	// WebSockets are not bound by CORS: refuse other sites so they cannot use the proxy.
	if (!originAllowed(request)) {
		socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
		return;
	}
	wisp.routeRequest(request, socket, head);
}

wisp.options.allow_private_ips = args["allow-private"] ?? loopback;
wisp.options.allow_loopback_ips = args["allow-private"] ?? loopback;
wisp.options.allow_udp_streams = false;
wisp.options.parse_real_ip = !!args["trust-proxy"];
logging.set_level(args.verbose ? logging.INFO : logging.WARN);

const handler = (request: IncomingMessage, response: ServerResponse): void => {
	serveStatic(request, response).catch((error: unknown) => {
		console.error(error);
		if (!response.headersSent) {
			response.writeHead(500).end();
		}
	});
};

const server =
	args.cert && args.key
		? createHttpsServer({ cert: await readFile(args.cert), key: await readFile(args.key) }, handler)
		: createHttpServer(handler);
server.on("upgrade", handleUpgrade);

try {
	await stat(join(root, "index.html"));
} catch {
	console.error(`No build found in ${root}. Run "pnpm build" first.`);
	process.exit(1);
}

server.listen(port, host, () => {
	const scheme = args.cert ? "https" : "http";
	const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host.includes(":") ? `[${host}]` : host;
	const address = server.address();
	const actualPort = typeof address === "object" && address ? address.port : port;
	console.log(`Obsidian Web is running at ${scheme}://${shown}:${actualPort}/`);
	if (!args.cert && !loopback) {
		console.warn("Warning: browsers only allow Obsidian Web over HTTPS or on localhost. Use --cert/--key.");
	}
});
