/** URL prefix of obsidian-web's own static assets. */
export const ASSET_PREFIX = "/obsidian-web/";
/** URL prefix the service worker serves virtual file system files from (Electron's `app://<id>/` file root). */
export const VFS_URL_PREFIX = "/_vfs/";
/** Pages of the Obsidian bundle that get the runtime injected and wait for it before running app code. */
export const APP_PAGES: Record<string, string> = {
	"/index.html": "/app.js",
	"/starter.html": "/starter.js",
	"/help.html": "/help.js",
};

export type ClientMessage =
	| { type: "runtime-ready" }
	| { type: "app-updated" }
	| { type: "vfs-read-result"; id: number; data: ArrayBuffer | null };

export type WorkerMessage = { type: "vfs-read"; id: number; path: string };
