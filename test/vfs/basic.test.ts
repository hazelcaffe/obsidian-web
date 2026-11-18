import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { after, describe, test } from "node:test";
import { createMemoryOpfs } from "../helpers/memory-opfs.ts";
import { closeAll, makeVfs, tick } from "../helpers/vfs.ts";

after(closeAll);

function code(expected: string, syscall?: string): (error: unknown) => boolean {
	return (error) => {
		assert.ok(error instanceof Error, "expected an Error");
		assert.equal((error as NodeJS.ErrnoException).code, expected, String(error));
		if (syscall) {
			assert.equal((error as NodeJS.ErrnoException).syscall, syscall);
		}
		return true;
	};
}

describe("mount", () => {
	test("builds the tree from a pre-populated OPFS directory", async () => {
		const root = createMemoryOpfs();
		root.put("vault/note.md", "# Hello", 1_700_000_000_000);
		root.put("vault/sub/deep.md", "deep");
		root.mkdirp("vault/empty");
		root.put("big.bin", new Uint8Array(2048));
		const { fs, vfs } = await makeVfs({ root, eagerLoadLimit: 1024 });

		assert.deepEqual(fs.readdirSync("/vault").sort(), ["empty", "note.md", "sub"]);
		const stat = fs.statSync("/vault/note.md");
		assert.ok(stat.isFile());
		assert.equal(stat.size, 7);
		assert.equal(stat.mtimeMs, 1_700_000_000_000);
		assert.equal(stat.mtime.getTime(), 1_700_000_000_000);
		assert.ok(fs.statSync("/vault/empty").isDirectory());
		assert.equal(fs.readFileSync("/vault/sub/deep.md", "utf8"), "deep");
		assert.equal(vfs.isLoaded("/vault/note.md"), true);
		assert.equal(vfs.isLoaded("/big.bin"), false);
		assert.equal(fs.statSync("/big.bin").size, 2048);
		for (const dir of ["/tmp", "/proc", "/dev"]) {
			assert.ok(fs.statSync(dir).isDirectory(), dir);
		}
	});

	test("skips the sidecar when metaDir is the root itself", async () => {
		const root = createMemoryOpfs();
		root.put("vfs-meta.json", "{}");
		root.put("a.txt", "a");
		const { fs } = await makeVfs({ root, meta: root });
		assert.equal(fs.existsSync("/vfs-meta.json"), false);
		assert.equal(fs.existsSync("/a.txt"), true);
	});
});

