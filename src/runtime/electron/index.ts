import { getWindowShim } from "./browser-window.ts";
import { clipboard } from "./clipboard.ts";
import { saveZoom } from "./main.ts";
import { nativeImage } from "./native-image.ts";
import { createRemote, shell } from "./remote.ts";

/** The `electron` module as seen by one renderer window (main tab or popout). */
export function createElectronModule(win: Window): Record<string, unknown> {
	const shim = getWindowShim(win, win.opener !== null && win.location.href === "about:blank");
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
			getPathForFile: (file: File): string => (file as File & { path?: string }).path ?? "",
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
