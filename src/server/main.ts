import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { logging, server as wisp } from "@mercuryworkshop/wisp-js/server";
import { mimeType } from "../shared/mime.ts";

const { values } = parseArgs({
	args: process.argv.slice(2).filter((arg, index) => index !== 0 || arg !== "--"),
	options: {
		port: { type: "string", default: process.env.PORT ?? "3000" },
		host: { type: "string", default: process.env.HOST ?? "0.0.0.0" },
	},
});
const root = resolve(import.meta.dirname, "../../dist");
const { basePath = "/" } = JSON.parse(await readFile(join(root, "obsidian-web/app.json"), "utf8")) as {
	basePath?: string;
};

async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		response.writeHead(405, { Allow: "GET, HEAD" }).end();
		return;
	}
	let pathname: string;
	try {
		pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
	} catch {
		response.writeHead(400).end();
		return;
	}
	if (!pathname.startsWith(basePath)) {
		response.writeHead(302, { Location: basePath }).end();
		return;
	}
	const relative = pathname.slice(basePath.length);
	const path = join(root, relative || "index.html");
	if (!path.startsWith(root + sep)) {
		response.writeHead(403).end();
		return;
	}
	try {
		const file = await stat(path);
		if (!file.isFile()) {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, {
			"Content-Type": mimeType(path),
			"Content-Length": file.size,
			"Cache-Control": "no-cache",
		});
		if (request.method === "HEAD") {
			response.end();
		} else {
			createReadStream(path)
				.on("error", () => response.destroy())
				.pipe(response);
		}
	} catch {
		response.writeHead(404).end("Not found");
	}
}

await stat(join(root, "index.html")).catch(() => {
	console.error("Run pnpm build first.");
	process.exit(1);
});

logging.set_level(logging.WARN);
wisp.options.parse_real_ip = false;
wisp.options.allow_udp_streams = false;
wisp.options.allow_private_ips = process.env.WISP_ALLOW_PRIVATE === "1";
wisp.options.allow_loopback_ips = process.env.WISP_ALLOW_PRIVATE === "1";
const server = createServer((request, response) => {
	void serve(request, response).catch(() => response.destroy());
});
server.on("upgrade", (request, socket, head) => {
	let sameOrigin = false;
	try {
		sameOrigin = new URL(request.headers.origin ?? "").host === request.headers.host;
	} catch {}
	if (!sameOrigin || request.url !== "/wisp/") {
		socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
		return;
	}
	wisp.routeRequest(request, socket, head);
});
server.listen(Number(values.port), values.host, () => {
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : values.port;
	console.log(`Obsidian Web is running at http://localhost:${port}${basePath}`);
});
