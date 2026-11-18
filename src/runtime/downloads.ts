import { DOWNLOADS } from "./env.ts";
import { getVfs } from "./vfs-instance.ts";

const DEBOUNCE = 500;

/**
 * Save dialogs point to the Downloads folder. Files written there (PDF/PNG exports, plugin exports) are handed to
 * the browser as downloads.
 */
export function watchDownloads(win: Window): void {
	const vfs = getVfs();
	const timers = new Map<string, number>();
	vfs.onChange((event) => {
		if (event.remote || event.isDirectory || event.type === "delete" || !event.path.startsWith(`${DOWNLOADS}/`)) {
			return;
		}
		const path = event.path;
		win.clearTimeout(timers.get(path));
		timers.set(
			path,
			win.setTimeout(async () => {
				timers.delete(path);
				try {
					const data = await vfs.fs.promises.readFile(path);
					const url = URL.createObjectURL(new Blob([new Uint8Array(data)]));
					const link = win.document.createElement("a");
					link.href = url;
					link.download = path.slice(path.lastIndexOf("/") + 1);
					link.click();
					win.setTimeout(() => URL.revokeObjectURL(url), 60_000);
				} catch (error) {
					console.error("[obsidian-web] Unable to download", path, error);
				}
			}, DEBOUNCE),
		);
	});
}
