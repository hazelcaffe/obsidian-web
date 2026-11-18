import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { after, describe, test } from "node:test";
import { closeAll, makeVfs } from "../helpers/vfs.ts";

after(closeAll);

function code(expected: string): (error: unknown) => boolean {
	return (error) => {
		assert.equal((error as NodeJS.ErrnoException).code, expected, String(error));
		return true;
	};
}

function collect(stream: NodeJS.ReadableStream): Promise<string> {
	return new Promise((resolve, reject) => {
		let text = "";
		stream.on("data", (chunk: Buffer | string) => {
			text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		});
		stream.on("end", () => resolve(text));
		stream.on("error", reject);
	});
}

describe("file descriptors", () => {
	test("read and write with positions", async () => {
		const { fs, vfs, root } = await makeVfs();
		const fd = fs.openSync("/f", "w+");
		assert.ok(fd >= 3);
		assert.equal(fs.writeSync(fd, "hello"), 5);
		assert.equal(fs.writeSync(fd, Buffer.from(" world")), 6);
		assert.equal(fs.writeSync(fd, "J", 0), 1);
		const buffer = Buffer.alloc(5);
		assert.equal(fs.readSync(fd, buffer, 0, 5, 0), 5);
		assert.equal(buffer.toString(), "Jello");
		assert.equal(fs.readSync(fd, buffer, { position: 6, length: 3 }), 3);
		assert.equal(buffer.toString("utf8", 0, 3), "wor");
		assert.equal(fs.readSync(fd, buffer, 0, 5, 100), 0);
		assert.equal(fs.fstatSync(fd).size, 11);
		fs.ftruncateSync(fd, 4);
		assert.equal(fs.fstatSync(fd).size, 4);
		fs.writeSync(fd, Buffer.from("XXabcYY"), 2, 3, 10);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		assert.throws(() => fs.closeSync(fd), code("EBADF"));
		assert.throws(() => fs.readSync(fd, buffer), code("EBADF"));
		const contents = fs.readFileSync("/f");
		assert.equal(contents.byteLength, 13);
		assert.equal(contents.subarray(0, 4).toString(), "Jell");
		assert.equal(contents.subarray(10).toString(), "abc");
		await vfs.flush();
		assert.equal(root.read("f")?.length, 13);
	});

	test("open flags", async () => {
		const { fs } = await makeVfs();
		assert.throws(() => fs.openSync("/missing", "r"), code("ENOENT"));
		fs.writeFileSync("/f", "abc");
		assert.throws(() => fs.openSync("/f", "wx"), code("EEXIST"));
		const ro = fs.openSync("/f", "r");
		assert.throws(() => fs.writeSync(ro, "x"), code("EBADF"));
		fs.closeSync(ro);
		const wo = fs.openSync("/f", "a");
		assert.throws(() => fs.readSync(wo, Buffer.alloc(1)), code("EBADF"));
		fs.writeSync(wo, "d", 0);
		fs.closeSync(wo);
		assert.equal(fs.readFileSync("/f", "utf8"), "abcd", "append ignores the position");
		const rw = fs.openSync("/f", "r+");
		fs.writeSync(rw, "X");
		fs.closeSync(rw);
		assert.equal(fs.readFileSync("/f", "utf8"), "Xbcd");
		const numeric = fs.openSync("/n", fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_EXCL, 0o600);
		fs.closeSync(numeric);
		assert.equal(fs.statSync("/n").mode, 0o100600);
		fs.openSync("/f", "w");
		assert.equal(fs.statSync("/f").size, 0);
		assert.throws(() => fs.openSync("/tmp", "w"), code("EISDIR"));
		const dirFd = fs.openSync("/tmp", "r");
		assert.throws(() => fs.readSync(dirFd, Buffer.alloc(1)), code("EISDIR"));
		fs.symlinkSync("/f", "/l");
		assert.throws(() => fs.openSync("/l", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), code("ELOOP"));
	});

	test("readFile/writeFile on file descriptors use the current position", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/f", "0123456789");
		const fd = fs.openSync("/f", "r+");
		fs.readSync(fd, Buffer.alloc(4));
		assert.equal(fs.readFileSync(fd, "utf8"), "456789");
		fs.closeSync(fd);
	});

	test("readv and writev", async () => {
		const { fs } = await makeVfs();
		const fd = fs.openSync("/v", "w+");
		assert.equal(fs.writevSync(fd, [Buffer.from("ab"), Buffer.from("cd")]), 4);
		const a = Buffer.alloc(1);
		const b = Buffer.alloc(5);
		assert.equal(fs.readvSync(fd, [a, b], 0), 4);
		assert.equal(a.toString() + b.toString("utf8", 0, 3), "abcd");
		const [error, bytes] = await new Promise<unknown[]>((resolve) =>
			fs.writev(fd, [Buffer.from("ef")], (...args: unknown[]) => resolve(args)),
		);
		assert.equal(error, null);
		assert.equal(bytes, 2);
		fs.closeSync(fd);
		assert.equal(fs.readFileSync("/v", "utf8"), "abcdef");
	});

	test("callback read and write signatures", async () => {
		const { fs } = await makeVfs();
		const fd = await new Promise<number>((resolve, reject) =>
			fs.open("/cb", "w+", (error: unknown, value: unknown) =>
				error ? reject(error) : resolve(value as number),
			),
		);
		const written = await new Promise<unknown[]>((resolve) =>
			fs.write(fd, "text", (...args: unknown[]) => resolve(args)),
		);
		assert.deepEqual(written, [null, 4, "text"]);
		const target = Buffer.alloc(4);
		const read = await new Promise<unknown[]>((resolve) =>
			fs.read(fd, target, 0, 4, 0, (...args: unknown[]) => resolve(args)),
		);
		assert.equal(read[0], null);
		assert.equal(read[1], 4);
		assert.equal(read[2], target);
		assert.equal(target.toString(), "text");
		const optionsRead = await new Promise<unknown[]>((resolve) =>
			fs.read(fd, { buffer: Buffer.alloc(2), position: 2 }, (...args: unknown[]) => resolve(args)),
		);
		assert.equal((optionsRead[2] as Buffer).toString(), "xt");
		await new Promise<void>((resolve, reject) =>
			fs.close(fd, (error: unknown) => (error ? reject(error) : resolve())),
		);
	});
});

