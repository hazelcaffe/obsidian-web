import { AsarArchive } from "./asar.ts";

/** OPFS layout shared by the boot page, the service worker and the runtime. */
export const OPFS_APP_DIR = "app";
export const OPFS_VFS_DIR = "vfs";
export const VFS_META_FILE = "vfs-meta.json";
const INSTALLED_FILE = "installed.json";

export interface InstalledApp {
	version: string;
	file: string;
	installedAt: number;
	source: string;
	/** The string `main.js` compares against `app.js` to verify both come from the same release. */
	terms: string;
}

export interface OpenedApp {
	info: InstalledApp;
	file: File;
	archive: AsarArchive;
}

export function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
	return navigator.storage.getDirectory();
}

async function getAppDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
	try {
		return await (await getOpfsRoot()).getDirectoryHandle(OPFS_APP_DIR, { create });
	} catch {
		return null;
	}
}

export async function readInstalledApp(): Promise<InstalledApp | null> {
	const dir = await getAppDir(false);
	if (!dir) {
		return null;
	}
	try {
		const handle = await dir.getFileHandle(INSTALLED_FILE);
		const info = JSON.parse(await (await handle.getFile()).text()) as InstalledApp;
		return typeof info.version === "string" && typeof info.file === "string" ? info : null;
	} catch {
		return null;
	}
}

export async function openInstalledApp(): Promise<OpenedApp | null> {
	const info = await readInstalledApp();
	const dir = await getAppDir(false);
	if (!info || !dir) {
		return null;
	}
	try {
		const file = await (await dir.getFileHandle(info.file)).getFile();
		return { info, file, archive: await AsarArchive.fromBlob(file) };
	} catch {
		return null;
	}
}

export async function readArchiveText(file: Blob, archive: AsarArchive, path: string): Promise<string | null> {
	const location = archive.locate(path);
	if (!location) {
		return null;
	}
	return file.slice(location.start, location.start + location.size).text();
}

export type InstallProgress = (bytes: number) => void;

/**
 * Stores an `obsidian.asar` (optionally gzip compressed) in OPFS, validates it and makes it the active version.
 * Older installed archives are removed afterwards.
 */
export async function installArchive(
	source: ReadableStream<Uint8Array>,
	options: { gzip: boolean; sourceLabel: string; onProgress?: InstallProgress },
): Promise<InstalledApp> {
	const dir = await getAppDir(true);
	if (!dir) {
		throw new Error("Unable to access the origin private file system");
	}
	const tempName = `incoming-${Date.now()}.asar`;
	const tempHandle = await dir.getFileHandle(tempName, { create: true });
	let received = 0;
	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			received += chunk.byteLength;
			options.onProgress?.(received);
			controller.enqueue(chunk);
		},
	});
	let stream = source.pipeThrough(counter);
	if (options.gzip) {
		stream = stream.pipeThrough(
			new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
		);
	}
	const writable = await tempHandle.createWritable();
	await stream.pipeTo(writable);

	try {
		const file = await tempHandle.getFile();
		const archive = await AsarArchive.fromBlob(file);
		const pkgText = await readArchiveText(file, archive, "package.json");
		const mainText = await readArchiveText(file, archive, "main.js");
		if (!pkgText || !mainText || !archive.locate("app.js") || !archive.locate("index.html")) {
			throw new Error("This archive does not look like an Obsidian app bundle");
		}
		const pkg = JSON.parse(pkgText) as { version?: unknown };
		if (typeof pkg.version !== "string") {
			throw new Error("The archive has no version");
		}
		const terms = extractTerms(mainText);
		if (!terms) {
			throw new Error("Unable to read the license notice from main.js");
		}
		const fileName = `obsidian-${pkg.version}.asar`;
		const previous = await readInstalledApp();
		await copyFile(dir, tempHandle, fileName);
		const info: InstalledApp = {
			version: pkg.version,
			file: fileName,
			installedAt: Date.now(),
			source: options.sourceLabel,
			terms,
		};
		const infoHandle = await dir.getFileHandle(INSTALLED_FILE, { create: true });
		const infoWritable = await infoHandle.createWritable();
		await infoWritable.write(JSON.stringify(info, null, "\t"));
		await infoWritable.close();
		// The previous archive is kept so that open windows can keep loading files until they relaunch.
		for await (const name of dir.keys()) {
			if (name !== fileName && name !== INSTALLED_FILE && name !== previous?.file && name !== tempName) {
				await dir.removeEntry(name).catch(() => undefined);
			}
		}
		return info;
	} finally {
		await dir.removeEntry(tempName).catch(() => undefined);
	}
}

async function copyFile(dir: FileSystemDirectoryHandle, from: FileSystemFileHandle, name: string): Promise<void> {
	const target = await dir.getFileHandle(name, { create: true });
	const writable = await target.createWritable();
	await (await from.getFile()).stream().pipeTo(writable);
}

/** Finds the license notice string in `main.js`, which `app.js` checks through the `terms` IPC call. */
export function extractTerms(mainJs: string): string | null {
	const match = /"(I understand and agree[^"\\]*(?:\\.[^"\\]*)*)"/.exec(mainJs);
	return match?.[1] ? (JSON.parse(`"${match[1]}"`) as string) : null;
}

export async function uninstallApp(): Promise<void> {
	await (await getOpfsRoot()).removeEntry(OPFS_APP_DIR, { recursive: true }).catch(() => undefined);
}
