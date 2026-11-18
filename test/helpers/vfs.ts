import { createFs, type Vfs, type VfsOptions } from "../../src/vfs/index.ts";
import { createMemoryOpfs, type MemoryDirectoryHandle } from "./memory-opfs.ts";

export interface TestVfs {
	vfs: Vfs;
	fs: Vfs["fs"];
	root: MemoryDirectoryHandle;
	meta: MemoryDirectoryHandle;
	/** Mount another instance on the same backing store. */
	remount(options?: Partial<VfsOptions>): Promise<Vfs>;
}

const instances: Vfs[] = [];

export async function makeVfs(
	options: Partial<VfsOptions> & { root?: MemoryDirectoryHandle; meta?: MemoryDirectoryHandle } = {},
): Promise<TestVfs> {
	const root = options.root ?? createMemoryOpfs();
	const meta = options.meta ?? createMemoryOpfs();
	const base: VfsOptions = { channelName: null, ...options, root, metaDir: meta };
	const vfs = await createFs(base);
	instances.push(vfs);
	return {
		vfs,
		fs: vfs.fs,
		root,
		meta,
		async remount(extra = {}) {
			const next = await createFs({ ...base, ...extra, root, metaDir: meta });
			instances.push(next);
			return next;
		},
	};
}

/** Close every instance created by `makeVfs` (call from `after`/`afterEach`). */
export function closeAll(): void {
	for (const vfs of instances.splice(0)) {
		vfs.close();
	}
}

export async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeout = 2000,
	message = "condition",
): Promise<void> {
	const start = Date.now();
	while (!(await condition())) {
		if (Date.now() - start > timeout) {
			throw new Error(`Timed out waiting for ${message}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

export function tick(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let channelCounter = 0;
export function uniqueChannel(): string {
	return `vfs-test-${process.pid}-${Date.now()}-${channelCounter++}`;
}