describe("files", () => {
	test("readFile returns Buffers unless an encoding is given", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/f.txt", "héllo");
		const buffer = fs.readFileSync("/f.txt");
		assert.ok(Buffer.isBuffer(buffer));
		assert.equal(buffer.toString("utf8"), "héllo");
		assert.equal(fs.readFileSync("/f.txt", "utf8"), "héllo");
		assert.equal(fs.readFileSync("/f.txt", { encoding: "utf-8" }), "héllo");
		assert.equal(fs.readFileSync("/f.txt", "base64"), Buffer.from("héllo").toString("base64"));
		assert.equal(fs.readFileSync("/f.txt", "hex"), Buffer.from("héllo").toString("hex"));
		assert.equal(fs.readFileSync("/f.txt", "latin1"), Buffer.from("héllo").toString("latin1"));
		const promised = await fs.promises.readFile("/f.txt");
		assert.ok(Buffer.isBuffer(promised));
		buffer[0] = 0;
		assert.equal(fs.readFileSync("/f.txt", "utf8"), "héllo", "results are copies");
	});

	test("preserves a UTF-8 BOM like Node", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/bom.txt", "\uFEFFx");
		assert.equal(fs.readFileSync("/bom.txt", "utf8"), "\uFEFFx");
	});

	test("writeFile accepts strings with encodings, typed arrays and DataViews", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/a", "aGk=", "base64");
		assert.equal(fs.readFileSync("/a", "utf8"), "hi");
		fs.writeFileSync("/b", new Uint16Array([0x6968]));
		assert.equal(fs.readFileSync("/b", "utf8"), "hi");
		fs.writeFileSync("/c", new DataView(new Uint8Array([104, 105]).buffer));
		assert.equal(fs.readFileSync("/c", "utf8"), "hi");
		await fs.promises.writeFile("/d", ["a", Buffer.from("b"), "c"]);
		assert.equal(fs.readFileSync("/d", "utf8"), "abc");
		await fs.promises.writeFile(
			"/e",
			(async function* () {
				yield "x";
				yield new Uint8Array([121]);
			})(),
		);
		assert.equal(fs.readFileSync("/e", "utf8"), "xy");
		const source = Buffer.from("mutable");
		fs.writeFileSync("/f", source);
		source[0] = 77;
		assert.equal(fs.readFileSync("/f", "utf8"), "mutable", "data is copied");
		assert.throws(() => fs.writeFileSync("/g", 42 as unknown as string), code("ERR_INVALID_ARG_TYPE"));
	});

	test("writeFile flags", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/f", "one");
		assert.throws(() => fs.writeFileSync("/f", "two", { flag: "wx" }), code("EEXIST", "open"));
		fs.writeFileSync("/f", "+", { flag: "a" });
		assert.equal(fs.readFileSync("/f", "utf8"), "one+");
		fs.writeFileSync("/f", "O", { flag: "r+" });
		assert.equal(fs.readFileSync("/f", "utf8"), "One+");
		assert.throws(() => fs.writeFileSync("/missing", "x", { flag: "r+" }), code("ENOENT"));
		assert.throws(() => fs.writeFileSync("/nodir/x", "x"), code("ENOENT", "open"));
		assert.throws(() => fs.writeFileSync("/f/x", "x"), code("ENOTDIR"));
		assert.throws(() => fs.writeFileSync("/tmp", "x"), code("EISDIR"));
		await assert.rejects(fs.promises.writeFile("/f", "x", { flag: "wx" }), code("EEXIST"));
		await fs.promises.writeFile("/new", "n", { flag: "wx", mode: 0o600 });
		assert.equal(fs.statSync("/new").mode, 0o100600);
	});

	test("readFile honours an AbortSignal", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/f", "x");
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(fs.promises.readFile("/f", { signal: controller.signal }), (error: unknown) => {
			assert.equal((error as Error).name, "AbortError");
			return true;
		});
	});

	test("appendFile creates and appends", async () => {
		const { fs } = await makeVfs();
		fs.appendFileSync("/log", "a");
		fs.appendFileSync("/log", Buffer.from("b"));
		await fs.promises.appendFile("/log", "c");
		await new Promise<void>((resolve, reject) =>
			fs.appendFile("/log", "d", (error: unknown) => (error ? reject(error) : resolve())),
		);
		assert.equal(fs.readFileSync("/log", "utf8"), "abcd");
	});

	test("truncate shrinks and zero-extends", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/t", "hello world");
		fs.truncateSync("/t", 5);
		assert.equal(fs.readFileSync("/t", "utf8"), "hello");
		fs.truncateSync("/t", 7);
		assert.deepEqual([...fs.readFileSync("/t")], [104, 101, 108, 108, 111, 0, 0]);
		await fs.promises.truncate("/t");
		assert.equal(fs.statSync("/t").size, 0);
		assert.throws(() => fs.truncateSync("/tmp"), code("EISDIR"));
	});

	test("access, exists and permission bits", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/ro", "x");
		fs.chmodSync("/ro", 0o444);
		assert.equal(fs.existsSync("/ro"), true);
		assert.equal(fs.existsSync("/nope"), false);
		assert.equal(fs.existsSync(undefined as unknown as string), false);
		fs.accessSync("/ro", fs.constants.R_OK);
		assert.throws(() => fs.accessSync("/ro", fs.W_OK), code("EACCES", "access"));
		assert.throws(() => fs.writeFileSync("/ro", "y"), code("EACCES"));
		assert.throws(() => fs.accessSync("/nope"), code("ENOENT", "access"));
		await assert.rejects(fs.promises.access("/nope"), code("ENOENT"));
		const exists = await new Promise<boolean>((resolve) => fs.exists("/ro", resolve));
		assert.equal(exists, true);
	});
});

