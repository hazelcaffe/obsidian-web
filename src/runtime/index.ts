import type { ClientMessage, WorkerMessage } from "../shared/constants.ts";
import { getOpfsRoot, OPFS_VFS_DIR, openInstalledApp, VFS_META_FILE } from "../shared/install.ts";
import { createFs } from "../vfs/index.ts";
import { applyWebDefaults, onAppCreated } from "./app-hooks.ts";
import { setOpenedApp } from "./app-info.ts";
import { watchDownloads } from "./downloads.ts";
import { applyIcon, readConfig, registerMainHandlers, takePendingVaultMessage } from "./electron/main.ts";
import { checkForUpdates, setUpdatesDisabled } from "./electron/updater.ts";
import { currentVaultId, DESKTOP, DOCUMENTS, DOWNLOADS, HOME, pageName, TEMP, USER_DATA } from "./env.ts";
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
	const show = (): void => {
		const box = document.createElement("div");
		box.style.cssText =
			"position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#1e1e1e;color:#ddd;font:14px system-ui;padding:24px;";
		const message = error instanceof Error ? error.message : String(error);
		box.innerHTML = `<div style="max-width:560px"><h2>Obsidian Web failed to start</h2><p></p><p><a href="/?setup" style="color:#a88bfa">Open setup</a> · <a href="" style="color:#a88bfa">Reload</a></p></div>`;
		(box.querySelector("p") as HTMLElement).textContent = message;
		document.body.appendChild(box);
	};
	if (document.body) {
		show();
	} else {
		document.addEventListener("DOMContentLoaded", show, { once: true });
	}
}

async function initialize(): Promise<void> {
	const opened = await openInstalledApp();
	if (!opened) {
		location.replace("/");
		await new Promise(() => undefined);
		return;
	}
	setOpenedApp(opened);
	setAppVersion(opened.info.version);

	const opfs = await getOpfsRoot();
	const vfsRoot = await opfs.getDirectoryHandle(OPFS_VFS_DIR, { create: true });
	const vaultPath = await readVaultPath(vfsRoot, currentVaultId());
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

	if (pageName() === "index.html") {
		const config = readConfig();
		setUpdatesDisabled(!!config.updateDisabled);
		setTimeout(() => void checkForUpdates(false), 30_000);
	}
}

registerNodeModules();
registerMainHandlers();
prepareWindow(window, false);
if (pageName() === "index.html") {
	onAppCreated(window, applyWebDefaults);
} else if (pageName() === "starter.html") {
	enhanceStarter(window);
}

initialize().then(() => notifyWorker({ type: "runtime-ready" }), showFatalError);
