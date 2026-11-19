import pathModule from "path-browserify";
import { VFS_URL_PREFIX } from "../../shared/constants.ts";
import { appUrl } from "../../shared/paths.ts";
import { LAST_VAULT_KEY } from "../../shared/storage-keys.ts";
import { DEFAULT_POLICY, getOpenedApp } from "../app-info.ts";
import {
	currentVaultId,
	DEFAULT_VAULT,
	DESKTOP,
	DOCUMENTS,
	pageName,
	SANDBOX_VAULT,
	TRASH,
	USER_DATA,
} from "../env.ts";
import { performRequest, type RequestUrlParams } from "../net/request.ts";
import { getVfs } from "../vfs-instance.ts";
import { BrowserWindowShim } from "./browser-window.ts";
import { dialog } from "./dialog.ts";
import { type IpcMainEvent, ipcMain } from "./ipc.ts";
import { Menu, type MenuItemOptions } from "./menu.ts";

interface VaultEntry {
	path: string;
	ts: number;
	open?: boolean;
}

interface MainConfig {
	vaults?: Record<string, VaultEntry>;
	frame?: string;
	language?: string;
	updateDisabled?: boolean;
	disableGpu?: boolean;
	adblock?: string[];
	adblockFrequency?: number;
	icon?: string;
	[key: string]: unknown;
}

const CONFIG_PATH = `${USER_DATA}/obsidian.json`;
const ICON_KEY = "obsidian-web:icon";
const POPUP_TOKEN = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(
	"",
);
const ADBLOCK_DEFAULT = ["https://easylist.to/easylist/easylist.txt", "https://easylist.to/easylist/easyprivacy.txt"];

export function popupToken(): string {
	return POPUP_TOKEN;
}

function randomId(length: number): string {
	return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

export function readConfig(): MainConfig {
	const fs = getVfs().fs;
	try {
		const parsed = JSON.parse(String(fs.readFileSync(CONFIG_PATH, "utf8"))) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as MainConfig) : {};
	} catch {
		return {};
	}
}

export function writeConfig(config: MainConfig): void {
	const fs = getVfs().fs;
	fs.mkdirSync(USER_DATA, { recursive: true });
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(config));
}

function vaults(config: MainConfig): Record<string, VaultEntry> {
	config.vaults ??= {};
	return config.vaults;
}

export function findVaultByPath(path: string): string | null {
	const resolved = pathModule.resolve(path);
	for (const [id, vault] of Object.entries(vaults(readConfig()))) {
		if (vault.path === resolved) {
			return id;
		}
	}
	return null;
}

export function getVaultPath(id: string): string | null {
	return vaults(readConfig())[id]?.path ?? null;
}

/** The tab or popout's top level window, whose URL identifies the vault. */
function rootWindow(win: Window): Window {
	let current = win;
	while (current.opener && current.location.href === "about:blank") {
		current = current.opener as Window;
	}
	return current;
}

const navigating = new WeakSet<Window>();

export function isNavigating(win: Window): boolean {
	return navigating.has(win);
}

/** Navigates once pending writes are in OPFS, so that the next page mounts an up to date file system. */
function navigate(win: Window, url: string): void {
	navigating.add(win);
	getVfs()
		.flush()
		.catch((error: unknown) => console.error(error))
		.finally(() => win.location.assign(url));
}

function openTab(win: Window, url: string, name: string): void {
	const tab = win.open("about:blank", name);
	if (!tab) {
		navigate(win, url);
		return;
	}
	getVfs()
		.flush()
		.catch((error: unknown) => console.error(error))
		.finally(() => tab.location.replace(url));
}

function vaultUrl(id: string): string {
	return appUrl(`index.html?vault=${encodeURIComponent(id)}`);
}

function isAppStarted(win: Window): boolean {
	return pageName(win) === "index.html" && !!(win as Window & { app?: unknown }).app;
}

