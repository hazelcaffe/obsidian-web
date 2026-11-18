import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createMemoryOpfs } from "../helpers/memory-opfs.ts";
import { closeAll, makeVfs, tick } from "../helpers/vfs.ts";

after(closeAll);

function code(expected: string): (error: unknown) => boolean {
	return (error) => {
		assert.equal((error as NodeJS.ErrnoException).code, expected, String(error));
		return true;
	};
}

describe("symlinks", () => {
	test("stat follows links, lstat and readlink do not", async () => {
		const { fs } = await makeVfs();
		fs.mkdirSync("/real/dir", { recursive: true });
		fs.writeFileSync("/real/dir/file.txt", "content");
		fs.symlinkSync("/real/dir", "/abs");
		fs.symlinkSync("../real/dir/file.txt", "/real/rel");
		fs.symlinkSync("dir", "/real/dirlink");
		assert.equal(fs.readFileSync("/abs/file.txt", "utf8"), "content");
		assert.equal(fs.readFileSync("/real/rel", "utf8"), "content");
		assert.equal(fs.readFileSync("/real/dirlink/file.txt", "utf8"), "content");
		assert.ok(fs.lstatSync("/abs").isSymbolicLink());
		assert.equal(fs.lstatSync("/abs").mode, 0o120777);
		assert.ok(fs.statSync("/abs").isDirectory());
		assert.equal(fs.readlinkSync("/real/rel"), "../real/dir/file.txt");
		assert.equal(await fs.promises.readlink("/abs"), "/real/dir");
		assert.equal(fs.realpathSync("/abs/file.txt"), "/real/dir/file.txt");
		assert.equal(fs.realpathSync.native("/real/dirlink/../rel"), "/real/dir/file.txt");
		assert.equal(await fs.promises.realpath("/real/dirlink"), "/real/dir");
		assert.throws(() => fs.symlinkSync("x", "/abs"), code("EEXIST"));
	});

	test("writes go through links to their targets", async () => {
		const { fs, vfs, root } = await makeVfs();
		fs.mkdirSync("/data");
		fs.symlinkSync("/data", "/alias");
		fs.writeFileSync("/alias/new.txt", "via link");
		fs.symlinkSync("/data/created-later", "/dangling");
		assert.equal(fs.existsSync("/dangling"), false);
		fs.writeFileSync("/dangling", "now exists");
		await vfs.flush();
		assert.equal(root.read("data/new.txt"), "via link");
		assert.equal(root.read("data/created-later"), "now exists");
		assert.equal(root.lookup("alias"), undefined, "symlinks only live in the sidecar");
	});

	test("detects loops", async () => {
		const { fs } = await makeVfs();
		fs.symlinkSync("/b", "/a");
		fs.symlinkSync("/a", "/b");
		assert.throws(() => fs.statSync("/a"), code("ELOOP"));
		assert.throws(() => fs.readFileSync("/a/x"), code("ELOOP"));
		assert.ok(fs.lstatSync("/a").isSymbolicLink());
	});

	test("persist across remounts and are dropped with their parent", async () => {
		const { fs, vfs, remount } = await makeVfs();
		fs.mkdirSync("/d");
		fs.writeFileSync("/d/t", "t");
		fs.symlinkSync("t", "/d/l");
		fs.symlinkSync("/d", "/top");
		await vfs.flush();
		const fresh = await remount();
		assert.equal(fresh.fs.readlinkSync("/d/l"), "t");
		assert.equal(fresh.fs.readFileSync("/top/l", "utf8"), "t");
		fresh.fs.rmSync("/d", { recursive: true });
		fresh.fs.renameSync("/top", "/moved");
		await fresh.flush();
		const third = await remount();
		assert.equal(third.fs.existsSync("/d/l"), false);
		assert.equal(third.fs.readlinkSync("/moved"), "/d");
		assert.equal(third.fs.existsSync("/top"), false);
	});
});

