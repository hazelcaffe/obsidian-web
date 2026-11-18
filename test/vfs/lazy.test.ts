import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createMemoryOpfs } from "../helpers/memory-opfs.ts";
import { closeAll, makeVfs, waitFor } from "../helpers/vfs.ts";

after(closeAll);

function eagain(error: unknown): boolean {
	const err = error as NodeJS.ErrnoException;
	assert.equal(err.code, "EAGAIN", String(error));
	assert.equal(err.errno, -11);
	assert.match(err.message, /still being loaded/);
	return true;
}

describe("lazy loading", () => {
	test("sync reads of unloaded files throw EAGAIN until loaded", async () => {
		const root = createMemoryOpfs();
		root.put("big.txt", "B".repeat(64));
		root.put("small.txt", "s");
		const { fs, vfs } = await makeVfs({ root, eagerLoadLimit: 32 });
		assert.equal(vfs.isLoaded("/small.txt"), true);
		assert.equal(vfs.isLoaded("/big.txt"), false);
		assert.equal(fs.statSync("/big.txt").size, 64);
		assert.throws(() => fs.readFileSync("/big.txt"), eagain);
		await waitFor(() => vfs.isLoaded("/big.txt"), 2000, "background load");
		assert.equal(fs.readFileSync("/big.txt", "utf8"), "B".repeat(64));
	});

	test("async APIs load on demand; preload enables sync access", async () => {
		const root = createMemoryOpfs();
		root.put("a.bin", "A".repeat(100));
		root.put("b.bin", "C".repeat(100));
		root.put("c.bin", "D".repeat(100));
		const { fs, vfs } = await makeVfs({ root, eagerLoadLimit: 10 });
		assert.equal(await fs.promises.readFile("/a.bin", "utf8"), "A".repeat(100));
		assert.equal(vfs.isLoaded("/a.bin"), true);
		const contents = await new Promise<string>((resolve, reject) =>
			fs.readFile("/b.bin", "utf8", (error: unknown, data: unknown) =>
				error ? reject(error) : resolve(String(data)),
			),
		);
		assert.equal(contents, "C".repeat(100));
		await vfs.preload("/c.bin");
		assert.equal(fs.readFileSync("/c.bin", "utf8"), "D".repeat(100));
		await fs.promises.copyFile("/c.bin", "/copy.bin");
		assert.equal(fs.readFileSync("/copy.bin", "utf8"), "D".repeat(100));
	});

	test("fd reads load on demand", async () => {
		const root = createMemoryOpfs();
		root.put("big", "0123456789".repeat(10));
		const { fs } = await makeVfs({ root, eagerLoadLimit: 10 });
		const handle = await fs.promises.open("/big");
		const { bytesRead, buffer } = await handle.read(Buffer.alloc(5), 0, 5, 10);
		assert.equal(bytesRead, 5);
		assert.equal(Buffer.from(buffer.buffer, buffer.byteOffset, 5).toString(), "01234");
		await handle.close();
		const fd = fs.openSync("/big", "r");
		assert.equal(fs.readSync(fd, Buffer.alloc(3), 0, 3, 0), 3);
		fs.closeSync(fd);
	});

	test("writes to unloaded files are applied without loading them", async () => {
		const root = createMemoryOpfs();
		root.put("log.txt", "x".repeat(50));
		root.put("trunc.txt", "y".repeat(50));
		root.put("over.txt", "z".repeat(50));
		const { fs, vfs } = await makeVfs({ root, eagerLoadLimit: 10 });
		fs.appendFileSync("/log.txt", "END");
		assert.equal(fs.statSync("/log.txt").size, 53);
		assert.equal(vfs.isLoaded("/log.txt"), false);
		fs.truncateSync("/trunc.txt", 5);
		fs.writeFileSync("/over.txt", "replaced");
		assert.equal(vfs.isLoaded("/over.txt"), true);
		const fd = fs.openSync("/log.txt", "r+");
		fs.writeSync(fd, "HEAD", 0);
		fs.closeSync(fd);
		assert.equal(await fs.promises.readFile("/log.txt", "utf8"), `HEAD${"x".repeat(46)}END`);
		assert.equal(await fs.promises.readFile("/trunc.txt", "utf8"), "yyyyy");
		await vfs.flush();
		assert.equal(root.read("log.txt"), `HEAD${"x".repeat(46)}END`);
		assert.equal(root.read("trunc.txt"), "yyyyy");
		assert.equal(root.read("over.txt"), "replaced");
	});

	test("writes made while a load is in flight are not lost", async () => {
		const root = createMemoryOpfs();
		root.put("race.txt", "a".repeat(40));
		const { fs, vfs } = await makeVfs({ root, eagerLoadLimit: 10 });
		const loading = vfs.preload("/race.txt");
		fs.appendFileSync("/race.txt", "!");
		await loading;
		assert.equal(fs.readFileSync("/race.txt", "utf8"), `${"a".repeat(40)}!`);
		await vfs.flush();
		assert.equal(root.read("race.txt"), `${"a".repeat(40)}!`);
	});

	test("shouldEagerLoad and preloadTree", async () => {
		const root = createMemoryOpfs();
		root.put("vaults/current/note.md", "current");
		root.put("vaults/current/.obsidian/app.json", "{}");
		root.put("vaults/other/note.md", "other");
		root.put("config.json", "{}");
		const { fs, vfs } = await makeVfs({
			root,
			shouldEagerLoad: (path, size) =>
				size < 1024 && (path.startsWith("/vaults/current/") || !path.startsWith("/vaults/")),
		});
		assert.equal(vfs.isLoaded("/vaults/current/note.md"), true);
		assert.equal(vfs.isLoaded("/config.json"), true);
		assert.equal(vfs.isLoaded("/vaults/other/note.md"), false);
		assert.deepEqual(fs.readdirSync("/vaults/other"), ["note.md"], "metadata is still complete");
		await vfs.preloadTree("/vaults/other");
		assert.equal(fs.readFileSync("/vaults/other/note.md", "utf8"), "other");
	});

	test("evicts least recently used lazily loaded contents", async () => {
		const root = createMemoryOpfs();
		for (const name of ["a", "b", "c"]) {
			root.put(name, name.repeat(100));
		}
		const { fs, vfs } = await makeVfs({ root, eagerLoadLimit: 10, lazyCacheLimit: 250 });
		await fs.promises.readFile("/a");
		await fs.promises.readFile("/b");
		assert.ok(vfs.isLoaded("/a") && vfs.isLoaded("/b"));
		await fs.promises.readFile("/c");
		assert.equal(vfs.isLoaded("/a"), false, "oldest entry evicted");
		assert.ok(vfs.isLoaded("/b") && vfs.isLoaded("/c"));
		assert.equal(await fs.promises.readFile("/a", "utf8"), "a".repeat(100));
		fs.writeFileSync("/b", "B".repeat(100));
		await fs.promises.readFile("/a");
		assert.equal(fs.readFileSync("/b", "utf8"), "B".repeat(100), "dirty or recent contents are kept");
		await vfs.flush();
		assert.equal(root.read("b"), "B".repeat(100));
	});
});
