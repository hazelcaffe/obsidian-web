import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { ChangeEvent, Vfs } from "../../src/vfs/index.ts";
import { createMemoryOpfs } from "../helpers/memory-opfs.ts";
import { closeAll, makeVfs, tick, uniqueChannel, waitFor } from "../helpers/vfs.ts";

after(closeAll);

function treeSnapshot(fs: Vfs["fs"]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of fs.readdirSync("/", { withFileTypes: true, recursive: true })) {
		const path = entry.parentPath === "/" ? `/${entry.name}` : `${entry.parentPath}/${entry.name}`;
		if (/^\/(tmp|proc|dev)(\/|$)/.test(path)) {
			continue;
		}
		const stat = fs.lstatSync(path);
		out[path] = entry.isFile()
			? `${fs.readFileSync(path, "utf8")}|${stat.mtimeMs}|${stat.mode}`
			: entry.isDirectory()
				? "dir"
				: `link:${fs.readlinkSync(path)}`;
	}
	return out;
}

async function pair(options: { eagerLoadLimit?: number } = {}) {
	const root = createMemoryOpfs();
	root.put("vault/existing.md", "old");
	const channelName = uniqueChannel();
	const a = await makeVfs({ root, channelName, ...options });
	const b = await makeVfs({ root, meta: a.meta, channelName, ...options });
	return { a, b, root };
}

