import { cbc } from "@noble/ciphers/aes.js";
import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { getOpenedApp } from "../app-info.ts";
import { APP_PATH, DESKTOP, DOCUMENTS, DOWNLOADS, EXEC_PATH, HOME, TEMP, USER_DATA } from "../env.ts";
import { curlFetch } from "../net/curl.ts";
import { loadModule } from "../node/registry.ts";
import { revealItem } from "../vault-transfer.ts";
import { BrowserWindowShim, getWindowShim, webContentsModule } from "./browser-window.ts";
import { remoteClipboard } from "./clipboard.ts";
import { dialog } from "./dialog.ts";
import { openExternal, openPath, trashItem } from "./main.ts";
import { Menu, MenuItem } from "./menu.ts";
import { nativeImage } from "./native-image.ts";
import { getSession } from "./session.ts";

const PATHS: Record<string, string> = {
	home: HOME,
	appData: `${HOME}/.config`,
	userData: USER_DATA,
	sessionData: USER_DATA,
	temp: TEMP,
	exe: EXEC_PATH,
	module: EXEC_PATH,
	desktop: DESKTOP,
	documents: DOCUMENTS,
	downloads: DOWNLOADS,
	music: `${HOME}/Music`,
	pictures: `${HOME}/Pictures`,
	videos: `${HOME}/Videos`,
	recent: `${HOME}/.local/share/recently-used`,
	logs: `${USER_DATA}/logs`,
	crashDumps: `${USER_DATA}/Crashpad`,
};

class App extends EventEmitter {
	readonly name = "Obsidian";
	readonly isPackaged = true;
	readonly commandLine = {
		appendSwitch() {},
		appendArgument() {},
		hasSwitch: () => false,
		getSwitchValue: () => "",
		removeSwitch() {},
	};
	readonly dock = {
		setIcon() {},
		setBadge() {},
		getBadge: () => "",
		bounce: () => 0,
		cancelBounce() {},
		hide() {},
		show: async () => undefined,
		isVisible: () => true,
		setMenu() {},
	};
	userAgentFallback = navigator.userAgent;
	accessibilitySupportEnabled = false;

	getVersion(): string {
		return getOpenedApp().version;
	}

	getName(): string {
		return this.name;
	}

	getLocale(): string {
		return navigator.language;
	}

	getSystemLocale(): string {
		return navigator.language;
	}

	getLocaleCountryCode(): string {
		return navigator.language.split("-")[1] ?? "";
	}

	getPreferredSystemLanguages(): string[] {
		return [...(navigator.languages ?? [navigator.language])];
	}

	getPath(name: string): string {
		const path = PATHS[name];
		if (!path) {
			throw new Error(`Failed to get '${name}' path`);
		}
		return path;
	}

	setPath(name: string, path: string): void {
		PATHS[name] = path;
	}

	getAppPath(): string {
		return APP_PATH;
	}

	isReady(): boolean {
		return true;
	}

	whenReady(): Promise<void> {
		return Promise.resolve();
	}

	quit(): void {
		window.close();
	}

	exit(): void {
		window.close();
	}

	relaunch(): void {
		location.reload();
	}

	focus(): void {
		window.focus();
	}

	hide(): void {}

	show(): void {}

	isHidden(): boolean {
		return document.hidden;
	}

	setBadgeCount(): boolean {
		return false;
	}

	getBadgeCount(): number {
		return 0;
	}

	addRecentDocument(): void {}

	clearRecentDocuments(): void {}

	setAsDefaultProtocolClient(): boolean {
		return false;
	}

	removeAsDefaultProtocolClient(): boolean {
		return false;
	}

	isDefaultProtocolClient(): boolean {
		return false;
	}

	getApplicationNameForProtocol(): string {
		return "";
	}

	requestSingleInstanceLock(): boolean {
		return true;
	}

	hasSingleInstanceLock(): boolean {
		return true;
	}

	releaseSingleInstanceLock(): void {}

	setAppUserModelId(): void {}

	setAboutPanelOptions(): void {}

	showAboutPanel(): void {}

