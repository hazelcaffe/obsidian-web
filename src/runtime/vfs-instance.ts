import type { Vfs } from "../vfs/index.ts";

let instance: Vfs | null = null;

export function setVfs(vfs: Vfs): void {
	instance = vfs;
}

export function getVfs(): Vfs {
	if (!instance) {
		throw new Error("The file system is not mounted yet");
	}
	return instance;
}

export function hasVfs(): boolean {
	return instance !== null;
}
