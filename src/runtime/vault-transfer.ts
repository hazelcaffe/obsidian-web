import { unzip, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import pathModule from "path-browserify";
import { DOCUMENTS } from "./env.ts";
import { getVfs } from "./vfs-instance.ts";

const STORED_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|mp3|mp4|m4a|webm|ogg|opus|flac|mov|mkv|zip|gz|pdf|woff2?)$/i;

function triggerDownload(win: Window, blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const link = win.document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function listFiles(dir: string, prefix = ""): Promise<Array<{ path: string; relative: string }>> {
	const fs = getVfs().fs;
	const out: Array<{ path: string; relative: string }> = [];
	for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
		const path = `${dir}/${entry.name}`;
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			out.push(...(await listFiles(path, relative)));
		} else if (entry.isFile()) {
			out.push({ path, relative });
		}
	}
	return out;
}

/** Packs a folder of the virtual file system into a ZIP archive. */
export async function zipFolder(dir: string): Promise<Blob> {
	const fs = getVfs().fs;
	const root = pathModule.basename(dir);
	const parts: BlobPart[] = [];
	let failure: Error | null = null;
	const finished = new Promise<void>((resolve, reject) => {
		const archive = new Zip((error, chunk, final) => {
			if (error) {
				failure = error;
				reject(error);
				return;
			}
			parts.push(chunk.slice());
			if (final) {
				resolve();
			}
		});
		(async () => {
			for (const file of await listFiles(dir)) {
				if (failure) {
					return;
				}
				const data = new Uint8Array(await fs.promises.readFile(file.path));
				const stat = await fs.promises.stat(file.path);
				const name = `${root}/${file.relative}`;
				const entry = STORED_EXTENSIONS.test(name)
					? new ZipPassThrough(name)
					: new ZipDeflate(name, { level: 6 });
				entry.mtime = stat.mtimeMs;
				archive.add(entry);
				entry.push(data, true);
			}
			archive.end();
		})().catch(reject);
	});
	await finished;
	return new Blob(parts, { type: "application/zip" });
}

/** `shell.showItemInFolder`: there is no file manager, so the item is handed to the browser as a download. */
export async function revealItem(win: Window, path: string): Promise<void> {
	const fs = getVfs().fs;
	const stat = await fs.promises.stat(path);
	if (stat.isDirectory()) {
		triggerDownload(win, await zipFolder(path), `${pathModule.basename(path)}.zip`);
	} else {
		triggerDownload(win, new Blob([new Uint8Array(await fs.promises.readFile(path))]), pathModule.basename(path));
	}
}

function availableFolder(name: string): string {
	const fs = getVfs().fs;
	const base = `${DOCUMENTS}/${name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Imported vault"}`;
	let target = base;
	for (let i = 2; fs.existsSync(target); i++) {
		target = `${base} ${i}`;
	}
	return target;
}

async function writeFile(path: string, data: Uint8Array, mtime?: number): Promise<void> {
	const fs = getVfs().fs;
	await fs.promises.mkdir(pathModule.dirname(path), { recursive: true });
	await fs.promises.writeFile(path, data);
	if (mtime) {
		await fs.promises.utimes(path, mtime / 1000, mtime / 1000);
	}
}

export type ImportProgress = (done: number, total: number) => void;

/** Copies a folder picked with `<input webkitdirectory>` into a new folder under Documents. */
export async function importFolder(files: File[], onProgress?: ImportProgress): Promise<string> {
	const first = files[0]?.webkitRelativePath.split("/")[0] ?? "Imported vault";
	const target = availableFolder(first);
	let done = 0;
	for (const file of files) {
		const relative = file.webkitRelativePath.split("/").slice(1).join("/") || file.name;
		await writeFile(`${target}/${relative}`, new Uint8Array(await file.arrayBuffer()), file.lastModified);
		onProgress?.(++done, files.length);
	}
	await getVfs().fs.promises.mkdir(target, { recursive: true });
	return target;
}

/** Extracts a ZIP archive into a new folder. A single top-level folder in the archive becomes the vault itself. */
export async function importZip(file: File, onProgress?: ImportProgress): Promise<string> {
	const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
		file.arrayBuffer().then(
			(buffer) => unzip(new Uint8Array(buffer), (error, data) => (error ? reject(error) : resolve(data))),
			reject,
		);
	});
	const names = Object.keys(entries).filter((name) => !name.startsWith("__MACOSX/"));
	const roots = new Set(names.map((name) => name.split("/")[0]));
	const single = roots.size === 1 && names.every((name) => name.includes("/")) ? [...roots][0] : null;
	const target = availableFolder(single ?? file.name.replace(/\.zip$/i, ""));
	let done = 0;
	for (const name of names) {
		const relative = single ? name.slice(single.length + 1) : name;
		if (!relative || name.endsWith("/")) {
			if (relative) {
				await getVfs().fs.promises.mkdir(`${target}/${relative}`, { recursive: true });
			}
		} else {
			await writeFile(`${target}/${relative}`, entries[name] ?? new Uint8Array(0));
		}
		onProgress?.(++done, names.length);
	}
	await getVfs().fs.promises.mkdir(target, { recursive: true });
	return target;
}
