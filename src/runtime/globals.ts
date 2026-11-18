import { Buffer } from "buffer";
import { process } from "./node/process.ts";
import { createRequire } from "./node/registry.ts";

type MutableWindow = Window & typeof globalThis & Record<string, unknown>;

/** Node globals that Electron renderers with `nodeIntegration` have. */
export function installGlobals(target: Window): void {
	const win = target as MutableWindow;
	win.process = process;
	win.Buffer = Buffer;
	win.global = win;
	win.require = createRequire(win);
	win.setImmediate ??= (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
		win.setTimeout(callback, 0, ...args);
	win.clearImmediate ??= (handle: number) => win.clearTimeout(handle);
	win.__filename = "/opt/obsidian/resources/obsidian.asar/index.html";
	win.__dirname = "/opt/obsidian/resources/obsidian.asar";
	installPolyfills(win);
}

/** Chromium-only APIs the desktop app relies on, for other engines. */
function installPolyfills(win: MutableWindow): void {
	if (!("navigation" in win) || !win.navigation) {
		Object.defineProperty(win, "navigation", { value: new win.EventTarget(), configurable: true });
	}
	const elementProto = win.Element.prototype as Element & { scrollIntoViewIfNeeded?: (center?: boolean) => void };
	if (!elementProto.scrollIntoViewIfNeeded) {
		elementProto.scrollIntoViewIfNeeded = function (this: Element, center = true) {
			const rect = this.getBoundingClientRect();
			const parent = this.parentElement;
			const bounds = parent?.getBoundingClientRect() ?? {
				top: 0,
				bottom: win.innerHeight,
				left: 0,
				right: win.innerWidth,
			};
			if (
				rect.top < bounds.top ||
				rect.bottom > bounds.bottom ||
				rect.left < bounds.left ||
				rect.right > bounds.right
			) {
				this.scrollIntoView({ block: center ? "center" : "nearest", inline: "nearest" });
			}
		};
	}
	const docProto = win.Document.prototype as unknown as Record<string, unknown>;
	if (!("caretRangeFromPoint" in docProto) && "caretPositionFromPoint" in docProto) {
		docProto.caretRangeFromPoint = function (this: Document, x: number, y: number): Range | null {
			const position = (
				this as Document & { caretPositionFromPoint(x: number, y: number): CaretPosition | null }
			).caretPositionFromPoint(x, y);
			if (!position) {
				return null;
			}
			const range = this.createRange();
			range.setStart(position.offsetNode, position.offset);
			range.collapse(true);
			return range;
		};
	}
}
