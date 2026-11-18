import { Buffer } from "buffer";
import { NativeImage } from "./native-image.ts";

let lastText = "";
let lastHtml = "";
let lastImage: Uint8Array | null = null;

const nativeClipboard = navigator.clipboard;
const nativeReadText = nativeClipboard?.readText?.bind(nativeClipboard);
const nativeWriteText = nativeClipboard?.writeText?.bind(nativeClipboard);
const nativeRead = nativeClipboard?.read?.bind(nativeClipboard);
const nativeWrite = nativeClipboard?.write?.bind(nativeClipboard);

/** Keeps a copy of what the page put on the clipboard, for Electron's synchronous getters. */
export function trackClipboard(win: Window): void {
	win.document.addEventListener(
		"copy",
		() => {
			setTimeout(() => {
				lastText = win.getSelection()?.toString() ?? lastText;
			}, 0);
		},
		true,
	);
	win.document.addEventListener(
		"paste",
		(event) => {
			lastText = event.clipboardData?.getData("text/plain") ?? lastText;
			lastHtml = event.clipboardData?.getData("text/html") ?? lastHtml;
		},
		true,
	);
}

function report(error: unknown): void {
	console.warn("[obsidian-web] Clipboard access failed", error);
}

/**
 * Electron's clipboard. Reads are asynchronous in browsers, so `readText` returns a promise; the app only calls it
 * from an async wrapper around `navigator.clipboard.readText`.
 */
export const clipboard = {
	readText(): Promise<string> | string {
		if (!nativeReadText) {
			return lastText;
		}
		return nativeReadText().then(
			(text) => {
				lastText = text;
				return text;
			},
			(error: unknown) => {
				report(error);
				return lastText;
			},
		);
	},
	writeText(text: string): void {
		lastText = String(text);
		nativeWriteText?.(lastText).catch(report);
	},
	readHTML(): string {
		return lastHtml;
	},
	writeHTML(html: string): void {
		lastHtml = html;
		if (typeof ClipboardItem !== "undefined" && nativeWrite) {
			nativeWrite([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }) })]).catch(report);
		}
	},
	readRTF: (): string => "",
	writeRTF: (): void => undefined,
	readBookmark: () => ({ title: "", url: "" }),
	writeBookmark: (): void => undefined,
	readFindText: (): string => "",
	writeFindText: (): void => undefined,
	readImage(): NativeImage {
		return new NativeImage(lastImage ?? new Uint8Array(0));
	},
	writeImage(image: NativeImage): void {
		const png = image.toPNG();
		lastImage = new Uint8Array(png);
		if (typeof ClipboardItem !== "undefined" && nativeWrite) {
			nativeWrite([
				new ClipboardItem({ "image/png": new Blob([lastImage.slice()], { type: "image/png" }) }),
			]).catch(report);
		}
	},
	readBuffer: (): Buffer => Buffer.alloc(0),
	writeBuffer: (): void => undefined,
	read: (): string => "",
	availableFormats(): string[] {
		const formats: string[] = [];
		if (lastText) {
			formats.push("text/plain");
		}
		if (lastHtml) {
			formats.push("text/html");
		}
		return formats;
	},
	has: (format: string): boolean => clipboard.availableFormats().includes(format),
	clear(): void {
		lastText = "";
		lastHtml = "";
		lastImage = null;
		nativeWriteText?.("").catch(report);
	},
	write(data: { text?: string; html?: string; image?: NativeImage } | ClipboardItem[]): Promise<void> | void {
		if (Array.isArray(data)) {
			return nativeWrite ? nativeWrite(data) : undefined;
		}
		if (data.html) {
			clipboard.writeHTML(data.html);
		} else if (data.text !== undefined) {
			clipboard.writeText(data.text);
		}
		if (data.image) {
			clipboard.writeImage(data.image);
		}
		return undefined;
	},
};

/** Electron >= 44 exposes the async clipboard on `remote.clipboard`. */
export const remoteClipboard = {
	...clipboard,
	read: async (): Promise<Array<{ types: readonly string[]; getType(type: string): Promise<Blob>; items: [] }>> => {
		const items = nativeRead ? await nativeRead().catch(() => []) : [];
		return items.map((item) => ({ types: item.types, getType: (type: string) => item.getType(type), items: [] }));
	},
	write: async (items: ClipboardItem[]): Promise<void> => {
		if (nativeWrite) {
			await nativeWrite(items);
		}
	},
};