	getGPUFeatureStatus(): Record<string, string> {
		return {};
	}

	async getGPUInfo(): Promise<Record<string, unknown>> {
		return {};
	}

	getAppMetrics(): unknown[] {
		return [];
	}

	disableHardwareAcceleration(): void {}

	isEmojiPanelSupported(): boolean {
		return false;
	}

	showEmojiPanel(): void {}

	setLoginItemSettings(): void {}

	getLoginItemSettings(): Record<string, boolean> {
		return { openAtLogin: false };
	}

	async getFileIcon(): Promise<unknown> {
		return nativeImage.createEmpty();
	}
}

export const app = new App();

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

class NativeTheme extends EventEmitter {
	themeSource: "system" | "light" | "dark" = "system";
	readonly shouldUseHighContrastColors = false;
	readonly shouldUseInvertedColorScheme = false;
	readonly inForcedColorsMode = false;
	readonly prefersReducedTransparency = false;

	constructor() {
		super();
		darkQuery.addEventListener("change", () => this.emit("updated"));
	}

	get shouldUseDarkColors(): boolean {
		return this.themeSource === "system" ? darkQuery.matches : this.themeSource === "dark";
	}
}

export const nativeTheme = new NativeTheme();

function display(): Record<string, unknown> {
	const s = window.screen as Screen & { availLeft?: number; availTop?: number };
	const bounds = { x: 0, y: 0, width: s.width, height: s.height };
	const workArea = { x: s.availLeft ?? 0, y: s.availTop ?? 0, width: s.availWidth, height: s.availHeight };
	return {
		id: 1,
		label: "Browser",
		bounds,
		workArea,
		size: { width: bounds.width, height: bounds.height },
		workAreaSize: { width: workArea.width, height: workArea.height },
		scaleFactor: window.devicePixelRatio,
		rotation: 0,
		internal: false,
		monochrome: false,
		accelerometerSupport: "unknown",
		touchSupport: "unknown",
		colorDepth: s.colorDepth,
		colorSpace: "",
		depthPerComponent: 8,
		displayFrequency: 60,
		detected: true,
	};
}

let cursor = { x: 0, y: 0 };
window.addEventListener("pointermove", (event) => {
	cursor = { x: event.screenX, y: event.screenY };
});

export const screen = Object.assign(new EventEmitter(), {
	getPrimaryDisplay: display,
	getAllDisplays: () => [display()],
	getDisplayNearestPoint: display,
	getDisplayMatching: display,
	getCursorScreenPoint: () => cursor,
	screenToDipPoint: (point: { x: number; y: number }) => point,
	dipToScreenPoint: (point: { x: number; y: number }) => point,
});

export const systemPreferences = Object.assign(new EventEmitter(), {
	getUserDefault: (_key: string, type?: string) =>
		type === "boolean" ? false : type === "integer" || type === "float" ? 0 : "",
	setUserDefault: () => undefined,
	getAccentColor: () => "8a5cf5ff",
	getColor: () => "#000000",
	getSystemColor: () => "#000000",
	isDarkMode: () => darkQuery.matches,
	isSwipeTrackingFromScrollEventsEnabled: () => false,
	isAeroGlassEnabled: () => false,
	getEffectiveAppearance: () => (darkQuery.matches ? "dark" : "light"),
	getAnimationSettings: () => ({
		shouldRenderRichAnimations: true,
		scrollAnimationsEnabledBySystem: true,
		prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	}),
	canPromptTouchID: () => false,
	isTrustedAccessibilityClient: () => false,
	getMediaAccessStatus: () => "granted",
	askForMediaAccess: async () => true,
	subscribeNotification: () => 0,
	unsubscribeNotification: () => undefined,
	subscribeLocalNotification: () => 0,
	unsubscribeLocalNotification: () => undefined,
	subscribeWorkspaceNotification: () => 0,
	unsubscribeWorkspaceNotification: () => undefined,
	postNotification: () => undefined,
	registerDefaults: () => undefined,
	removeUserDefault: () => undefined,
});

const SAFE_STORAGE_KEY = "obsidian-web:safe-storage-key";