describe("directories", () => {
	test("mkdir recursive returns the first created directory", async () => {
		const { fs } = await makeVfs();
		assert.equal(fs.mkdirSync("/a/b/c", { recursive: true }), "/a");
		assert.equal(fs.mkdirSync("/a/b/c", { recursive: true }), undefined);
		assert.equal(fs.mkdirSync("/a/b/d/e", { recursive: true }), "/a/b/d");
		assert.equal(fs.mkdirSync("/plain"), undefined);
		assert.throws(() => fs.mkdirSync("/plain"), code("EEXIST", "mkdir"));
		assert.throws(() => fs.mkdirSync("/x/y"), code("ENOENT", "mkdir"));
		fs.writeFileSync("/file", "");
		assert.throws(() => fs.mkdirSync("/file/sub", { recursive: true }), code("ENOTDIR"));
		assert.throws(() => fs.mkdirSync("/file", { recursive: true }), code("EEXIST"));
		assert.equal(await fs.promises.mkdir("/p/q", { recursive: true }), "/p");
		fs.mkdirSync("/m", 0o700);
		assert.equal(fs.statSync("/m").mode, 0o40700);
	});

	test("readdir with file types and recursion", async () => {
		const { fs } = await makeVfs();
		fs.mkdirSync("/d/sub/deeper", { recursive: true });
		fs.writeFileSync("/d/a.txt", "a");
		fs.writeFileSync("/d/sub/b.txt", "b");
		fs.symlinkSync("a.txt", "/d/link");
		assert.deepEqual(fs.readdirSync("/d").sort(), ["a.txt", "link", "sub"]);
		assert.deepEqual(fs.readdirSync("/d", { recursive: true }).sort(), [
			"a.txt",
			"link",
			"sub",
			"sub/b.txt",
			"sub/deeper",
		]);
		const dirents = fs.readdirSync("/d", { withFileTypes: true });
		const byName = new Map(dirents.map((dirent) => [dirent.name, dirent]));
		assert.ok(byName.get("a.txt")?.isFile());
		assert.ok(byName.get("sub")?.isDirectory());
		assert.ok(byName.get("link")?.isSymbolicLink());
		assert.equal(byName.get("a.txt")?.parentPath, "/d");
		assert.equal(byName.get("a.txt")?.path, "/d");
		assert.ok(dirents[0] instanceof fs.Dirent);
		const recursive = fs.readdirSync("/d/", { withFileTypes: true, recursive: true });
		const b = recursive.find((dirent) => dirent.name === "b.txt");
		assert.equal(b?.parentPath, "/d/sub");
		const buffers = fs.readdirSync("/d", { encoding: "buffer" });
		assert.ok(buffers.every((name) => Buffer.isBuffer(name)));
		assert.deepEqual((await fs.promises.readdir("/d")).sort(), ["a.txt", "link", "sub"]);
		assert.throws(() => fs.readdirSync("/d/a.txt"), code("ENOTDIR", "scandir"));
		assert.throws(() => fs.readdirSync("/nope"), code("ENOENT", "scandir"));
	});

	test("opendir iterates entries", async () => {
		const { fs } = await makeVfs();
		fs.mkdirSync("/dir");
		fs.writeFileSync("/dir/1", "");
		fs.writeFileSync("/dir/2", "");
		const dir = await fs.promises.opendir("/dir");
		const names: string[] = [];
		for await (const entry of dir) {
			names.push(String(entry.name));
		}
		assert.deepEqual(names.sort(), ["1", "2"]);
		const sync = fs.opendirSync("/dir");
		assert.equal(sync.path, "/dir");
		assert.ok(sync.readSync());
		assert.ok(await sync.read());
		assert.equal(sync.readSync(), null);
		sync.closeSync();
		assert.throws(() => sync.readSync(), code("ERR_DIR_CLOSED"));
	});
});