describe("FileHandle", () => {
	test("promise-based handle operations", async () => {
		const { fs, root } = await makeVfs();
		const handle = await fs.promises.open("/h", "w+");
		assert.equal(typeof handle.fd, "number");
		const { bytesWritten } = await handle.write("hello");
		assert.equal(bytesWritten, 5);
		await handle.write(Buffer.from("!!"), 0, 2, 5);
		const { bytesRead, buffer } = await handle.read(Buffer.alloc(7), 0, 7, 0);
		assert.equal(bytesRead, 7);
		assert.equal(Buffer.from(buffer.buffer, buffer.byteOffset, bytesRead).toString(), "hello!!");
		assert.equal((await handle.stat()).size, 7);
		await handle.truncate(5);
		await handle.utimes(100, 200);
		assert.equal((await handle.stat()).mtimeMs, 200_000);
		await handle.sync();
		assert.equal(root.read("h"), "hello");
		await handle.close();
		assert.equal(handle.fd, -1);
		await assert.rejects(handle.stat(), code("EBADF"));
		assert.equal(typeof Reflect.get(handle, Symbol.asyncDispose), "function");

		const reader = await fs.promises.open("/h");
		assert.equal(await reader.readFile("utf8"), "hello");
		await reader.close();

		const writer = await fs.promises.open("/w", "w");
		await writer.writeFile("from handle");
		await writer.appendFile(" + more");
		await writer.close();
		assert.equal(await fs.promises.readFile("/w", "utf8"), "from handle + more");

		const viaHandle = await fs.promises.open("/w", "r");
		assert.equal(await fs.promises.readFile(viaHandle, "utf8"), "from handle + more");
		await viaHandle.close();
		const lineHandle = await fs.promises.open("/w", "r");
		const lines: string[] = [];
		for await (const line of lineHandle.readLines()) {
			lines.push(line);
		}
		assert.deepEqual(lines, ["from handle + more"]);
		await lineHandle.close();
	});
});

describe("streams", () => {
	test("write then read with start, end, encoding and highWaterMark", async () => {
		const { fs, vfs, root } = await makeVfs();
		const writer = fs.createWriteStream("/s.txt");
		await new Promise<void>((resolve, reject) => {
			writer.on("error", reject);
			writer.on("close", () => resolve());
			writer.write("hello ");
			writer.write(Buffer.from("stream "));
			writer.end("world");
		});
		assert.equal(writer.bytesWritten, 18);
		assert.equal(fs.readFileSync("/s.txt", "utf8"), "hello stream world");
		assert.equal(
			await collect(fs.createReadStream("/s.txt", { encoding: "utf8", highWaterMark: 4 })),
			"hello stream world",
		);
		assert.equal(await collect(fs.createReadStream("/s.txt", { start: 6, end: 11 })), "stream");
		assert.equal(await collect(fs.createReadStream("/s.txt", { start: 13 })), "world");
		const constructed = new fs.ReadStream("/s.txt", "utf8");
		assert.ok(constructed instanceof fs.ReadStream);
		assert.ok(fs.createWriteStream("/other.txt") instanceof fs.WriteStream);
		assert.equal(await collect(constructed), "hello stream world");
		await vfs.flush();
		assert.equal(root.read("s.txt"), "hello stream world");
	});

	test("append flag, start position and events", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/a.txt", "base");
		const appender = fs.createWriteStream("/a.txt", { flags: "a" });
		const events: string[] = [];
		appender.on("open", () => events.push("open"));
		appender.on("ready", () => events.push("ready"));
		await new Promise<void>((resolve) => appender.end("+tail", () => resolve()));
		await new Promise<void>((resolve) => appender.close(() => resolve()));
		assert.deepEqual(events, ["open", "ready"]);
		assert.equal(fs.readFileSync("/a.txt", "utf8"), "base+tail");
		const patcher = fs.createWriteStream("/a.txt", { flags: "r+", start: 1 });
		await new Promise<void>((resolve) => patcher.end("A", () => resolve()));
		assert.equal(fs.readFileSync("/a.txt", "utf8"), "bAse+tail");
	});

	test("pipe and errors", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/src", "x".repeat(200_000));
		const done = new Promise<void>((resolve, reject) => {
			const output = fs.createWriteStream("/dst");
			output.on("close", () => resolve());
			output.on("error", reject);
			fs.createReadStream("/src").pipe(output);
		});
		await done;
		assert.equal(fs.statSync("/dst").size, 200_000);
		const failing = fs.createReadStream("/missing");
		const error = await new Promise<unknown>((resolve) => failing.on("error", resolve));
		assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
	});

	test("streams over an existing file handle", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/fh", "handle data");
		const handle = await fs.promises.open("/fh");
		const text = await collect(handle.createReadStream({ encoding: "utf8" }));
		assert.equal(text, "handle data");
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(handle.fd, -1, "autoClose closes the handle");
	});
});
