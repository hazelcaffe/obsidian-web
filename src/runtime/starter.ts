import { openVault } from "./electron/main.ts";
import { importFolder, importZip } from "./vault-transfer.ts";

function pick(win: Window, directory: boolean): Promise<File[]> {
	const input = win.document.createElement("input");
	input.type = "file";
	if (directory) {
		input.webkitdirectory = true;
	} else {
		input.accept = ".zip,application/zip";
	}
	return new Promise((resolve) => {
		input.addEventListener("change", () => resolve([...(input.files ?? [])]), { once: true });
		input.addEventListener("cancel", () => resolve([]), { once: true });
		input.click();
	});
}

function createSetting(doc: Document, onFolder: () => void, onZip: () => void): HTMLElement {
	const item = doc.createElement("div");
	item.className = "setting-item obsidian-web-import";
	const info = doc.createElement("div");
	info.className = "setting-item-info";
	const name = doc.createElement("div");
	name.className = "setting-item-name";
	name.textContent = "Import vault";
	const description = doc.createElement("div");
	description.className = "setting-item-description";
	description.textContent = "Copy a folder or a ZIP archive from your computer into the browser.";
	info.append(name, description);
	const control = doc.createElement("div");
	control.className = "setting-item-control";
	const folder = doc.createElement("button");
	folder.textContent = "Folder";
	folder.addEventListener("click", onFolder);
	const zip = doc.createElement("button");
	zip.textContent = "ZIP";
	zip.addEventListener("click", onZip);
	control.append(folder, zip);
	item.append(info, control);
	return item;
}

/** Adds an "Import vault" option next to "Open folder as vault" on the vault picker. */
export function enhanceStarter(win: Window): void {
	const doc = win.document;
	const run = async (task: () => Promise<string | null>, status: HTMLElement): Promise<void> => {
		try {
			const path = await task();
			if (path) {
				status.textContent = "Opening…";
				const result = openVault(path, win);
				if (result !== true) {
					status.textContent = `Unable to open the vault: ${result}`;
				}
			} else {
				status.textContent = "Copy a folder or a ZIP archive from your computer into the browser.";
			}
		} catch (error) {
			console.error(error);
			status.textContent = `Import failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	};
	const install = (): boolean => {
		const container = doc.querySelector(".open-vault-options.mod-open-vault");
		const settings = container?.querySelectorAll(".setting-item");
		if (!container || !settings || settings.length < 2 || container.querySelector(".obsidian-web-import")) {
			return !!container?.querySelector(".obsidian-web-import");
		}
		const anchor = settings[1] as HTMLElement;
		let item: HTMLElement;
		const status = (): HTMLElement => item.querySelector(".setting-item-description") as HTMLElement;
		const progress = (done: number, total: number): void => {
			status().textContent = `Importing… ${done} / ${total} files`;
		};
		item = createSetting(
			doc,
			() =>
				void run(async () => {
					const files = await pick(win, true);
					return files.length > 0 ? importFolder(files, progress) : null;
				}, status()),
			() =>
				void run(async () => {
					const [file] = await pick(win, false);
					return file ? importZip(file, progress) : null;
				}, status()),
		);
		anchor.after(item);
		return true;
	};
	const observer = new MutationObserver(() => {
		install();
	});
	const start = (): void => {
		if (!install()) {
			observer.observe(doc.body, { childList: true, subtree: true });
		}
	};
	if (doc.body) {
		start();
	} else {
		doc.addEventListener("DOMContentLoaded", start, { once: true });
	}
}