describe("stats", () => {
	test("Node-like Stats objects", async () => {
		const { fs } = await makeVfs({ uid: 501, gid: 20 });
		const before = Date.now();
		fs.mkdirSync("/d");
		fs.mkdirSync("/d/child");
		fs.writeFileSync("/d/f", "12345");
		const file = fs.statSync("/d/f");
		assert.ok(file instanceof fs.Stats);
		assert.equal(file.mode, 0o100644);
		assert.equal(file.size, 5);
		assert.equal(file.nlink, 1);
		assert.equal(file.uid, 501);
		assert.equal(file.gid, 20);
		assert.equal(file.blksize, 4096);
		assert.equal(file.blocks, 8);
		assert.ok(file.mtimeMs >= before);
		assert.ok(file.mtime instanceof Date);
		assert.ok(file.birthtime instanceof Date);
		assert.ok(file.isFile() && !file.isDirectory() && !file.isSymbolicLink());
		assert.ok(!file.isFIFO() && !file.isSocket() && !file.isBlockDevice() && !file.isCharacterDevice());
		const dir = fs.statSync("/d");
		assert.equal(dir.mode, 0o40755);
		assert.equal(dir.size, 4096);
		assert.equal(dir.nlink, 3);
		assert.notEqual(file.ino, dir.ino);
		assert.equal(fs.statSync("/nope", { throwIfNoEntry: false }), undefined);
		assert.equal(fs.lstatSync("/nope", { throwIfNoEntry: false }), undefined);
		const statfs = fs.statfsSync("/");
		assert.ok(statfs.bavail > 0 && statfs.bsize > 0);
	});

	test("directory mtime changes when entries are added", async () => {
		const { fs } = await makeVfs();
		fs.mkdirSync("/d");
		const before = fs.statSync("/d").mtimeMs;
		await tick(2);
		fs.writeFileSync("/d/x", "");
		assert.ok(fs.statSync("/d").mtimeMs > before);
	});
});

describe("paths", () => {
	test("accepts relative, Buffer and file: URL paths", async () => {
		let cwd = "/work";
		const { fs } = await makeVfs({ cwd: () => cwd });
		fs.mkdirSync("/work/sub", { recursive: true });
		fs.writeFileSync("rel.txt", "r");
		assert.equal(fs.readFileSync("/work/rel.txt", "utf8"), "r");
		assert.equal(fs.readFileSync("./sub/../rel.txt", "utf8"), "r");
		assert.equal(fs.readFileSync(Buffer.from("/work/rel.txt"), "utf8"), "r");
		assert.equal(fs.readFileSync(new URL("file:///work/rel.txt"), "utf8"), "r");
		assert.equal(fs.readFileSync("//work///./rel.txt", "utf8"), "r");
		cwd = "/work/sub";
		assert.equal(fs.readFileSync("../rel.txt", "utf8"), "r");
		assert.throws(() => fs.readFileSync(new URL("https://example.com/x")), code("ERR_INVALID_URL_SCHEME"));
		assert.throws(() => fs.readFileSync("/a\u0000b"), code("ERR_INVALID_ARG_VALUE"));
		assert.throws(() => fs.readFileSync(42 as unknown as string), code("EBADF"));
		assert.throws(() => fs.statSync(""), code("ENOENT"));
		assert.throws(() => fs.statSync("/work/rel.txt/"), code("ENOTDIR"));
	});
});

describe("errors", () => {
	test("Node-style errors", async () => {
		const { fs } = await makeVfs();
		try {
			fs.readFileSync("/nope");
			assert.fail("should throw");
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			assert.equal(err.message, "ENOENT: no such file or directory, open '/nope'");
			assert.equal(err.code, "ENOENT");
			assert.equal(err.errno, -2);
			assert.equal(err.syscall, "open");
			assert.equal(err.path, "/nope");
		}
		try {
			fs.renameSync("/a", "/b");
			assert.fail("should throw");
		} catch (error) {
			const err = error as NodeJS.ErrnoException & { dest?: string };
			assert.equal(err.message, "ENOENT: no such file or directory, rename '/a' -> '/b'");
			assert.equal(err.dest, "/b");
		}
		fs.mkdirSync("/d");
		fs.writeFileSync("/d/f", "");
		assert.throws(() => fs.readFileSync("/d"), code("EISDIR", "read"));
		assert.throws(() => fs.rmdirSync("/d"), code("ENOTEMPTY", "rmdir"));
		assert.throws(() => fs.rmdirSync("/d/f"), code("ENOTDIR", "rmdir"));
		assert.throws(() => fs.unlinkSync("/d"), code("EISDIR", "unlink"));
		assert.throws(() => fs.rmSync("/d"), code("ERR_FS_EISDIR"));
		assert.throws(() => fs.rmSync("/nope"), code("ENOENT", "lstat"));
		assert.throws(() => fs.closeSync(999), code("EBADF", "close"));
		assert.throws(() => fs.readlinkSync("/d/f"), code("EINVAL", "readlink"));
		assert.throws(() => fs.renameSync("/", "/x"), code("EBUSY"));
		assert.throws(() => fs.renameSync("/d", "/d/inside"), code("EINVAL"));
		assert.throws(() => fs.rmdirSync("/"), code("EBUSY"));
		assert.throws(() => fs.readFileSync("/d/f/x"), code("ENOTDIR"));
		await assert.rejects(fs.promises.readFile("/nope"), code("ENOENT", "open"));
		await assert.rejects(fs.promises.stat("/nope"), code("ENOENT", "stat"));
		await assert.rejects(fs.promises.lstat("/nope"), code("ENOENT", "lstat"));
		await assert.rejects(fs.promises.utimes("/nope", 1, 1), code("ENOENT", "utime"));
	});

	test("invalid arguments throw TypeErrors", async () => {
		const { fs } = await makeVfs();
		assert.throws(() => fs.openSync("/x", "nope"), code("ERR_INVALID_ARG_VALUE"));
		assert.throws(() => fs.readFileSync("/x", "nope" as "utf8"), code("ERR_INVALID_ARG_VALUE"));
		assert.throws(() => fs.readFile("/x"), code("ERR_INVALID_ARG_TYPE"));
		assert.throws(() => fs.readSync(1, "nope" as unknown as Uint8Array), code("ERR_INVALID_ARG_TYPE"));
	});
});

