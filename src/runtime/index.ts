import { BUNDLE_INFO_URL, BUNDLE_MARKER, type BundleInfo } from "../shared/bundle.ts";
import type { ClientMessage, WorkerMessage } from "../shared/constants.ts";
import { appUrl, BASE_PATH } from "../shared/paths.ts";
import { getOpfsRoot, OPFS_VFS_DIR, VFS_META_FILE } from "../shared/storage.ts";
import { LAST_VAULT_KEY } from "../shared/storage-keys.ts";
import { createFs } from "../vfs/index.ts";
import { applyWebDefaults, onAppCreated } from "./app-hooks.ts";
import { setOpenedApp } from "./app-info.ts";
import { watchDownloads } from "./downloads.ts";
import { applyIcon, registerMainHandlers, takePendingVaultMessage } from "./electron/main.ts";
import { currentVaultId, DESKTOP, DOCUMENTS, DOWNLOADS, HOME, pageName, TEMP, USER_DATA } from "./env.ts";
import { hideLoading, showLoading, watchDownload } from "./loading.ts";
import { setAppVersion } from "./net/curl.ts";
import { registerNodeModules } from "./node/index.ts";
import { enhanceStarter } from "./starter.ts";
import { setVfs } from "./vfs-instance.ts";
import { prepareWindow } from "./windows.ts";

const EAGER_LIMIT = 2 * 1024 * 1024;

function notifyWorker(message: ClientMessage, transfer: Transferable[] = []): void {
	navigator.serviceWorker?.controller?.postMessage(message, transfer);
}

/** Reads the vault path for the current window straight from OPFS, before the file system is mounted. */
async function readVaultPath(root: FileSystemDirectoryHandle, id: string | null): Promise<string | null> {
	if (!id) {
		return null;
	}
	try {
		let dir = root;
		for (const part of USER_DATA.split("/").filter(Boolean)) {
			dir = await dir.getDirectoryHandle(part);
		}
		const text = await (await (await dir.getFileHandle("obsidian.json")).getFile()).text();
		const config = JSON.parse(text) as { vaults?: Record<string, { path?: string }> };
		return config.vaults?.[id]?.path ?? null;
	} catch {
		return null;
	}
}

function showFatalError(error: unknown): void {
	console.error(error);
	hideLoading();
	const show = (): void => {
		const box = document.createElement("div");
		box.style.cssText =
			"position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#1e1e1e;color:#ddd;font:14px system-ui;padding:24px;";
		const message = error instanceof Error ? error.message : String(error);
		box.innerHTML = `<div style="max-width:560px"><h2>Obsidian Web failed to start</h2><p></p><p><a href="" style="color:#a88bfa">Reload</a></p></div>`;
		(box.querySelector("p") as HTMLElement).textContent = message;
		document.body.appendChild(box);
	};
	if (document.body) {
		show();
	} else {
		document.addEventListener("DOMContentLoaded", show, { once: true });
	}
}

async function ensureServiceWorker(): Promise<boolean> {
	if (!navigator.serviceWorker || !navigator.storage?.getDirectory) {
		throw new Error("This browser needs OPFS and service workers. Open the site on localhost or over HTTPS.");
	}
	const registration = await navigator.serviceWorker.register(appUrl("sw.js"), {
		scope: BASE_PATH,
		updateViaCache: "none",
	});
	const legacyPage = !document.querySelector(`meta[name="${BUNDLE_MARKER}"]`);
	if (legacyPage) {
		await registration.update();
	}
	const installing = registration.installing ?? registration.waiting;
	if (installing && installing.state !== "activated") {
		const stopProgress = watchDownload(installing);
		try {
			await new Promise<void>((resolve, reject) => {
				const onStateChange = (): void => {
					if (installing.state === "activated" || installing.state === "redundant") {
						installing.removeEventListener("statechange", onStateChange);
						if (installing.state === "activated") {
							resolve();
						} else {
							reject(new Error("Service worker installation failed"));
						}
					}
				};
				installing.addEventListener("statechange", onStateChange);
				onStateChange();
			});
		} finally {
			stopProgress();
		}
	}
	await navigator.serviceWorker.ready;
	if (!navigator.serviceWorker.controller) {
		await new Promise<void>((resolve) => {
			navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
		});
	}
	if (legacyPage) {
		location.reload();
		return false;
	}
	return true;
}