/** Opens a vault like Electron's main process: the starter turns into the vault, other windows open a new tab. */
export function openVault(path: string, sender: Window): true | string {
	const fs = getVfs().fs;
	const resolved = pathModule.resolve(path);
	try {
		if (!fs.statSync(resolved).isDirectory()) {
			return "folder not found";
		}
	} catch {
		return "folder not found";
	}
	const config = readConfig();
	const list = vaults(config);
	let id = Object.keys(list).find((key) => list[key]?.path === resolved);
	if (id) {
		(list[id] as VaultEntry).ts = Date.now();
	} else {
		id = randomId(16);
		list[id] = { path: resolved, ts: Date.now() };
	}
	writeConfig(config);
	const win = rootWindow(sender);
	if (currentVaultId(win) === id && isAppStarted(win)) {
		win.focus();
		return true;
	}
	if (isAppStarted(win) || pageName(win) === "help.html") {
		openTab(win, vaultUrl(id), `vault-${id}`);
	} else {
		navigate(win, vaultUrl(id));
	}
	return true;
}

export function openStarter(sender: Window): void {
	const win = rootWindow(sender);
	if (isAppStarted(win)) {
		openTab(win, appUrl("starter.html"), "obsidian-starter");
	} else {
		navigate(win, appUrl("starter.html"));
	}
}

function pendingMessageKey(id: string): string {
	return `obsidian-web:vault-message:${id}`;
}

const actionChannel = new BroadcastChannel("obsidian-web-actions");

/** Delivers an `OBS_ACT` message (obsidian:// actions, setup requests) to the window of a vault. */
export function sendVaultMessage(id: string, message: unknown): void {
	if (currentVaultId(window) === id && isAppStarted(window)) {
		deliverAction(window, message);
		return;
	}
	localStorage.setItem(pendingMessageKey(id), JSON.stringify(message));
	actionChannel.postMessage({ id, message });
}

function deliverAction(win: Window, message: unknown): void {
	const target = win as Window & { OBS_ACT?: unknown };
	if (typeof target.OBS_ACT === "function") {
		(target.OBS_ACT as (message: unknown) => void)(message);
	} else {
		target.OBS_ACT = message;
	}
}

/** Called before the app starts: hands over messages queued for this vault. */
export function takePendingVaultMessage(win: Window): void {
	const id = currentVaultId(win);
	if (!id) {
		return;
	}
	const raw = localStorage.getItem(pendingMessageKey(id));
	if (raw) {
		localStorage.removeItem(pendingMessageKey(id));
		try {
			deliverAction(win, JSON.parse(raw));
		} catch {}
	}
	actionChannel.addEventListener("message", (event: MessageEvent<{ id: string; message: unknown }>) => {
		if (event.data.id === id && isAppStarted(win)) {
			localStorage.removeItem(pendingMessageKey(id));
			deliverAction(win, event.data.message);
		}
	});
}

