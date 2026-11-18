import { EventEmitter } from "events";
import type { Stats } from "./stats.ts";

export type WatchEventType = "rename" | "change";

export class FSWatcher extends EventEmitter {
	#closed = false;
	readonly #onClose: () => void;

	constructor(onClose: () => void) {
		super();
		this.#onClose = onClose;
	}

	get closed(): boolean {
		return this.#closed;
	}

	close(): void {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		this.#onClose();
		queueMicrotask(() => this.emit("close"));
	}

	ref(): this {
		return this;
	}

	unref(): this {
		return this;
	}
}

export class StatWatcher extends EventEmitter {
	ref(): this {
		return this;
	}

	unref(): this {
		return this;
	}
}

export type StatListener = (current: Stats, previous: Stats) => void;