describe("cross-instance coherence", () => {
	test("applies remote writes, mkdirs and metadata", async () => {
		const { a, b } = await pair();
		const watched: string[] = [];
		b.fs.watch("/vault", { recursive: true }, (eventType, filename) =>
			watched.push(`${eventType}:${String(filename)}`),
		);
		const changes: ChangeEvent[] = [];
		b.vfs.onChange((event) => changes.push(event));

		await a.fs.promises.mkdir("/vault/new/dir", { recursive: true });
		await a.fs.promises.writeFile("/vault/new/dir/file.md", "from A");
		await a.fs.promises.writeFile("/vault/existing.md", "updated");
		await waitFor(() => b.fs.existsSync("/vault/new/dir/file.md"), 2000, "remote create");
		await waitFor(() => b.fs.readFileSync("/vault/existing.md", "utf8") === "updated", 2000, "remote update");
		assert.equal(b.fs.readFileSync("/vault/new/dir/file.md", "utf8"), "from A");
		assert.equal(b.fs.statSync("/vault/new/dir/file.md").mtimeMs, a.fs.statSync("/vault/new/dir/file.md").mtimeMs);
		assert.equal(
			b.fs.statSync("/vault/new/dir/file.md").birthtimeMs,
			a.fs.statSync("/vault/new/dir/file.md").birthtimeMs,
		);

		await a.fs.promises.utimes("/vault/existing.md", 100, 200);
		await a.fs.promises.chmod("/vault/existing.md", 0o600);
		await waitFor(() => b.fs.statSync("/vault/existing.md").mode === 0o100600, 2000, "remote chmod");
		assert.equal(b.fs.statSync("/vault/existing.md").mtimeMs, 200_000);

		await tick();
		assert.ok(watched.includes("rename:new"), watched.join());
		assert.ok(watched.includes("rename:new/dir/file.md"), watched.join());
		assert.ok(watched.includes("change:existing.md"), watched.join());
		assert.ok(changes.every((event) => event.remote));
		assert.ok(changes.some((event) => event.type === "create" && event.path === "/vault/new/dir/file.md"));
	});

	test("applies remote renames and removals", async () => {
		const { a, b } = await pair();
		await a.fs.promises.mkdir("/vault/folder");
		await a.fs.promises.writeFile("/vault/folder/x.md", "x");
		await waitFor(() => b.fs.existsSync("/vault/folder/x.md"));
		const events: string[] = [];
		b.fs.watch("/vault", { recursive: true }, (eventType, filename) =>
			events.push(`${eventType}:${String(filename)}`),
		);

		await a.fs.promises.rename("/vault/folder", "/vault/renamed");
		await waitFor(() => b.fs.existsSync("/vault/renamed/x.md"), 2000, "remote rename");
		assert.equal(b.fs.existsSync("/vault/folder"), false);
		assert.equal(b.fs.readFileSync("/vault/renamed/x.md", "utf8"), "x");

		await a.fs.promises.rm("/vault/renamed", { recursive: true });
		await waitFor(() => !b.fs.existsSync("/vault/renamed"), 2000, "remote removal");

		await a.fs.promises.symlink("/vault/existing.md", "/vault/link");
		await waitFor(() => b.fs.existsSync("/vault/link"), 2000, "remote symlink");
		assert.equal(b.fs.readlinkSync("/vault/link"), "/vault/existing.md");
		await tick();
		assert.deepEqual(events.slice(0, 2), ["rename:folder", "rename:renamed"]);
		assert.ok(events.includes("rename:renamed/x.md"));
	});

	test("propagates sync writes once they are persisted, in both directions", async () => {
		const { a, b } = await pair();
		a.fs.writeFileSync("/vault/sync.md", "1");
		b.fs.writeFileSync("/vault/other.md", "2");
		await waitFor(() => b.fs.existsSync("/vault/sync.md") && a.fs.existsSync("/vault/other.md"));
		assert.equal(a.fs.readFileSync("/vault/other.md", "utf8"), "2");
		assert.equal(b.fs.readFileSync("/vault/sync.md", "utf8"), "1");
	});

	test("large remote files are updated lazily", async () => {
		const { a, b } = await pair({ eagerLoadLimit: 16 });
		await a.fs.promises.writeFile("/vault/big.bin", "x".repeat(100));
		await waitFor(() => b.fs.existsSync("/vault/big.bin"));
		assert.equal(b.fs.statSync("/vault/big.bin").size, 100);
		assert.equal(b.vfs.isLoaded("/vault/big.bin"), false);
		assert.equal(await b.fs.promises.readFile("/vault/big.bin", "utf8"), "x".repeat(100));
		await a.fs.promises.writeFile("/vault/big.bin", "y".repeat(50));
		await waitFor(() => b.fs.statSync("/vault/big.bin").size === 50);
		assert.equal(await b.fs.promises.readFile("/vault/big.bin", "utf8"), "y".repeat(50));
	});

	test("ignores memory-only paths and its own messages", async () => {
		const { a, b } = await pair();
		await a.fs.promises.writeFile("/tmp/private", "p");
		await a.fs.promises.writeFile("/vault/marker", "m");
		await waitFor(() => b.fs.existsSync("/vault/marker"));
		assert.equal(b.fs.existsSync("/tmp/private"), false);
		const own: ChangeEvent[] = [];
		a.vfs.onChange((event) => {
			if (event.remote) {
				own.push(event);
			}
		});
		await a.fs.promises.writeFile("/vault/again", "x");
		await waitFor(() => b.fs.existsSync("/vault/again"));
		await tick(10);
		assert.deepEqual(own, []);
	});

	test("buffers messages received while mounting", async () => {
		const root = createMemoryOpfs();
		const channelName = uniqueChannel();
		const a = await makeVfs({ root, channelName });
		const meta = a.meta;
		const mounting = makeVfs({ root, meta, channelName });
		await a.fs.promises.writeFile("/during-mount", "x");
		const b = await mounting;
		await waitFor(() => b.fs.existsSync("/during-mount"));
		assert.equal(b.fs.readFileSync("/during-mount", "utf8"), "x");
	});

	test("a passive instance converges to the active one", async () => {
		const { a, b } = await pair();
		let state = Number(process.env.VFS_SEED ?? 7);
		const random = (): number => {
			state = (state * 1664525 + 1013904223) >>> 0;
			return state / 2 ** 32;
		};
		const paths = ["/vault/a", "/vault/b", "/vault/d", "/vault/d/a", "/vault/d/b", "/vault/e/f"];
		const pick = (): string => paths[Math.floor(random() * paths.length)] ?? "/vault/a";
		for (let i = 0; i < 200; i++) {
			try {
				switch (Math.floor(random() * 7)) {
					case 0:
						a.fs.writeFileSync(pick(), `w${i}`);
						break;
					case 1:
						a.fs.appendFileSync(pick(), `+${i}`);
						break;
					case 2:
						a.fs.renameSync(pick(), pick());
						break;
					case 3:
						a.fs.mkdirSync(pick(), { recursive: true });
						break;
					case 4:
						a.fs.rmSync(pick(), { recursive: true, force: true });
						break;
					case 5:
						a.fs.utimesSync(pick(), i, i);
						break;
					case 6:
						a.fs.symlinkSync(`target${i}`, pick());
						break;
				}
			} catch {}
		}
		await a.vfs.flush();
		await waitFor(() => isDeepStrictEqual(treeSnapshot(a.fs), treeSnapshot(b.fs)), 3000, "convergence");
	});
});
