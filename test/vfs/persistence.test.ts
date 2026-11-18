import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { Vfs } from "../../src/vfs/index.ts";
import { createMemoryOpfs, randomDelay } from "../helpers/memory-opfs.ts";
import { closeAll, makeVfs } from "../helpers/vfs.ts";

after(closeAll);

const MEMORY_ONLY = new Set(["tmp", "proc", "dev"]);

/** The persisted part of a VFS tree in the same format as MemoryDirectoryHandle#snapshot(). */
function treeSnapshot(fs: Vfs["fs"]): Record<string, string> {
	const out: Record<string, string> = {};
	const visit = (dir: string): void => {
		const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
			if (dir === "/" && MEMORY_ONLY.has(entry.name)) {
				continue;
			}
			if (entry.isDirectory()) {
				out[`${path}/`] = "";
				visit(path);
			} else if (entry.isFile()) {
				out[path] = fs.readFileSync(path, "utf8");
			}
		}
	};
	visit("/");
	return out;
}

function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

describe("persistence ordering", () => {
	test("write, rename and write again in quick succession", async () => {
		const root = createMemoryOpfs({ delay: randomDelay(3) });
		const { fs, vfs, remount } = await makeVfs({ root });
		fs.writeFileSync("/a", "v1");
		fs.renameSync("/a", "/b");
		fs.writeFileSync("/a", "v2");
		fs.writeFileSync("/b", "v3");
		fs.mkdirSync("/d");
		fs.renameSync("/b", "/d/b");
		fs.writeFileSync("/d/b", "v4");
		fs.renameSync("/d", "/e");
		fs.appendFileSync("/e/b", "+");
		fs.writeFileSync("/gone", "x");
		fs.unlinkSync("/gone");
		await vfs.flush();
		assert.deepEqual(root.snapshot(), { "/a": "v2", "/e/": "", "/e/b": "v4+" });
		const fresh = await remount();
		assert.deepEqual(treeSnapshot(fresh.fs), root.snapshot());
	});

	for (const seed of (process.env.VFS_SEEDS ?? "1,2,3,4,5").split(",").map(Number)) {
		test(`random operation sequences converge (seed ${seed})`, async () => {
			const random = prng(seed);
			const root = createMemoryOpfs({ delay: randomDelay(2), move: seed % 2 === 0 ? "all" : "files" });
			const { fs, vfs, remount } = await makeVfs({ root, eagerLoadLimit: 8 });
			const dirs = ["/d1", "/d2", "/d1/d3", "/"];
			const names = ["f1", "f2", "d1", "d2", "d3"];
			const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
			const path = (): string => {
				const dir = pick(dirs);
				return dir === "/" ? `/${pick(names)}` : `${dir}/${pick(names)}`;
			};
			for (let i = 0; i < 300; i++) {
				const op = Math.floor(random() * 8);
				try {
					switch (op) {
						case 0:
							fs.writeFileSync(path(), `w${i}-${"x".repeat(Math.floor(random() * 16))}`);
							break;
						case 1:
							fs.appendFileSync(path(), `a${i}`);
							break;
						case 2:
							fs.renameSync(path(), path());
							break;
						case 3:
							fs.mkdirSync(pick(dirs) === "/" ? path() : path(), { recursive: true });
							break;
						case 4:
							if (random() < 0.3) {
								fs.rmSync(path(), { recursive: true, force: true });
							}
							break;
						case 5:
							fs.truncateSync(path(), Math.floor(random() * 6));
							break;
						case 6:
							fs.copyFileSync(path(), path());
							break;
						case 7:
							await fs.promises.writeFile(path(), `p${i}`);
							break;
					}
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					assert.ok(
						["ENOENT", "EEXIST", "ENOTDIR", "EISDIR", "ENOTEMPTY", "EINVAL", "EAGAIN"].includes(
							String(code),
						),
						String(error),
					);
				}
			}
			await vfs.flush();
			for (const file of Object.keys(root.snapshot())) {
				if (!file.endsWith("/")) {
					await vfs.preload(file);
				}
			}
			assert.deepEqual(root.snapshot(), treeSnapshot(fs));
			const fresh = await remount();
			for (const file of Object.keys(root.snapshot())) {
				if (!file.endsWith("/")) {
					await fresh.preload(file);
				}
			}
			assert.deepEqual(treeSnapshot(fresh.fs), treeSnapshot(fs));
		});
	}

	test("coalesces repeated writes to the same file", async () => {
		const root = createMemoryOpfs({ delay: randomDelay(2) });
		const { fs, vfs } = await makeVfs({ root });
		for (let i = 0; i < 100; i++) {
			fs.writeFileSync("/c", String(i));
		}
		await vfs.flush();
		assert.equal(root.read("c"), "99");
		assert.ok(root.stats.writes < 10, `expected few OPFS writes, got ${root.stats.writes}`);
	});

	test("async APIs resolve after the change reached OPFS", async () => {
		const root = createMemoryOpfs({ delay: randomDelay(3) });
		const { fs } = await makeVfs({ root });
		await fs.promises.mkdir("/x/y", { recursive: true });
		assert.ok(root.lookup("x/y"));
		await fs.promises.writeFile("/x/y/z", "z");
		assert.equal(root.read("x/y/z"), "z");
		await fs.promises.rename("/x", "/w");
		assert.equal(root.read("w/y/z"), "z");
		await fs.promises.rm("/w", { recursive: true });
		assert.deepEqual(root.snapshot(), {});
		const handle = await fs.promises.open("/h", "w");
		await handle.write("abc");
		assert.equal(root.read("h"), "abc");
		await handle.close();
	});

	test("rejects when persisting fails", async () => {
		const root = createMemoryOpfs();
		const { fs } = await makeVfs({ root });
		root.getFileHandle = async () => {
			throw new DOMException("quota", "QuotaExceededError");
		};
		const logged: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => logged.push(args);
		try {
			await assert.rejects(fs.promises.writeFile("/f", "x"), (error: unknown) => {
				assert.equal((error as NodeJS.ErrnoException).code, "ENOSPC");
				return true;
			});
		} finally {
			console.error = original;
		}
		assert.equal(logged.length, 1, "failures are logged");
	});

	test("getHandle returns the persisted file", async () => {
		const { fs, vfs } = await makeVfs();
		fs.writeFileSync("/file.txt", "persisted");
		fs.mkdirSync("/dir");
		fs.writeFileSync("/tmp/mem", "m");
		const handle = await vfs.getHandle("/file.txt");
		assert.ok(handle);
		const file = await handle.getFile();
		assert.equal(new TextDecoder().decode(await file.arrayBuffer()), "persisted");
		assert.equal(await vfs.getHandle("/dir"), null);
		assert.equal(await vfs.getHandle("/tmp/mem"), null);
		assert.equal(await vfs.getHandle("/missing"), null);
	});
});

