import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createMemoryOpfs } from "../helpers/memory-opfs.ts";
import { closeAll, makeVfs } from "../helpers/vfs.ts";

after(closeAll);

function code(expected: string): (error: unknown) => boolean {
	return (error) => {
		assert.equal((error as NodeJS.ErrnoException).code, expected, String(error));
		return true;
	};
}

describe("rename", () => {
	test("renames files and persists the result", async () => {
		const { fs, vfs, root, remount } = await makeVfs();
		fs.mkdirSync("/v");
		fs.writeFileSync("/v/a.md", "A");
		fs.renameSync("/v/a.md", "/v/b.md");
		assert.equal(fs.existsSync("/v/a.md"), false);
		assert.equal(fs.readFileSync("/v/b.md", "utf8"), "A");
		await fs.promises.rename("/v/b.md", "/c.md");
		assert.equal(root.read("c.md"), "A");
		assert.equal(root.lookup("v/b.md"), undefined);
		await vfs.flush();
		const fresh = await remount();
		assert.equal(fresh.fs.readFileSync("/c.md", "utf8"), "A");
		assert.deepEqual(fresh.fs.readdirSync("/v"), []);
	});

	for (const move of ["all", "files", "none"] as const) {
		test(`renames directories with contents (move: ${move})`, async () => {
			const root = createMemoryOpfs({ move });
			root.put("src/a.txt", "a");
			root.put("src/deep/b.txt", "b");
			const { fs, vfs, remount } = await makeVfs({ root });
			const before = fs.statSync("/src/deep/b.txt").ino;
			fs.renameSync("/src", "/dst");
			assert.equal(fs.statSync("/dst/deep/b.txt").ino, before);
			assert.equal(fs.readFileSync("/dst/a.txt", "utf8"), "a");
			await vfs.flush();
			assert.deepEqual(root.snapshot(), {
				"/dst/": "",
				"/dst/a.txt": "a",
				"/dst/deep/": "",
				"/dst/deep/b.txt": "b",
			});
			const fresh = await remount();
			assert.equal(fresh.fs.readFileSync("/dst/deep/b.txt", "utf8"), "b");
		});
	}

	test("follows POSIX rules for existing destinations", async () => {
		const { fs, vfs, root } = await makeVfs();
		fs.writeFileSync("/f1", "one");
		fs.writeFileSync("/f2", "two");
		fs.mkdirSync("/empty");
		fs.mkdirSync("/full");
		fs.writeFileSync("/full/x", "");
		fs.mkdirSync("/d");
		fs.renameSync("/f1", "/f2");
		assert.equal(fs.readFileSync("/f2", "utf8"), "one");
		assert.equal(fs.existsSync("/f1"), false);
		assert.throws(() => fs.renameSync("/f2", "/empty"), code("EISDIR"));
		assert.throws(() => fs.renameSync("/d", "/f2"), code("ENOTDIR"));
		assert.throws(() => fs.renameSync("/d", "/full"), code("ENOTEMPTY"));
		fs.renameSync("/d", "/empty");
		assert.equal(fs.existsSync("/d"), false);
		fs.renameSync("/f2", "/f2");
		assert.equal(fs.readFileSync("/f2", "utf8"), "one");
		assert.throws(() => fs.renameSync("/f2", "/missing/x"), code("ENOENT"));
		await vfs.flush();
		assert.deepEqual(root.snapshot(), { "/empty/": "", "/f2": "one", "/full/": "", "/full/x": "" });
	});

	test("keeps open file descriptors working", async () => {
		const { fs, vfs, root } = await makeVfs();
		const fd = fs.openSync("/a", "w");
		fs.writeSync(fd, "1");
		fs.renameSync("/a", "/b");
		fs.writeSync(fd, "2");
		fs.closeSync(fd);
		await vfs.flush();
		assert.equal(fs.readFileSync("/b", "utf8"), "12");
		assert.deepEqual(root.snapshot(), { "/b": "12" });
	});
});

