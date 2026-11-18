interface ObsidianVault {
	config: Record<string, unknown>;
	getConfig(key: string): unknown;
}

interface ObsidianApp {
	vault?: ObsidianVault;
}

/**
 * Defaults that differ from the desktop app. They only apply while the vault has no explicit value, so the vault's
 * config files are left untouched. Settings open in a separate window on desktop; browser popups are blocked without
 * a user gesture and look out of place, so settings stay in the page.
 */
const WEB_DEFAULTS: Record<string, unknown> = {
	settingsPopoutWindow: false,
};

/** Calls `callback` as soon as the app object is assigned to `window.app`. */
export function onAppCreated(win: Window, callback: (app: ObsidianApp) => void): void {
	Object.defineProperty(win, "app", {
		configurable: true,
		enumerable: true,
		get: () => undefined,
		set(value: ObsidianApp) {
			Object.defineProperty(win, "app", { value, writable: true, configurable: true, enumerable: true });
			try {
				callback(value);
			} catch (error) {
				console.error("[obsidian-web] App hook failed", error);
			}
		},
	});
}

export function applyWebDefaults(app: ObsidianApp): void {
	const vault = app.vault;
	if (!vault) {
		return;
	}
	const getConfig = vault.getConfig.bind(vault);
	vault.getConfig = (key: string): unknown =>
		Object.hasOwn(WEB_DEFAULTS, key) && vault.config?.[key] === undefined ? WEB_DEFAULTS[key] : getConfig(key);
}
