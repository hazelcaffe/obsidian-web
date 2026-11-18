import { getWindowShim } from "./electron/browser-window.ts";
import { trackClipboard } from "./electron/clipboard.ts";
import { handleObsidianUrl, isNavigating, popupToken, trackContextMenu } from "./electron/main.ts";
import { trackPointer } from "./electron/menu.ts";
import { installWebview } from "./electron/webview.ts";
import { pageName } from "./env.ts";
import { installGlobals } from "./globals.ts";
import { installFetch } from "./net/fetch.ts";
import { installWebSocket } from "./net/websocket.ts";

type AppWindow = Window & typeof globalThis;

function parseFeatures(features: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const part of features.split(",")) {
		const [key, value = ""] = part.split("=");
		if (key) {
			result[key.trim()] = value.trim();
		}
	}
	return result;
}

/** Everything a window running app code needs: Node globals, `require`, networking and Electron hooks. */
export function prepareWindow(win: AppWindow, isPopup: boolean): void {
	installGlobals(win);
	installFetch(win);
	installWebSocket(win);
	installWebview(win);
	trackPointer(win);
	trackClipboard(win);
	trackContextMenu(win);
	getWindowShim(win, isPopup);
	patchOpen(win);
}

/**
 * Electron's window open handler: popouts (`about:blank` with the popup token) become browser popups set up like
 * Electron child windows, web links open in a new tab, `obsidian://` links are handled by the app.
 */
function patchOpen(win: AppWindow): void {
	const nativeOpen = win.open.bind(win);
	win.open = function open(url?: string | URL, target?: string, features?: string): Window | null {
		const href = url === undefined ? "" : String(url);
		const options = parseFeatures(features ?? "");
		if ((href === "" || href === "about:blank") && options.token === popupToken()) {
			const native = ["popup"];
			for (const [key, name] of [
				["width", "width"],
				["height", "height"],
				["x", "left"],
				["y", "top"],
			] as const) {
				if (options[key]) {
					native.push(`${name}=${options[key]}`);
				}
			}
			const popup = nativeOpen("about:blank", "_blank", native.join(",")) as AppWindow | null;
			if (popup) {
				prepareWindow(popup, true);
				if (options.background) {
					popup.document.documentElement.style.backgroundColor = options.background;
				}
			}
			return popup;
		}
		if (href.startsWith("obsidian://")) {
			handleObsidianUrl(href, win);
			return null;
		}
		let parsed: URL | null = null;
		try {
			parsed = new URL(href, win.location.href);
		} catch {}
		if (parsed && parsed.origin !== win.location.origin && /^(https?|mailto|tel):$/.test(parsed.protocol)) {
			return nativeOpen(parsed.href, "_blank", "noopener,noreferrer");
		}
		return nativeOpen(url, target, features);
	};

	const nativeClose = win.close.bind(win);
	win.close = function close(): void {
		if (isNavigating(win)) {
			return;
		}
		nativeClose();
		setTimeout(() => {
			if (!win.closed && !isNavigating(win) && pageName(win) === "index.html") {
				win.location.assign("/starter.html");
			}
		}, 100);
	};
}
