import { splitPath } from "./path.ts";

interface TrieNode {
	parent: TrieNode | null;
	name: string;
	children: Map<string, TrieNode>;
	entries: Entry[];
}

interface Entry {
	paths: readonly string[];
	started: boolean;
	coalesceKey: unknown;
	promise: Promise<void>;
	done: Promise<void>;
}

const noop = (): void => {};

function newTrieNode(parent: TrieNode | null, name: string): TrieNode {
	return { parent, name, children: new Map(), entries: [] };
}

/**
 * Runs persistence tasks with path-based ordering: a task waits for every earlier task whose path is the same as,
 * an ancestor of, or a descendant of one of its own paths. Unrelated paths run concurrently (bounded).
 */
export class PersistQueue {
	readonly #root = newTrieNode(null, "");
	readonly #active = new Set<Entry>();
	readonly #concurrency: number;
	readonly #waiting: Array<() => void> = [];
	#running = 0;

	constructor(concurrency = 8) {
		this.#concurrency = concurrency;
	}

	get size(): number {
		return this.#active.size;
	}

	/**
	 * Queue `run` for `paths`. With a `coalesceKey`, a not-yet-started task with the same key that is the latest task
	 * for the same single path is reused instead (its `run` must read the current state when it starts).
	 */
	enqueue(
		paths: readonly string[],
		run: () => Promise<void>,
		coalesceKey?: unknown,
	): { promise: Promise<void>; coalesced: boolean } {
		const [first] = paths;
		if (coalesceKey !== undefined && paths.length === 1 && first !== undefined) {
			const last = this.#find(first)?.entries.at(-1);
			if (last && !last.started && last.coalesceKey === coalesceKey) {
				return { promise: last.promise, coalesced: true };
			}
		}
		const deps = new Set<Entry>();
		for (const path of paths) {
			this.#collectDeps(path, deps);
		}
		const entry: Entry = {
			paths,
			started: false,
			coalesceKey,
			promise: Promise.resolve(),
			done: Promise.resolve(),
		};
		const waitFor = [...deps].map((dep) => dep.done);
		entry.promise = (async () => {
			if (waitFor.length > 0) {
				await Promise.all(waitFor);
			}
			await this.#acquire();
			entry.started = true;
			try {
				await run();
			} finally {
				this.#release();
				this.#remove(entry);
			}
		})();
		entry.done = entry.promise.then(noop, noop);
		this.#active.add(entry);
		for (const path of paths) {
			this.#insert(path).entries.push(entry);
		}
		return { promise: entry.promise, coalesced: false };
	}

	/** Resolves once every queued task (including ones queued while waiting) has settled. */
	async drain(): Promise<void> {
		while (this.#active.size > 0) {
			await Promise.all([...this.#active].map((entry) => entry.done));
		}
	}

	/** Resolves once all tasks currently queued for `path` (or related paths) have settled. */
	async barrier(path: string): Promise<void> {
		const deps = new Set<Entry>();
		this.#collectDeps(path, deps);
		await Promise.all([...deps].map((dep) => dep.done));
	}

	#collectDeps(path: string, deps: Set<Entry>): void {
		let node: TrieNode | undefined = this.#root;
		addLast(node, deps);
		for (const segment of splitPath(path)) {
			node = node.children.get(segment);
			if (!node) {
				return;
			}
			addLast(node, deps);
		}
		const stack = [...node.children.values()];
		for (let next = stack.pop(); next; next = stack.pop()) {
			addLast(next, deps);
			stack.push(...next.children.values());
		}
	}

	#find(path: string): TrieNode | undefined {
		let node: TrieNode | undefined = this.#root;
		for (const segment of splitPath(path)) {
			node = node.children.get(segment);
			if (!node) {
				return undefined;
			}
		}
		return node;
	}

	#insert(path: string): TrieNode {
		let node = this.#root;
		for (const segment of splitPath(path)) {
			let child = node.children.get(segment);
			if (!child) {
				child = newTrieNode(node, segment);
				node.children.set(segment, child);
			}
			node = child;
		}
		return node;
	}

	#remove(entry: Entry): void {
		this.#active.delete(entry);
		for (const path of entry.paths) {
			let node = this.#find(path);
			if (!node) {
				continue;
			}
			const index = node.entries.indexOf(entry);
			if (index >= 0) {
				node.entries.splice(index, 1);
			}
			while (node.parent && node.entries.length === 0 && node.children.size === 0) {
				node.parent.children.delete(node.name);
				node = node.parent;
			}
		}
	}

	#acquire(): Promise<void> {
		if (this.#running < this.#concurrency) {
			this.#running++;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.#waiting.push(resolve));
	}

	#release(): void {
		const next = this.#waiting.shift();
		if (next) {
			next();
		} else {
			this.#running--;
		}
	}
}

function addLast(node: TrieNode, deps: Set<Entry>): void {
	const last = node.entries.at(-1);
	if (last) {
		deps.add(last);
	}
}
