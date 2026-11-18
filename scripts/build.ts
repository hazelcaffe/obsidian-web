import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuildOptions, build, context } from "esbuild";
import { bundleObsidian } from "./obsidian.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
const assets = join(out, "obsidian-web");
const watch = process.argv.includes("--watch");
const production = !watch && !process.argv.includes("--dev");

const PRECACHE = [
	"/",
	"/obsidian-web/runtime.js",
	"/favicon.ico",
	"/obsidian-web/app.json",
	"/obsidian-web/manifest.webmanifest",
	"/obsidian-web/vendor/libcurl.mjs",
	"/obsidian-web/vendor/libcurl.wasm",
];

const common: BuildOptions = {
	bundle: true,
	format: "iife",
	platform: "browser",
	target: ["chrome120", "firefox128", "safari17"],
	sourcemap: "linked",
	minify: production,
	legalComments: "linked",
	logLevel: "info",
	external: ["/obsidian-web/*"],
	alias: {
		stream: "readable-stream",
		path: "path-browserify",
		querystring: "querystring-es3",
		zlib: "browserify-zlib",
	},
	define: { "process.env.NODE_DEBUG": "false" },
};

async function copyStatic(): Promise<void> {
	await mkdir(join(assets, "vendor"), { recursive: true });
	for (const entry of await readdir(join(root, "public"))) {
		const target = entry === "index.html" ? join(out, entry) : join(assets, entry);
		await cp(join(root, "public", entry), target, { recursive: true });
	}
	const libcurl = join(root, "node_modules/libcurl.js");
	await copyFile(join(libcurl, "libcurl.wasm"), join(assets, "vendor/libcurl.wasm"));
	await copyFile(join(libcurl, "LICENSE"), join(assets, "vendor/libcurl.LICENSE"));
	// Emscripten treats any page with `process.versions.node` as Node.js, which the runtime emulates.
	const source = await readFile(join(libcurl, "libcurl.mjs"), "utf8");
	const detection = /var ENVIRONMENT_IS_NODE=typeof process=="object"[^;]*;/;
	if (!detection.test(source)) {
		throw new Error("Unable to patch the environment detection of libcurl.js");
	}
	await writeFile(join(assets, "vendor/libcurl.mjs"), source.replace(detection, "var ENVIRONMENT_IS_NODE=false;"));
}

async function buildId(): Promise<string> {
	const hash = createHash("sha256");
	for (const file of ["runtime.js", "app.json"]) {
		hash.update(await readFile(join(assets, file)));
	}
	return hash.digest("hex").slice(0, 16);
}

async function buildServiceWorker(): Promise<void> {
	await build({
		...common,
		entryPoints: [join(root, "src/sw/index.ts")],
		outfile: join(out, "sw.js"),
		define: {
			...common.define,
			__BUILD_ID__: JSON.stringify(await buildId()),
			__PRECACHE__: JSON.stringify(PRECACHE),
		},
	});
}

const pages: BuildOptions = {
	...common,
	entryPoints: {
		runtime: join(root, "src/runtime/index.ts"),
	},
	outdir: assets,
};

await rm(out, { recursive: true, force: true });
await copyStatic();
PRECACHE.push(...(await bundleObsidian(root, out)));

if (watch) {
	const ctx = await context({
		...pages,
		plugins: [
			{
				name: "service-worker",
				setup(builder) {
					builder.onEnd(async (result) => {
						if (result.errors.length === 0) {
							await buildServiceWorker();
						}
					});
				},
			},
		],
	});
	await ctx.watch();
} else {
	await build(pages);
	await buildServiceWorker();
}