function safeStorageKey(): Uint8Array {
	let stored = localStorage.getItem(SAFE_STORAGE_KEY);
	if (!stored) {
		stored = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
		localStorage.setItem(SAFE_STORAGE_KEY, stored);
	}
	return new Uint8Array(Buffer.from(stored, "base64"));
}

/**
 * Electron's `safeStorage`. There is no OS keychain in the browser: secrets are encrypted with a key kept in this
 * origin's storage, which protects them from casual inspection of the vault but not from code running in the page.
 */
export const safeStorage = {
	isEncryptionAvailable: () => true,
	isAsyncEncryptionAvailable: async () => true,
	getSelectedStorageBackend: () => "basic_text",
	setUsePlainTextEncryption: () => undefined,
	encryptString(text: string): Buffer {
		const iv = crypto.getRandomValues(new Uint8Array(16));
		const encrypted = cbc(safeStorageKey(), iv).encrypt(new TextEncoder().encode(text));
		return Buffer.concat([Buffer.from("owv1"), Buffer.from(iv), Buffer.from(encrypted)]);
	},
	decryptString(data: Uint8Array): string {
		const buffer = Buffer.from(data);
		if (buffer.subarray(0, 4).toString() !== "owv1") {
			throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
		}
		const plain = cbc(safeStorageKey(), buffer.subarray(4, 20)).decrypt(buffer.subarray(20));
		return new TextDecoder().decode(plain);
	},
	encryptStringAsync: async (text: string) => safeStorage.encryptString(text),
	decryptStringAsync: async (data: Uint8Array) => ({
		result: safeStorage.decryptString(data),
		shouldReEncrypt: false,
	}),
};

export const shell = {
	openExternal: async (url: string): Promise<void> => openExternal(url),
	openPath: async (path: string): Promise<string> => openPath(path),
	showItemInFolder: (path: string): void => {
		revealItem(window, path).catch((error: unknown) =>
			console.error("[obsidian-web] Unable to export", path, error),
		);
	},
	trashItem: async (path: string): Promise<void> => {
		if (!trashItem(path)) {
			throw new Error(`Failed to move ${path} to the trash`);
		}
	},
	beep: (): void => undefined,
	readShortcutLink: (): never => {
		throw new Error("Not supported");
	},
	writeShortcutLink: (): boolean => false,
};

class Notification extends EventEmitter {
	readonly #options: { title?: string; body?: string; silent?: boolean };
	#native: globalThis.Notification | null = null;

	constructor(options: { title?: string; body?: string; silent?: boolean } = {}) {
		super();
		this.#options = options;
	}

	static isSupported(): boolean {
		return "Notification" in window;
	}

	show(): void {
		const show = (): void => {
			this.#native = new window.Notification(this.#options.title ?? "Obsidian", {
				body: this.#options.body ?? "",
				silent: !!this.#options.silent,
			});
			this.#native.onclick = () => this.emit("click");
			this.#native.onclose = () => this.emit("close");
			this.emit("show");
		};
		if (window.Notification.permission === "granted") {
			show();
		} else if (window.Notification.permission !== "denied") {
			window.Notification.requestPermission().then((permission) => permission === "granted" && show());
		}
	}

	close(): void {
		this.#native?.close();
	}
}

const powerSaveBlockers = new Map<number, WakeLockSentinel | null>();
let nextBlocker = 1;

export const powerSaveBlocker = {
	start(): number {
		const id = nextBlocker++;
		powerSaveBlockers.set(id, null);
		navigator.wakeLock
			?.request("screen")
			.then((lock) => powerSaveBlockers.set(id, lock))
			.catch(() => undefined);
		return id;
	},
	stop(id: number): void {
		void powerSaveBlockers.get(id)?.release();
		powerSaveBlockers.delete(id);
	},
	isStarted: (id: number): boolean => powerSaveBlockers.has(id),
};

const NOT_METHODS = new Set([
	"then",
	"toJSON",
	"constructor",
	"prototype",
	"valueOf",
	"toString",
	"inspect",
	"nodeType",
	"$$typeof",
	"length",
	"name",
]);