describe("remove", () => {
	test("rm recursive, force and rmdir", async () => {
		const { fs, vfs, root } = await makeVfs();
		fs.mkdirSync("/a/b/c", { recursive: true });
		fs.writeFileSync("/a/b/c/f", "f");
		fs.writeFileSync("/a/g", "g");
		fs.rmSync("/a/g");
		assert.equal(fs.existsSync("/a/g"), false);
		fs.rmSync("/a", { recursive: true });
		assert.equal(fs.existsSync("/a"), false);
		fs.rmSync("/a", { force: true });
		fs.rmSync("/nope/deeper", { force: true, recursive: true });
		await fs.promises.mkdir("/e");
		await fs.promises.rmdir("/e");
		fs.mkdirSync("/r/s", { recursive: true });
		fs.rmdirSync("/r", { recursive: true });
		await fs.promises.writeFile("/u", "");
		await fs.promises.unlink("/u");
		await fs.promises.mkdir("/z/y", { recursive: true });
		await fs.promises.rm("/z", { recursive: true });
		await vfs.flush();
		assert.deepEqual(root.snapshot(), {});
	});

	test("unlink removes symlinks, not their targets", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/target", "t");
		fs.symlinkSync("/target", "/link");
		fs.unlinkSync("/link");
		assert.equal(fs.readFileSync("/target", "utf8"), "t");
		fs.mkdirSync("/dir");
		fs.writeFileSync("/dir/x", "x");
		fs.symlinkSync("/dir", "/dirlink");
		fs.rmSync("/dirlink", { recursive: true });
		assert.equal(fs.readFileSync("/dir/x", "utf8"), "x");
	});
});

describe("copy", () => {
	test("copyFile with COPYFILE_EXCL", async () => {
		const { fs, vfs, root } = await makeVfs();
		fs.writeFileSync("/src", "data");
		fs.chmodSync("/src", 0o600);
		fs.copyFileSync("/src", "/dst");
		assert.equal(fs.readFileSync("/dst", "utf8"), "data");
		assert.equal(fs.statSync("/dst").mode, 0o100600);
		assert.notEqual(fs.statSync("/dst").ino, fs.statSync("/src").ino);
		assert.throws(() => fs.copyFileSync("/src", "/dst", fs.constants.COPYFILE_EXCL), code("EEXIST"));
		fs.writeFileSync("/src", "new");
		await fs.promises.copyFile("/src", "/dst");
		assert.equal(fs.readFileSync("/dst", "utf8"), "new");
		assert.throws(() => fs.copyFileSync("/missing", "/x"), code("ENOENT"));
		assert.throws(() => fs.copyFileSync("/tmp", "/x"), code("EISDIR"));
		await vfs.flush();
		assert.equal(root.read("dst"), "new");
	});

	test("cp copies trees with filter, force and errorOnExist", async () => {
		const { fs, vfs, root } = await makeVfs();
		fs.mkdirSync("/src/sub", { recursive: true });
		fs.writeFileSync("/src/a.txt", "a");
		fs.writeFileSync("/src/skip.log", "log");
		fs.writeFileSync("/src/sub/b.txt", "b");
		fs.symlinkSync("a.txt", "/src/link");
		assert.throws(() => fs.cpSync("/src", "/dst"), code("ERR_FS_EISDIR"));
		fs.cpSync("/src", "/dst", { recursive: true, filter: (source: string) => !source.endsWith(".log") });
		assert.deepEqual(fs.readdirSync("/dst", { recursive: true }).sort(), ["a.txt", "link", "sub", "sub/b.txt"]);
		assert.equal(fs.readlinkSync("/dst/link"), "/src/a.txt");
		fs.writeFileSync("/src/a.txt", "changed");
		fs.cpSync("/src", "/dst", { recursive: true, force: false });
		assert.equal(fs.readFileSync("/dst/a.txt", "utf8"), "a");
		assert.throws(
			() => fs.cpSync("/src/a.txt", "/dst/a.txt", { force: false, errorOnExist: true }),
			code("ERR_FS_CP_EEXIST"),
		);
		await fs.promises.cp("/src", "/async/copy", {
			recursive: true,
			filter: async (source: string) => !source.endsWith(".log"),
		});
		assert.equal(fs.readFileSync("/async/copy/a.txt", "utf8"), "changed");
		assert.equal(fs.existsSync("/async/copy/skip.log"), false);
		assert.throws(() => fs.cpSync("/src", "/src/inner", { recursive: true }), code("ERR_FS_CP_EINVAL"));
		await new Promise<void>((resolve, reject) =>
			fs.cp("/src/a.txt", "/cb.txt", (error: unknown) => (error ? reject(error) : resolve())),
		);
		assert.equal(fs.readFileSync("/cb.txt", "utf8"), "changed");
		await vfs.flush();
		assert.equal(root.read("dst/sub/b.txt"), "b");
	});

	test("link creates an independent copy", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/orig", "o");
		fs.linkSync("/orig", "/copy");
		assert.equal(fs.readFileSync("/copy", "utf8"), "o");
		assert.throws(() => fs.linkSync("/orig", "/copy"), code("EEXIST"));
		assert.throws(() => fs.linkSync("/tmp", "/tmplink"), code("EPERM"));
	});
});