describe("callbacks", () => {
	test("call back asynchronously with (err, result)", async () => {
		const { fs } = await makeVfs();
		let sync = true;
		const result = await new Promise<unknown[]>((resolve) => {
			fs.writeFile("/cb.txt", "data", (...args: unknown[]) => {
				assert.equal(sync, false);
				resolve(args);
			});
			sync = false;
		});
		assert.deepEqual(result, [null]);
		const [error, data] = await new Promise<unknown[]>((resolve) =>
			fs.readFile("/cb.txt", "utf8", (...args: unknown[]) => resolve(args)),
		);
		assert.equal(error, null);
		assert.equal(data, "data");
		const [missing] = await new Promise<unknown[]>((resolve) =>
			fs.stat("/missing", (...args: unknown[]) => resolve(args)),
		);
		assert.equal((missing as NodeJS.ErrnoException).code, "ENOENT");
		const [, stats] = await new Promise<unknown[]>((resolve) =>
			fs.stat("/cb.txt", (...args: unknown[]) => resolve(args)),
		);
		assert.ok(stats instanceof fs.Stats);
		const [, created] = await new Promise<unknown[]>((resolve) =>
			fs.mkdir("/x/y", { recursive: true }, (...args: unknown[]) => resolve(args)),
		);
		assert.equal(created, "/x");
		const [, entries] = await new Promise<unknown[]>((resolve) =>
			fs.readdir("/x", (...args: unknown[]) => resolve(args)),
		);
		assert.deepEqual(entries, ["y"]);
		const [, real] = await new Promise<unknown[]>((resolve) =>
			fs.realpath.native("/x/./y", (...args: unknown[]) => resolve(args)),
		);
		assert.equal(real, "/x/y");
	});

	test("exists passes a single boolean", async () => {
		const { fs } = await makeVfs();
		const args = await new Promise<unknown[]>((resolve) =>
			fs.exists("/nope", (...rest: unknown[]) => resolve(rest)),
		);
		assert.deepEqual(args, [false]);
	});
});

describe("module surface", () => {
	test("exposes constants and classes", async () => {
		const { fs } = await makeVfs();
		assert.equal(fs.F_OK, 0);
		assert.equal(fs.R_OK, 4);
		assert.equal(fs.constants.O_CREAT, 64);
		assert.equal(fs.constants.COPYFILE_EXCL, 1);
		assert.equal(fs.constants.S_IFLNK, 0o120000);
		assert.equal(fs.promises.constants, fs.constants);
		assert.equal(typeof fs.realpathSync.native, "function");
		assert.equal(typeof fs.ReadStream, "function");
		assert.equal(typeof fs.WriteStream, "function");
		assert.equal(typeof fs.Dir, "function");
		assert.equal(typeof fs.promises.watch, "function");
	});
});
