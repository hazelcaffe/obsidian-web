import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { ChangeEvent } from "../../src/vfs/index.ts";
import { createMemoryOpfs, randomDelay } from "../helpers/memory-opfs.ts";
import { closeAll, makeVfs, tick, waitFor } from "../helpers/vfs.ts";

after(closeAll);

describe("fs.watch", () => {
	test("recursive watchers report relative paths", async () => {
		const { fs } = await makeVfs();
		fs.mkdirSync("/v");
		const events: string[] = [];
		const watcher = fs.watch("/v", { recursive: true }, (eventType, filename) => {
			events.push(`${eventType}:${String(filename)}`);
		});
		fs.writeFileSync("/v/a.md", "1");
		assert.deepEqual(events, [], "events are not emitted synchronously");
		await tick();
		fs.writeFileSync("/v/a.md", "2");
		fs.mkdirSync("/v/sub");
		fs.writeFileSync("/v/sub/b.md", "b");
		fs.renameSync("/v/a.md", "/v/c.md");
		fs.utimesSync("/v/c.md", 1, 1);
		await tick();
		fs.rmSync("/v/sub", { recursive: true });
		fs.writeFileSync("/outside", "x");
		await tick();
		assert.deepEqual(events, [
			"rename:a.md",
			"change:a.md",
			"rename:sub",
			"rename:sub/b.md",
			"rename:a.md",
			"rename:c.md",
			"change:c.md",
			"rename:sub/b.md",
			"rename:sub",
		]);
		watcher.close();
		fs.writeFileSync("/v/after-close", "");
		await tick();
		assert.equal(events.length, 9);
	});

	test("non-recursive watchers only see direct children", async () => {
		const { fs } = await makeVfs();
		fs.mkdirSync("/v/sub", { recursive: true });
		const events: string[] = [];
		const watcher = fs.watch("/v", (eventType, filename) => events.push(`${eventType}:${String(filename)}`));
		fs.writeFileSync("/v/top", "");
		fs.writeFileSync("/v/sub/deep", "");
		await tick();
		assert.deepEqual(events, ["rename:top"]);
		watcher.close();
	});

	test("watching a file reports its basename", async () => {
		const { fs } = await makeVfs();
		fs.writeFileSync("/file.txt", "a");
		const events: unknown[][] = [];
		const watcher = fs.watch("/file.txt");
		watcher.on("change", (...args: unknown[]) => events.push(args));
		const closed = new Promise<void>((resolve) => watcher.on("close", () => resolve()));
		fs.appendFileSync("/file.txt", "b");
		await tick();
		assert.deepEqual(events, [["change", "file.txt"]]);
		watcher.close();
		await closed;
		assert.throws(
			() => fs.watch("/missing"),
			(error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
		);
	});

	test("buffer encoding and AbortSignal", async () => {
		const { fs } = await makeVfs();
		fs.mkdirSync("/w");
		const controller = new AbortController();
		const names: unknown[] = [];
		fs.watch("/w", { encoding: "buffer", signal: controller.signal }, (_type, filename) => names.push(filename));
		fs.writeFileSync("/w/x", "");
		await tick();
		controller.abort();
		fs.writeFileSync("/w/y", "");
		await tick();
		assert.equal(names.length, 1);
		assert.ok(Buffer.isBuffer(names[0]));
	});
});

describe("fs.promises.watch", () => {
	test("yields events until aborted", async () => {
		const { fs } = await makeVfs();
		fs.mkdirSync("/p");
		const controller = new AbortController();
		const seen: string[] = [];
		const consumer = (async () => {
			try {
				for await (const event of fs.promises.watch("/p", { recursive: true, signal: controller.signal })) {
					seen.push(`${event.eventType}:${String(event.filename)}`);
					if (seen.length === 2) {
						controller.abort();
					}
				}
			} catch (error) {
				return (error as Error).name;
			}
			return "done";
		})();
		await tick();
		fs.writeFileSync("/p/one", "");
		await tick();
		fs.writeFileSync("/p/one", "changed");
		assert.equal(await consumer, "AbortError");
		assert.deepEqual(seen, ["rename:one", "change:one"]);
	});
});

describe("fs.watchFile", () => {
	test("calls listeners with current and previous stats", async () => {
		const { fs } = await makeVfs();
		const calls: Array<[number, number]> = [];
		const listener = (current: { size: number }, previous: { size: number }): void => {
			calls.push([current.size, previous.size]);
		};
		const watcher = fs.watchFile("/watched", { interval: 10 }, listener);
		assert.equal(typeof watcher.unref, "function");
		fs.writeFileSync("/watched", "abc");
		await tick();
		fs.appendFileSync("/watched", "de");
		await tick();
		fs.unwatchFile("/watched", listener);
		fs.appendFileSync("/watched", "f");
		await tick();
		assert.deepEqual(calls, [
			[3, 0],
			[5, 3],
		]);
	});
});

describe("onChange", () => {
	test("reports local changes once they are persisted", async () => {
		const root = createMemoryOpfs({ delay: randomDelay(2) });
		const { fs, vfs } = await makeVfs({ root });
		const events: ChangeEvent[] = [];
		const persisted: Array<string | undefined> = [];
		const unsubscribe = vfs.onChange((event) => {
			events.push(event);
			persisted.push(event.type === "delete" ? "deleted" : root.read(event.path.slice(1)));
		});
		fs.mkdirSync("/d");
		fs.writeFileSync("/d/f", "v1");
		fs.writeFileSync("/d/f", "v2");
		fs.renameSync("/d/f", "/d/g");
		fs.rmSync("/d", { recursive: true });
		fs.writeFileSync("/tmp/mem", "m");
		await vfs.flush();
		await waitFor(() => events.length === 6);
		const label = (event: ChangeEvent): string =>
			`${event.type}:${event.path}:${event.oldPath ?? ""}:${event.isDirectory}:${event.remote}`;
		assert.deepEqual(events.filter((event) => !event.path.startsWith("/tmp")).map(label), [
			"create:/d::true:false",
			"create:/d/f::false:false",
			"modify:/d/f::false:false",
			"rename:/d/g:/d/f:false:false",
			"delete:/d::true:false",
		]);
		assert.ok(events.some((event) => label(event) === "create:/tmp/mem::false:false"));
		assert.equal(persisted[events.findIndex((event) => event.type === "create" && event.path === "/d/f")], "v2");
		unsubscribe();
		fs.writeFileSync("/later", "");
		await vfs.flush();
		await tick();
		assert.equal(events.length, 6);
	});
});
