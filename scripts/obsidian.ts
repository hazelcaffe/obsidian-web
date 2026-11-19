import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { AsarArchive, extractTerms } from "../src/shared/asar.ts";
import { BUNDLE_MARKER, type BundleInfo } from "../src/shared/bundle.ts";
import { APP_PAGES } from "../src/shared/constants.ts";
import { normalizeBasePath } from "../src/shared/paths.ts";

// Pin the tested release for reproducible builds. Override with OBSIDIAN_VERSION or OBSIDIAN_ASAR.
const VERSION = "1.15.1";
const FAVICON = "https://obsidian.md/favicon.ico";

async function cachedDownload(cache: string, name: string, url: string): Promise<Buffer> {
	const path = join(cache, name);
	try {
		return await readFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
	console.log(`Downloading ${url}`);
	const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	if (!response.ok) {
		throw new Error(`Download failed (${response.status}): ${url}`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	await writeFile(path, bytes);
	return bytes;
}

/** Extract the app and replace its script scheduling with the OPFS-aware runtime startup. */
export async function bundleObsidian(root: string, out: string, basePath = "/"): Promise<string[]> {
	const base = normalizeBasePath(basePath);
	const cache = join(root, ".cache");
	await mkdir(cache, { recursive: true });
	const version = process.env.OBSIDIAN_VERSION ?? VERSION;
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error("OBSIDIAN_VERSION must be a version such as 1.15.1");
	}
	const asset = `obsidian-${version}.asar.gz`;
	const input = process.env.OBSIDIAN_ASAR
		? await readFile(process.env.OBSIDIAN_ASAR)
		: await cachedDownload(
				cache,
				asset,
				`https://github.com/obsidianmd/obsidian-releases/releases/download/v${version}/${asset}`,
			);
	const bytes = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input) : input;
	const archive = AsarArchive.parse(bytes);
	const read = (path: string): Buffer => {
		const entry = archive.locate(path);
		if (!entry || entry.start + entry.size > bytes.length) {
			throw new Error(`Missing or truncated archive entry: ${path}`);
		}
		return bytes.subarray(entry.start, entry.start + entry.size);
	};
	const pkg = JSON.parse(read("package.json").toString()) as { version: string };
	const terms = extractTerms(read("main.js").toString());
	if (!terms || !pkg.version) {
		throw new Error("Not an Obsidian desktop bundle");
	}
	const info: BundleInfo = { version: pkg.version, basePath: base, terms, scripts: {}, sandbox: [] };
	const paths: string[] = [];
	for (const path of archive.walk()) {
		if (path.split("/").some((part) => part === ".." || part === ".DS_Store" || part.includes("\\"))) {
			continue;
		}
		const url = `/${path}`;
		let data: Buffer | string = read(path);
		if (Object.hasOwn(APP_PAGES, url)) {
			const page = preparePage(data.toString(), APP_PAGES[url] as string, base);
			data = page.html;
			info.scripts[url] = page.scripts;
		} else if (base !== "/" && path.endsWith(".js")) {
			// Obsidian assumes its asset URLs and navigation routes are at the origin root.
			data = rebaseAssetLiterals(data.toString(), base, (candidate) => archive.getEntry(candidate) !== null);
		}
		if (path.startsWith("sandbox/")) {
			info.sandbox.push(path);
		}
		const target = join(out, path);
		await mkdir(join(target, ".."), { recursive: true });
		await writeFile(target, data);
		paths.push(`${base}${path}`);
	}
	await mkdir(join(out, "obsidian-web"), { recursive: true });
	await writeFile(join(out, "obsidian-web/app.json"), JSON.stringify(info));
	await writeFile(join(out, "favicon.ico"), await cachedDownload(cache, "favicon.ico", FAVICON));
	console.log(`Bundled Obsidian ${info.version} (${paths.length} files) into dist/`);
	return paths;
}

export function rebaseAssetLiterals(code: string, base: string, exists: (path: string) => boolean): string {
	return code.replace(/(["'])(\/(?!\/)[^"'\n\\]*)\1/g, (original, quote: string, path: string) => {
		const candidate = path.slice(1).split(/[?#]/)[0] ?? "";
		return candidate && exists(candidate) ? `${quote}${base}${path.slice(1)}${quote}` : original;
	});
}

export function preparePage(html: string, entry: string, base = "/"): { html: string; scripts: string[] } {
	const scripts: string[] = [];
	const page = html
		.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (_tag, attributes: string) => {
			const src = /\bsrc=["']([^"']+)["']/i.exec(attributes)?.[1];
			if (src) {
				scripts.push(src.startsWith("/") ? src : `/${src}`);
			}
			return "";
		})
		.replace(/<link\b[^>]*\brel=["']preload["'][^>]*>/gi, "");
	if (!scripts.includes(entry)) {
		scripts.push(entry);
	}
	const additions = `<meta name="${BUNDLE_MARKER}" content="true"/>
<link rel="icon" href="${base}favicon.ico"/>
<link rel="manifest" href="${base}obsidian-web/manifest.webmanifest"/>
<script defer src="${base}obsidian-web/runtime.js"></script>`;
	return {
		html: page.replace(/<\/head>/i, `${additions}\n</head>`),
		scripts: scripts.map((script) => `${base}${script.slice(1)}`),
	};
}
