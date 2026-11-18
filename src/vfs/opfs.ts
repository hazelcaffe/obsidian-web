import { isDomError } from "./errors.ts";
import type { Patch } from "./nodes.ts";
import {
	isDirectoryHandle,
	isFileHandle,
	type OpfsDirectoryHandle,
	type OpfsFileHandle,
	type OpfsHandle,
	type OpfsHandleBase,
} from "./opfs-types.ts";
import { basename, dirname, splitPath } from "./path.ts";

export async function* listEntries(dir: OpfsDirectoryHandle): AsyncGenerator<OpfsHandle> {
	if (!dir.values) {
		throw new Error("OPFS directory iteration is not supported by this browser");
	}
	for await (const entry of dir.values()) {
		if (isDirectoryHandle(entry) || isFileHandle(entry)) {
			yield entry;
		}
	}
}

export async function getDirectory(
	root: OpfsDirectoryHandle,
	path: string,
	create: boolean,
): Promise<OpfsDirectoryHandle> {
	let dir = root;
	for (const segment of splitPath(path)) {
		dir = await dir.getDirectoryHandle(segment, { create });
	}
	return dir;
}

export async function getHandle(root: OpfsDirectoryHandle, path: string): Promise<OpfsHandle | null> {
	if (splitPath(path).length === 0) {
		return root;
	}
	try {
		const parent = await getDirectory(root, dirname(path), false);
		return await getChild(parent, basename(path));
	} catch (error) {
		if (isDomError(error, "NotFoundError") || isDomError(error, "TypeMismatchError")) {
			return null;
		}
		throw error;
	}
}

async function getChild(parent: OpfsDirectoryHandle, name: string): Promise<OpfsHandle | null> {
	try {
		return await parent.getFileHandle(name);
	} catch (error) {
		if (isDomError(error, "TypeMismatchError")) {
			return await parent.getDirectoryHandle(name);
		}
		if (isDomError(error, "NotFoundError")) {
			return null;
		}
		throw error;
	}
}

async function getFileForWrite(root: OpfsDirectoryHandle, path: string): Promise<OpfsFileHandle> {
	const parent = await getDirectory(root, dirname(path), true);
	const name = basename(path);
	try {
		return await parent.getFileHandle(name, { create: true });
	} catch (error) {
		if (!isDomError(error, "TypeMismatchError")) {
			throw error;
		}
		// A stale directory occupies the path: replace it.
		await parent.removeEntry(name, { recursive: true });
		return await parent.getFileHandle(name, { create: true });
	}
}

export async function readFile(root: OpfsDirectoryHandle, path: string): Promise<Uint8Array<ArrayBuffer>> {
	const handle = await getHandle(root, path);
	if (!handle || !isFileHandle(handle)) {
		throw new DOMException(`${path} not found`, "NotFoundError");
	}
	const file = await handle.getFile();
	return new Uint8Array(await file.arrayBuffer());
}

export async function writeFile(root: OpfsDirectoryHandle, path: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
	const handle = await getFileForWrite(root, path);
	const writable = await handle.createWritable();
	try {
		await writable.write(data);
	} catch (error) {
		await writable.abort?.(error).catch(() => {});
		throw error;
	}
	await writable.close();
}

export async function patchFile(root: OpfsDirectoryHandle, path: string, patch: Patch): Promise<void> {
	const handle = await getFileForWrite(root, path);
	const writable = await handle.createWritable({ keepExistingData: true });
	try {
		if (patch.type === "write") {
			await writable.write({ type: "write", position: patch.position, data: patch.data });
		} else {
			await writable.truncate(patch.size);
		}
	} catch (error) {
		await writable.abort?.(error).catch(() => {});
		throw error;
	}
	await writable.close();
}

export async function makeDirectory(root: OpfsDirectoryHandle, path: string): Promise<void> {
	const parent = await getDirectory(root, dirname(path), true);
	const name = basename(path);
	try {
		await parent.getDirectoryHandle(name, { create: true });
	} catch (error) {
		if (!isDomError(error, "TypeMismatchError")) {
			throw error;
		}
		await parent.removeEntry(name);
		await parent.getDirectoryHandle(name, { create: true });
	}
}

export async function removeEntry(root: OpfsDirectoryHandle, path: string): Promise<void> {
	try {
		const parent = await getDirectory(root, dirname(path), false);
		await parent.removeEntry(basename(path), { recursive: true });
	} catch (error) {
		if (!isDomError(error, "NotFoundError") && !isDomError(error, "TypeMismatchError")) {
			throw error;
		}
	}
}

export async function moveEntry(root: OpfsDirectoryHandle, from: string, to: string): Promise<void> {
	const source = await getHandle(root, from);
	if (!source) {
		throw new DOMException(`${from} not found`, "NotFoundError");
	}
	const targetParent = await getDirectory(root, dirname(to), true);
	const targetName = basename(to);
	await removeEntry(root, to);
	if (source.move) {
		try {
			await source.move(targetParent, targetName);
			return;
		} catch {
			// Fall back to copying (e.g. directories cannot be moved in some browsers).
		}
	}
	await copyEntry(source, targetParent, targetName);
	const sourceParent = await getDirectory(root, dirname(from), false);
	await sourceParent.removeEntry(basename(from), { recursive: true });
}

async function copyEntry(source: OpfsHandleBase, targetParent: OpfsDirectoryHandle, name: string): Promise<void> {
	if (isFileHandle(source)) {
		const file = await source.getFile();
		const target = await targetParent.getFileHandle(name, { create: true });
		const writable = await target.createWritable();
		await writable.write(new Uint8Array(await file.arrayBuffer()));
		await writable.close();
	} else if (isDirectoryHandle(source)) {
		const target = await targetParent.getDirectoryHandle(name, { create: true });
		for await (const child of listEntries(source)) {
			await copyEntry(child, target, child.name);
		}
	}
}

export async function readText(dir: OpfsDirectoryHandle, name: string): Promise<string | null> {
	try {
		const handle = await dir.getFileHandle(name);
		const file = await handle.getFile();
		return new TextDecoder().decode(await file.arrayBuffer());
	} catch (error) {
		if (isDomError(error, "NotFoundError") || isDomError(error, "TypeMismatchError")) {
			return null;
		}
		throw error;
	}
}

export async function writeText(dir: OpfsDirectoryHandle, name: string, text: string): Promise<void> {
	const handle = await dir.getFileHandle(name, { create: true });
	const writable = await handle.createWritable();
	await writable.write(new TextEncoder().encode(text));
	await writable.close();
}