function unsupported(name: string) {
	return new Proxy(
		{},
		{
			get(_target, property) {
				if (typeof property === "symbol" || NOT_METHODS.has(property)) {
					return undefined;
				}
				return () => {
					console.warn(`[obsidian-web] electron.${name}.${String(property)} is not supported in the browser`);
				};
			},
		},
	);
}

const sessionModule = {
	get defaultSession() {
		return getSession("default");
	},
	fromPartition: (partition: string) => getSession(partition || "default"),
	fromPath: (path: string) => getSession(path),
};

/** A BrowserWindow created from the page opens a browser popup window. */
function createBrowserWindowClass() {
	const BrowserWindow = function BrowserWindow(
		options: { width?: number; height?: number; x?: number; y?: number } = {},
	) {
		const features = ["popup"];
		if (options.width) {
			features.push(`width=${options.width}`);
		}
		if (options.height) {
			features.push(`height=${options.height}`);
		}
		const win = window.open("about:blank", "_blank", features.join(","));
		if (!win) {
			throw new Error("The popup window was blocked by the browser");
		}
		return getWindowShim(win, true);
	} as unknown as typeof BrowserWindowShim;
	Object.assign(BrowserWindow, {
		fromWebContents: BrowserWindowShim.fromWebContents,
		fromId: BrowserWindowShim.fromId,
		getAllWindows: BrowserWindowShim.getAllWindows,
		getFocusedWindow: BrowserWindowShim.getFocusedWindow,
		fromBrowserView: () => null,
	});
	Object.defineProperty(BrowserWindow, Symbol.hasInstance, {
		value: (value: unknown) => value instanceof BrowserWindowShim,
	});
	return BrowserWindow;
}

const BrowserWindow = createBrowserWindowClass();

export function createRemote(win: Window): Record<string, unknown> {
	const current = getWindowShim(win);
	const remote: Record<string, unknown> = {
		app,
		BrowserWindow,
		BrowserView: unsupported("BrowserView"),
		WebContentsView: unsupported("WebContentsView"),
		dialog,
		shell,
		Menu,
		MenuItem,
		clipboard: remoteClipboard,
		nativeImage,
		nativeTheme,
		screen,
		session: sessionModule,
		systemPreferences,
		safeStorage,
		powerSaveBlocker,
		powerMonitor: Object.assign(new EventEmitter(), {
			getSystemIdleState: () => "active",
			getSystemIdleTime: () => 0,
			isOnBatteryPower: () => false,
			onBatteryPower: false,
		}),
		Notification,
		net: {
			fetch: (url: string, init?: RequestInit) => curlFetch(url, init),
			isOnline: () => navigator.onLine,
			online: navigator.onLine,
			request: unsupported("net.request"),
		},
		protocol: getSession("default").protocol,
		webContents: webContentsModule,
		globalShortcut: { register: () => false, unregister() {}, unregisterAll() {}, isRegistered: () => false },
		desktopCapturer: { getSources: async () => [] },
		autoUpdater: Object.assign(new EventEmitter(), { checkForUpdates() {}, quitAndInstall() {}, setFeedURL() {} }),
		crashReporter: {
			start() {},
			getLastCrashReport: () => null,
			getUploadedReports: () => [],
			addExtraParameter() {},
		},
		Tray: unsupported("Tray"),
		TouchBar: unsupported("TouchBar"),
		inAppPurchase: unsupported("inAppPurchase"),
		ShareMenu: unsupported("ShareMenu"),
		process: (win as Window & { process?: unknown }).process,
		getCurrentWindow: () => current,
		getCurrentWebContents: () => current.webContents,
		getGlobal: (name: string) => (globalThis as Record<string, unknown>)[name],
		require: (name: string): unknown => {
			if (name === "electron") {
				return { ...remote, ClipboardItem: window.ClipboardItem };
			}
			if (name === "buffer") {
				return { Buffer, Blob: window.Blob, File: window.File };
			}
			return loadModule(win, name);
		},
		enable: () => undefined,
		initialize: () => undefined,
		isInitialized: () => true,
	};
	return remote;
}