describe("metadata", () => {
	test("utimes accepts seconds and Dates and persists", async () => {
		const { fs, vfs, remount } = await makeVfs();
		fs.writeFileSync("/f", "x");
		fs.utimesSync("/f", 1_000_000, new Date(1_500_000_000_123));
		const stat = fs.statSync("/f");
		assert.equal(stat.atimeMs, 1_000_000_000);
		assert.equal(stat.mtimeMs, 1_500_000_000_123);
		await fs.promises.utimes("/f", "2000000", 2_000_000);
		assert.equal(fs.statSync("/f").mtimeMs, 2_000_000_000);
		fs.mkdirSync("/d");
		fs.utimesSync("/d", 5, 5);
		await vfs.flush();
		const fresh = await remount();
		assert.equal(fresh.fs.statSync("/f").mtimeMs, 2_000_000_000);
		assert.equal(fresh.fs.statSync("/d").mtimeMs, 5000);
	});

	test("futimes and lutimes", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/f", "x");
		fs.symlinkSync("/f", "/l");
		const fd = fs.openSync("/f", "r");
		fs.futimesSync(fd, 10, 20);
		fs.closeSync(fd);
		assert.equal(fs.statSync("/f").mtimeMs, 20_000);
		fs.lutimesSync("/l", 30, 40);
		assert.equal(fs.lstatSync("/l").mtimeMs, 40_000);
		assert.equal(fs.statSync("/l").mtimeMs, 20_000);
	});

	test("chmod persists; chown is accepted", async () => {
		const { fs, vfs, remount } = await makeVfs();
		fs.writeFileSync("/f", "x");
		fs.chmodSync("/f", "755");
		assert.equal(fs.statSync("/f").mode, 0o100755);
		await fs.promises.chmod("/f", 0o640);
		fs.chownSync("/f", 1234, 5678);
		assert.equal(fs.statSync("/f").uid, 1234);
		await vfs.flush();
		const fresh = await remount();
		assert.equal(fresh.fs.statSync("/f").mode, 0o100640);
	});

	test("birthtime survives content changes and remounts", async () => {
		const { fs, vfs, remount } = await makeVfs();
		fs.writeFileSync("/f", "v1");
		const birth = fs.statSync("/f").birthtimeMs;
		await tick(5);
		fs.writeFileSync("/f", "v2");
		const stat = fs.statSync("/f");
		assert.equal(stat.birthtimeMs, birth);
		assert.ok(stat.mtimeMs > birth);
		await vfs.flush();
		const fresh = await remount();
		const after = fresh.fs.statSync("/f");
		assert.equal(after.birthtimeMs, birth);
		assert.equal(after.mtimeMs, stat.mtimeMs);
	});

	test("uses File.lastModified when the sidecar is stale or missing", async () => {
		const root = createMemoryOpfs();
		const { fs, vfs, remount } = await makeVfs({ root });
		fs.writeFileSync("/f", "x");
		fs.utimesSync("/f", 1, 1);
		await vfs.flush();
		const file = root.lookup("f");
		assert.ok(file && "lastModified" in file);
		file.lastModified = Date.now() + 60_000;
		const fresh = await remount();
		assert.equal(fresh.fs.statSync("/f").mtimeMs, file.lastModified);
		root.put("external.txt", "e", 1_234_000);
		const third = await remount();
		assert.equal(third.fs.statSync("/external.txt").mtimeMs, 1_234_000);
		assert.equal(third.fs.statSync("/external.txt").birthtimeMs, 1_234_000);
	});

	test("ignores a corrupt sidecar", async () => {
		const root = createMemoryOpfs();
		const meta = createMemoryOpfs();
		root.put("a", "a", 42_000);
		meta.put("vfs-meta.json", "{not json");
		const { fs } = await makeVfs({ root, meta });
		assert.equal(fs.statSync("/a").mtimeMs, 42_000);
	});
});
