import { getVfs } from "../vfs-instance.ts";
import { getWindowShim } from "./browser-window.ts";
import { clipboard } from "./clipboard.ts";
import { saveZoom } from "./main.ts";
import { nativeImage } from "./native-image.ts";
import { createRemote, shell } from "./remote.ts";

const DROP_TTL = 10_000;
const dropped = new Map<string, number>();
const droppedPaths = new WeakMap<File, string>();

function fileKey(file: File): string {
	return `${file.name}\u0000${file.size}\u0000${file.lastModified}\u0000${file.type}`;
}

function trackDrops(win: Window): void {
	win.addEventListener(
		"drop",
		(event) => {
			const now = Date.now();
			for (const [key, time] of dropped) {
				if (now - time > DROP_TTL) {
					dropped.delete(key);
				}
			}
			for (const file of event.dataTransfer?.files ?? []) {
				dropped.set(fileKey(file), now);
			}
		},
		true,
	);
}

/**
 * Electron gives files dropped from the OS a path, which the app copies from. Dropped files are mounted read-only
 * under /tmp so they keep their names; pasted files have no path, like on desktop.
 */
function droppedFilePath(file: File): string {
	const known = droppedPaths.get(file);
	if (known) {
		return known;
	}
	if (!dropped.has(fileKey(file)) || (file.size === 0 && file.type === "")) {
		return "";
	}
	const path = `/tmp/dropped/${crypto.randomUUID()}/${file.name.replace(/\//g, "_")}`;
	getVfs().registerVirtualFile(path, file);
	droppedPaths.set(file, path);
	return path;
}

/** The `electron` module as seen by one renderer window (main tab or popout). */
export function createElectronModule(win: Window): Record<string, unknown> {
	const shim = getWindowShim(win, win.opener !== null && win.location.href === "about:blank");
	trackDrops(win);
	const webFrame = shim.webContents.webFrame;
	const setZoomLevel = webFrame.setZoomLevel.bind(webFrame);
	webFrame.setZoomLevel = (level: number) => {
		setZoomLevel(level);
		if (!shim.isPopup) {
			saveZoom(win, webFrame.getZoomLevel());
		}
	};
	const remote = createRemote(win);
	return {
		ipcRenderer: shim.webContents.ipc,
		remote,
		webFrame,
		clipboard,
		shell,
		nativeImage,
		webUtils: {
			getPathForFile: (file: File): string => droppedFilePath(file),
		},
		contextBridge: {
			exposeInMainWorld: (key: string, api: unknown) => {
				(win as unknown as Record<string, unknown>)[key] = api;
			},
			exposeInIsolatedWorld: () => undefined,
			executeInMainWorld: ({ func, args = [] }: { func: (...args: unknown[]) => unknown; args?: unknown[] }) =>
				func(...args),
		},
		crashReporter: { start() {}, addExtraParameter() {}, removeExtraParameter() {}, getParameters: () => ({}) },
	};
}