/** Handles `obsidian://` URLs the way the desktop app's protocol handler does. */
export function handleObsidianUrl(url: string, sender: Window): void {
	const rest = url.slice("obsidian://".length);
	let action: Record<string, string> = {};
	if (rest.startsWith("/")) {
		action = { action: "open", path: decodeURI(rest) };
	} else if (rest.startsWith("choose-vault") || rest.startsWith("sync-setup")) {
		openStarter(sender);
		return;
	} else if (rest.startsWith("vault/")) {
		const parts = rest.slice(6).split("/").map(decodeURIComponent);
		action = { action: "open", vault: parts[0] ?? "", file: parts.slice(1).join("/") };
	} else {
		const queryIndex = rest.indexOf("?");
		const name = (queryIndex >= 0 ? rest.slice(0, queryIndex) : rest).replace(/\/+$/, "");
		action = { action: name };
		if (queryIndex >= 0) {
			for (const part of rest.slice(queryIndex + 1).split("&")) {
				const eq = part.indexOf("=");
				const key = decodeURIComponent(eq >= 0 ? part.slice(0, eq) : part);
				if (key) {
					action[key] = eq >= 0 ? decodeURIComponent(part.slice(eq + 1)) : "true";
				}
			}
		}
	}
	const list = vaults(readConfig());
	let target: string | null = null;
	if (action.path) {
		const resolved = pathModule.resolve(action.path);
		let best = "";
		for (const [id, vault] of Object.entries(list)) {
			if ((resolved === vault.path || resolved.startsWith(`${vault.path}/`)) && vault.path.length > best.length) {
				best = vault.path;
				target = id;
			}
		}
		if (target) {
			action.file = resolved.slice(best.length);
		}
	} else if (action.vault) {
		const wanted = action.vault;
		target =
			Object.keys(list).find(
				(id) =>
					id === wanted || pathModule.basename(list[id]?.path ?? "").toUpperCase() === wanted.toUpperCase(),
			) ?? null;
		delete action.vault;
	} else {
		target = currentVaultId(rootWindow(sender)) ?? localStorage.getItem(LAST_VAULT_KEY);
	}
	if (!target || !list[target]) {
		sender.alert(`Unable to find a vault for the URL ${url}`);
		return;
	}
	sendVaultMessage(target, action);
	const vaultPath = list[target]?.path;
	if (vaultPath && currentVaultId(rootWindow(sender)) !== target) {
		openVault(vaultPath, sender);
	}
}

export function vfsUrl(path: string): string {
	return `${location.origin}${VFS_URL_PREFIX}${pathModule
		.resolve(path)
		.split("/")
		.filter(Boolean)
		.map(encodeURIComponent)
		.join("/")}`;
}

/** `shell.openExternal`: web links open in a new browser tab, `obsidian://` links are handled in the app. */
export function openExternal(url: string, sender: Window = window): void {
	if (url.startsWith("obsidian://")) {
		handleObsidianUrl(url, sender);
		return;
	}
	if (url.startsWith("file://")) {
		openPath(decodeURIComponent(new URL(url).pathname), sender);
		return;
	}
	if (/^(https?|mailto|tel|ftp|magnet|web\+[a-z]+):/i.test(url)) {
		sender.open(url, "_blank", "noopener,noreferrer");
	}
}

export function openPath(path: string, sender: Window = window): string {
	try {
		if (getVfs().fs.statSync(path).isDirectory()) {
			return "Opening folders is not supported in the browser";
		}
	} catch {
		return "File not found";
	}
	sender.open(vfsUrl(path), "_blank", "noopener");
	return "";
}

export function trashItem(path: string): boolean {
	const fs = getVfs().fs;
	try {
		fs.mkdirSync(TRASH, { recursive: true });
		const base = pathModule.basename(path);
		let target = `${TRASH}/${base}`;
		for (let i = 2; fs.existsSync(target); i++) {
			target = `${TRASH}/${base} (${i})`;
		}
		fs.renameSync(path, target);
		return true;
	} catch (error) {
		console.error(error);
		return false;
	}
}

async function openSandbox(sender: Window): Promise<void> {
	const fs = getVfs().fs;
	const { sandbox } = getOpenedApp();
	await fs.promises.rm(SANDBOX_VAULT, { recursive: true, force: true });
	await fs.promises.mkdir(SANDBOX_VAULT, { recursive: true });
	for (const relative of sandbox) {
		const destination = `${SANDBOX_VAULT}/${relative.slice("sandbox/".length)}`;
		await fs.promises.mkdir(pathModule.dirname(destination), { recursive: true });
		const response = await fetch(appUrl(relative.split("/").map(encodeURIComponent).join("/")));
		if (!response.ok) {
			throw new Error(`Unable to load ${relative}`);
		}
		const data = new Uint8Array(await response.arrayBuffer());
		await fs.promises.writeFile(destination, data);
	}
	openVault(SANDBOX_VAULT, sender);
}

let applicationMenu: Menu | null = null;
let lastContextTarget: EventTarget | null = null;

export function trackContextMenu(win: Window): void {
	win.addEventListener(
		"contextmenu",
		(event) => {
			lastContextTarget = event.target;
		},
		true,
	);
}