async function initialize(): Promise<void> {
	if (!(await ensureServiceWorker())) {
		return;
	}
	showLoading("Opening Obsidian…");
	const response = await fetch(BUNDLE_INFO_URL);
	if (!response.ok) {
		throw new Error("Missing bundled app metadata. Run pnpm build to regenerate dist/.");
	}
	const opened = (await response.json()) as BundleInfo;
	setOpenedApp(opened);
	setAppVersion(opened.version);

	const opfs = await getOpfsRoot();
	const vfsRoot = await opfs.getDirectoryHandle(OPFS_VFS_DIR, { create: true });
	if (pageName() === "index.html" && !currentVaultId()) {
		const last = localStorage.getItem(LAST_VAULT_KEY);
		const path = await readVaultPath(vfsRoot, last);
		location.replace(appUrl(path && last ? `index.html?vault=${encodeURIComponent(last)}` : "starter.html"));
		return;
	}
	const vaultPath = await readVaultPath(vfsRoot, currentVaultId());
	showLoading("Opening local vault…");
	const vfs = await createFs({
		root: vfsRoot,
		metaDir: opfs,
		metaFileName: VFS_META_FILE,
		eagerLoadLimit: EAGER_LIMIT,
		memoryOnlyPrefixes: ["/tmp", "/proc", "/dev", DOWNLOADS],
		shouldEagerLoad: (path, size) =>
			size <= EAGER_LIMIT &&
			(path.startsWith(`${USER_DATA}/`) ||
				(!!vaultPath && (path === vaultPath || path.startsWith(`${vaultPath}/`)))),
	});
	setVfs(vfs);
	addEventListener("pagehide", () => void vfs.flush());
	for (const dir of [HOME, DOCUMENTS, DESKTOP, DOWNLOADS, USER_DATA, TEMP]) {
		vfs.fs.mkdirSync(dir, { recursive: true });
	}
	watchDownloads(window);
	takePendingVaultMessage(window);
	applyIcon(window);

	navigator.serviceWorker?.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
		const data = event.data;
		if (data?.type !== "vfs-read") {
			return;
		}
		vfs.fs.promises.readFile(data.path).then(
			(content) => {
				const bytes = new Uint8Array(content);
				notifyWorker({ type: "vfs-read-result", id: data.id, data: bytes.buffer }, [bytes.buffer]);
			},
			() => notifyWorker({ type: "vfs-read-result", id: data.id, data: null }),
		);
	});
	navigator.serviceWorker?.startMessages();

	notifyWorker({ type: "runtime-ready" });
	const scripts = opened.scripts[`/${pageName()}`];
	if (!scripts) {
		throw new Error(`No bundled scripts for ${pageName()}`);
	}
	// Dependencies and the renderer load only after the virtual filesystem and IPC are ready.
	showLoading("Loading Obsidian…");
	for (const src of scripts) {
		await new Promise<void>((resolve, reject) => {
			const script = document.createElement("script");
			script.src = src;
			script.onload = () => resolve();
			script.onerror = () => reject(new Error(`Unable to load ${src}`));
			document.body.appendChild(script);
		});
	}
	hideLoading();
}

registerNodeModules();
registerMainHandlers();
prepareWindow(window, false);
if (pageName() === "index.html") {
	onAppCreated(window, applyWebDefaults);
} else if (pageName() === "starter.html") {
	enhanceStarter(window);
}

initialize().catch(showFatalError);