describe("virtual files and memory-only paths", () => {
	test("virtual files are lazy, read-only and never persisted", async () => {
		const { fs, vfs, root, remount } = await makeVfs();
		vfs.registerVirtualFile("/tmp/drop/photo.png", new File(["image bytes"], "photo.png", { lastModified: 5000 }));
		const stat = fs.statSync("/tmp/drop/photo.png");
		assert.equal(stat.size, 11);
		assert.equal(stat.mtimeMs, 5000);
		assert.equal(stat.mode, 0o100444);
		assert.equal(vfs.isLoaded("/tmp/drop/photo.png"), false);
		assert.throws(
			() => fs.readFileSync("/tmp/drop/photo.png"),
			(error: unknown) => (error as NodeJS.ErrnoException).code === "EAGAIN",
		);
		assert.equal(await fs.promises.readFile("/tmp/drop/photo.png", "utf8"), "image bytes");
		assert.throws(
			() => fs.writeFileSync("/tmp/drop/photo.png", "x"),
			(error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES",
		);
		await fs.promises.copyFile("/tmp/drop/photo.png", "/vault-copy.png");

		vfs.registerVirtualFile("/outside.bin", new Blob(["virtual outside"]));
		assert.equal(await fs.promises.readFile("/outside.bin", "utf8"), "virtual outside");
		vfs.registerVirtualFile("/moved-src.bin", new Blob(["will move"]));
		await fs.promises.rename("/moved-src.bin", "/tmp/moved.bin");
		vfs.registerVirtualFile("/tmp/drop/second.txt", new Blob(["second"]));
		await fs.promises.rename("/tmp/drop/second.txt", "/second.txt");
		await vfs.flush();
		assert.deepEqual(root.snapshot(), { "/second.txt": "second", "/vault-copy.png": "image bytes" });
		fs.unlinkSync("/outside.bin");
		assert.equal(fs.existsSync("/outside.bin"), false);
		const fresh = await remount();
		assert.equal(fresh.fs.existsSync("/tmp/drop"), false);
		assert.equal(fresh.fs.readFileSync("/second.txt", "utf8"), "second");
		assert.throws(
			() => vfs.registerVirtualFile("/tmp", new Blob([])),
			(error: unknown) => (error as NodeJS.ErrnoException).code === "EISDIR",
		);
	});

	test("memory-only prefixes are kept out of OPFS", async () => {
		const { fs, vfs, root } = await makeVfs({ memoryOnlyPrefixes: ["/tmp", "/scratch"] });
		fs.writeFileSync("/tmp/a", "a");
		fs.mkdirSync("/scratch/deep", { recursive: true });
		fs.writeFileSync("/scratch/deep/b", "b");
		const temp = fs.mkdtempSync("/tmp/work-");
		assert.match(temp, /^\/tmp\/work-[A-Za-z0-9]{6}$/);
		assert.ok(fs.statSync(temp).isDirectory());
		fs.writeFileSync("/keep", "k");
		await vfs.flush();
		assert.deepEqual(root.snapshot(), { "/keep": "k" });

		fs.renameSync("/keep", "/tmp/keep");
		await vfs.flush();
		assert.deepEqual(root.snapshot(), {});
		assert.equal(fs.readFileSync("/tmp/keep", "utf8"), "k");

		fs.renameSync("/scratch/deep", "/restored");
		await vfs.flush();
		assert.deepEqual(root.snapshot(), { "/restored/": "", "/restored/b": "b" });
		assert.equal(fs.existsSync("/proc"), false, "custom prefixes replace the defaults");
	});

	test("moving unloaded files into memory loads them first", async () => {
		const root = createMemoryOpfs();
		root.put("large.bin", "L".repeat(100));
		const { fs, vfs } = await makeVfs({ root, eagerLoadLimit: 10 });
		assert.throws(
			() => fs.renameSync("/large.bin", "/tmp/large.bin"),
			(error: unknown) => (error as NodeJS.ErrnoException).code === "EAGAIN",
		);
		assert.equal(fs.existsSync("/large.bin"), true, "nothing changed");
		await fs.promises.rename("/large.bin", "/tmp/large.bin");
		await vfs.flush();
		assert.equal(fs.readFileSync("/tmp/large.bin", "utf8"), "L".repeat(100));
		assert.deepEqual(root.snapshot(), {});
	});
});
