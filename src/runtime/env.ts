/** Emulated host environment. Paths live in the OPFS backed virtual file system. */
export const HOME = "/home/user";
export const USERNAME = "user";
export const HOSTNAME = "obsidian-web";
export const USER_DATA = `${HOME}/.config/obsidian`;
export const DOCUMENTS = `${HOME}/Documents`;
export const DESKTOP = `${HOME}/Desktop`;
export const DOWNLOADS = `${HOME}/Downloads`;
export const TEMP = "/tmp";
export const TRASH = `${HOME}/.local/share/Trash/files`;
export const APP_PATH = "/opt/obsidian/resources/obsidian.asar";
export const EXEC_PATH = "/opt/obsidian/obsidian";
export const DEFAULT_VAULT = `${DOCUMENTS}/Obsidian Vault`;
export const SANDBOX_VAULT = `${USER_DATA}/Obsidian Sandbox`;

/** Electron major version reported to the app. Obsidian switches code paths on it (clipboard APIs, webUtils). */
export const ELECTRON_VERSION = "44.0.0";
export const NODE_VERSION = "24.11.0";

const ua = navigator.userAgent;
export const IS_MAC = /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua);
export const IS_WINDOWS_HOST = /Windows/.test(ua);
/** Windows path semantics are not emulated, so Windows hosts are reported as Linux. */
export const PLATFORM: "darwin" | "linux" = IS_MAC ? "darwin" : "linux";

export function chromeVersion(): string {
	const match = /Chrom(?:e|ium)\/([\d.]+)/.exec(ua);
	return match?.[1] ?? "142.0.0.0";
}

export const APP_ORIGIN = location.origin;

export function currentVaultId(win: Window = window): string | null {
	try {
		return new URL(win.location.href).searchParams.get("vault");
	} catch {
		return null;
	}
}

export function pageName(win: Window = window): string {
	const path = win.location.pathname;
	return path.slice(path.lastIndexOf("/") + 1) || "index.html";
}