function editFlags(win: Window & typeof globalThis): Record<string, boolean> {
	const target = lastContextTarget as HTMLElement | null;
	const editable =
		!!target &&
		(target.isContentEditable ||
			target instanceof win.HTMLInputElement ||
			target instanceof win.HTMLTextAreaElement ||
			!!target.closest?.("[contenteditable=true], .cm-content"));
	const hasSelection = !!win.getSelection()?.toString();
	return {
		canUndo: editable,
		canRedo: editable,
		canCut: editable && hasSelection,
		canCopy: hasSelection,
		canPaste: editable,
		canDelete: editable && hasSelection,
		canSelectAll: true,
		canEditRichly: editable,
	};
}

function windowStateKey(id: string): string {
	return `obsidian-web:window:${id}`;
}

function senderWindow(event: IpcMainEvent): Window {
	return event.sender.win;
}

function set<T>(event: IpcMainEvent, value: T): void {
	event.returnValue = value;
}

export function registerMainHandlers(): void {
	const on = ipcMain.on;

	on("version", (event) => set(event, getOpenedApp().version));
	on("terms", (event) => set(event, getOpenedApp().terms));
	on("policy", (event) => set(event, DEFAULT_POLICY));
	on("file-url", (event) => set(event, `${location.origin}${VFS_URL_PREFIX}`));
	on("resources", (event) => set(event, "/opt/obsidian/resources/obsidian.asar"));
	on("plugin-script-root", (event) => set(event, null));
	on("popup-token", (event) => set(event, POPUP_TOKEN));
	on("is-quitting", (event) => set(event, false));
	on("is-closing", (event) => set(event, false));
	on("desktop-dir", (event) => set(event, DESKTOP));
	on("documents-dir", (event) => set(event, DOCUMENTS));
	on("get-documents-path", (event) => set(event, DOCUMENTS));
	on("get-default-vault-path", (event) => set(event, DEFAULT_VAULT));
	on("get-sandbox-vault-path", (event) => set(event, SANDBOX_VAULT));

	on("set-language", (event, language: string | null) => {
		const config = readConfig();
		if (language) {
			config.language = language;
		} else {
			delete config.language;
		}
		writeConfig(config);
		set(event, null);
	});

	on("relaunch", (event) => {
		set(event, "");
		const win = rootWindow(senderWindow(event));
		void getVfs()
			.flush()
			.finally(() => win.location.reload());
	});

	// Obsidian is part of the static build; updates are applied by rebuilding dist/.
	on("update", (event) => set(event, ""));
	on("latest-public-version", (event) => set(event, getOpenedApp().version));
	on("check-update", (event) => set(event, false));
	on("disable-update", (event) => set(event, true));
	on("insider-build", (event) => set(event, false));
	on("cli", (event) => set(event, false));
	on("copy-asar", (event) => set(event, false));
	on("disable-gpu", (event, value: boolean | null) => {
		const config = readConfig();
		if (value === true || value === false) {
			config.disableGpu = value || undefined;
			writeConfig(config);
		}
		set(event, !!config.disableGpu);
	});
	on("frame", (event, value: unknown) => {
		const config = readConfig();
		if (typeof value === "string") {
			if (value) {
				config.frame = value;
			} else {
				delete config.frame;
			}
			writeConfig(config);
		}
		set(event, config.frame ?? "native");
	});
	on("adblock-lists", (event, value: unknown) => {
		const config = readConfig();
		if (Array.isArray(value)) {
			config.adblock = value as string[];
			writeConfig(config);
		}
		set(event, config.adblock ?? ADBLOCK_DEFAULT);
	});
	on("adblock-frequency", (event, value: unknown) => {
		const config = readConfig();
		if (typeof value === "number") {
			config.adblockFrequency = value;
			writeConfig(config);
		}
		set(event, config.adblockFrequency ?? 4);
	});

	on("vault", (event) => {
		const id = currentVaultId(rootWindow(senderWindow(event)));
		const path = id ? getVaultPath(id) : null;
		if (id && path) {
			localStorage.setItem(LAST_VAULT_KEY, id);
			set(event, { id, path: pathModule.resolve(path) });
		} else {
			set(event, {});
		}
	});
	on("vault-list", (event) => set(event, structuredClone(vaults(readConfig()))));
	on("vault-open", (event, path: string, create: boolean) => {
		const fs = getVfs().fs;
		if (create) {
			if (fs.existsSync(path)) {
				set(event, "Vault already exists");
				return;
			}
			try {
				fs.mkdirSync(path, { recursive: true });
			} catch (error) {
				set(event, String(error));
				return;
			}
		}
		set(event, openVault(path, senderWindow(event)));
	});
	on("vault-remove", (event, path: string) => {
		const config = readConfig();
		const list = vaults(config);
		for (const [id, vault] of Object.entries(list)) {
			if (vault.path === path) {
				if (currentVaultId(rootWindow(senderWindow(event))) === id) {
					set(event, false);
					return;
				}
				delete list[id];
				writeConfig(config);
				localStorage.removeItem(windowStateKey(id));
				if (localStorage.getItem(LAST_VAULT_KEY) === id) {
					localStorage.removeItem(LAST_VAULT_KEY);
				}
				set(event, true);
				return;
			}
		}
		set(event, false);
	});
	on("vault-move", (event, from: string, to: string) => {
		const config = readConfig();
		for (const [id, vault] of Object.entries(vaults(config))) {
			if (vault.path === from) {
				if (currentVaultId(rootWindow(senderWindow(event))) === id) {
					set(event, "EVAULTOPEN");
					return;
				}
				try {
					getVfs().fs.renameSync(from, to);
				} catch (error) {
					set(event, String(error));
					return;
				}
				vault.path = pathModule.resolve(to);
				writeConfig(config);
				set(event, "");
				return;
			}
		}
		set(event, false);
	});
	on("vault-message", (event, path: string, message: unknown) => {
		const id = findVaultByPath(path);
		if (id) {
			sendVaultMessage(id, message);
		}
		set(event, "");
	});
	on("starter", (event) => {
		set(event, null);
		openStarter(senderWindow(event));
	});
	on("help", (event) => {
		set(event, null);
		senderWindow(event).open(appUrl("help.html"), "obsidian-help", "popup,width=600,height=680");
	});
	on("sandbox", (event) => {
		set(event, null);
		openSandbox(senderWindow(event)).catch((error: unknown) => console.error("Unable to open the sandbox", error));
	});

	on("startup", (event) => {
		const id = currentVaultId(senderWindow(event));
		if (!id) {
			set(event, null);
			return;
		}
		let state: { zoom?: number; appearance?: unknown } = {};
		try {
			state = JSON.parse(localStorage.getItem(windowStateKey(id)) ?? "{}") as typeof state;
		} catch {}
		set(event, { id, zoom: state.zoom ?? 0, appearance: state.appearance ?? null });
	});
	ipcMain.handle("startup-snapshot", () => null);
	ipcMain.handle("register-cli", () => ({
		success: false,
		message: "The command line interface is not available in the browser.",
	}));
	on("startup-snapshot-save", () => undefined);
	on("startup-appearance", (event, appearance: { theme?: string; followsSystem?: boolean; colors?: unknown }) => {
		const id = currentVaultId(rootWindow(senderWindow(event)));
		if (!id || !appearance) {
			return;
		}
		const key = windowStateKey(id);
		let state: Record<string, unknown> = {};
		try {
			state = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
		} catch {}
		state.appearance = {
			theme: appearance.theme === "theme-light" ? "theme-light" : "theme-dark",
			followsSystem: !!appearance.followsSystem,
			colors: appearance.colors,
		};
		localStorage.setItem(key, JSON.stringify(state));
	});

	on("trash", (event, path: string) => set(event, trashItem(path)));
	on("request-url", (event, replyChannel: string, params: RequestUrlParams) => {
		performRequest(params).then(
			(result) => event.reply(replyChannel, result),
			(error: unknown) => event.reply(replyChannel, { error }),
		);
	});
	on("open-url", (event, url: string) => {
		if (typeof url === "string") {
			openExternal(url, senderWindow(event));
		}
	});
	on("open-with-default-app", (event, url: string) => {
		if (typeof url === "string" && url.startsWith("file:")) {
			openExternal(url, senderWindow(event));
		}
	});
	on("open-file", (event, extensions: string[]) => {
		void (async () => {
			const win = senderWindow(event);
			const result = await dialog.showOpenDialog({
				properties: ["openFile"],
				filters: [{ name: "Supported files", extensions }],
			});
			const path = result.filePaths[0];
			if (!result.canceled && path) {
				const target = rootWindow(win) as Window & { OBS_OPEN_FILE?: unknown };
				if (typeof target.OBS_OPEN_FILE === "function") {
					(target.OBS_OPEN_FILE as (path: string) => void)(path);
				} else {
					target.OBS_OPEN_FILE = path;
				}
			}
		})();
	});

	on("context-menu", (event) => {
		const win = senderWindow(event) as Window & typeof globalThis;
		event.reply("context-menu", {
			editFlags: editFlags(win),
			misspelledWord: "",
			dictionarySuggestions: [],
			webContentsId: event.sender.id,
		});
	});
	on("print-to-pdf", (event) => {
		const win = rootWindow(senderWindow(event));
		setTimeout(() => {
			win.print();
			event.reply("print-to-pdf", {});
		}, 50);
	});

	on("set-menu", (event, payload: { template: MenuItemOptions[] }) => {
		applicationMenu = Menu.buildFromTemplate(payload?.template ?? []);
		const shim = BrowserWindowShim.fromWebContents(event.sender);
		if (shim) {
			shim.appMenu = applicationMenu;
		}
	});
	on("update-menu-items", (_event, items: Array<{ itemId: string; eState: Record<string, unknown> }>) => {
		for (const { itemId, eState } of items ?? []) {
			const item = applicationMenu?.getMenuItemById(itemId);
			if (item) {
				Object.assign(item, eState);
			}
		}
	});
	on("render-menu", () => applicationMenu?.popup());

	on("set-icon", (event, name: string | null, data: Uint8Array | null) => {
		if (name && data) {
			const ext = name.split(".").pop()?.toLowerCase() === "ico" ? "x-icon" : "png";
			let binary = "";
			for (const byte of new Uint8Array(data)) {
				binary += String.fromCharCode(byte);
			}
			localStorage.setItem(ICON_KEY, JSON.stringify({ name, url: `data:image/${ext};base64,${btoa(binary)}` }));
		} else {
			localStorage.removeItem(ICON_KEY);
		}
		applyIcon(rootWindow(senderWindow(event)));
		set(event, null);
	});
	on("get-icon", (event) => {
		try {
			set(
				event,
				(JSON.parse(localStorage.getItem(ICON_KEY) ?? "null") as { name?: string } | null)?.name ?? null,
			);
		} catch {
			set(event, null);
		}
	});
	on("create-browser-session", () => undefined);
}

export function applyIcon(win: Window): void {
	let url = appUrl("favicon.ico");
	try {
		url = (JSON.parse(win.localStorage.getItem(ICON_KEY) ?? "null") as { url?: string } | null)?.url ?? url;
	} catch {}
	let link = win.document.querySelector<HTMLLinkElement>("link[rel~='icon']");
	if (!link) {
		link = win.document.createElement("link");
		link.rel = "icon";
		win.document.head.appendChild(link);
	}
	link.href = url;
}

export function saveZoom(win: Window, level: number): void {
	const id = currentVaultId(win);
	if (!id) {
		return;
	}
	const key = windowStateKey(id);
	let state: Record<string, unknown> = {};
	try {
		state = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
	} catch {}
	state.zoom = level;
	localStorage.setItem(key, JSON.stringify(state));
}
