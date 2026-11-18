import { defaultWispUrl, getWispUrl, normalizeWispUrl, setWispUrl } from "../shared/network-config.ts";
import { getVfs } from "./vfs-instance.ts";

interface SettingTab {
	id: string;
	name: string;
	icon: string;
	containerEl: HTMLElement;
	display(): void;
}

interface Settings {
	settingTabs: SettingTab[];
	addSettingTab(tab: SettingTab): void;
}

interface AppWithSettings {
	setting?: Settings;
}

/** Register as a built-in settings tab, using Obsidian's SettingTab base class without a community plugin. */
function registerSettings(app: AppWithSettings, settings: Settings): void {
	if (settings.settingTabs.some((tab) => tab.id === "obsidian-web")) {
		return;
	}
	const first = settings.settingTabs[0];
	let proto: object | null = first ? Object.getPrototypeOf(first) : null;
	while (proto && !Object.hasOwn(proto, "renderTab")) {
		proto = Object.getPrototypeOf(proto);
	}
	if (!proto) {
		throw new Error("Unable to locate Obsidian's SettingTab class");
	}
	const Base = proto.constructor as new (app: AppWithSettings, settings: Settings) => SettingTab;
	class WebSettings extends Base {
		override id = "obsidian-web";
		override name = "Obsidian Web";
		override icon = "globe";

		override display(): void {
			const container = this.containerEl;
			const doc = container.ownerDocument;
			container.replaceChildren();
			const heading = doc.createElement("h2");
			heading.textContent = "Obsidian Web";
			const row = doc.createElement("div");
			row.className = "setting-item";
			const info = doc.createElement("div");
			info.className = "setting-item-info";
			const name = doc.createElement("div");
			name.className = "setting-item-name";
			name.textContent = "Wisp proxy URL";
			const description = doc.createElement("div");
			description.className = "setting-item-description";
			description.textContent =
				"Optional networking for Sync and plugins that need unrestricted requests. Leave empty for normal browser networking. Local vaults work without a proxy.";
			info.append(name, description);
			const controls = doc.createElement("div");
			controls.className = "setting-item-control";
			controls.style.flexWrap = "wrap";
			const input = doc.createElement("input");
			input.type = "url";
			input.setAttribute("aria-label", "Wisp proxy URL");
			input.value = getWispUrl();
			input.placeholder = "None";
			input.spellcheck = false;
			const save = doc.createElement("button");
			save.textContent = "Save and reload";
			save.className = "mod-cta";
			const reset = doc.createElement("button");
			reset.textContent = "Use default";
			const status = doc.createElement("p");
			status.className = "setting-item-description";
			status.setAttribute("role", "status");
			status.textContent = `Default: ${defaultWispUrl() || "none"}. Saved for this browser and origin.`;
			const apply = async (value: string | null): Promise<void> => {
				try {
					// Validate before saving; malformed values never reach libcurl.js.
					const normalized = value === null ? null : normalizeWispUrl(value);
					await getVfs().flush();
					setWispUrl(normalized);
					window.location.reload();
				} catch (error) {
					status.textContent = error instanceof Error ? error.message : String(error);
				}
			};
			save.addEventListener("click", () => void apply(input.value));
			reset.addEventListener("click", () => void apply(null));
			controls.append(input, save, reset);
			row.append(info, controls);
			container.append(heading, row, status);
		}
	}
	settings.addSettingTab(new WebSettings(app, settings));
}

/** Settings are constructed asynchronously after window.app is assigned. */
export function observeSettings(app: AppWithSettings): void {
	const install = (settings: Settings): void => {
		queueMicrotask(() => {
			try {
				registerSettings(app, settings);
			} catch (error) {
				console.error("[obsidian-web] Unable to register settings", error);
			}
		});
	};
	if (app.setting) {
		install(app.setting);
		return;
	}
	Object.defineProperty(app, "setting", {
		configurable: true,
		enumerable: true,
		get: () => undefined,
		set(value: Settings) {
			Object.defineProperty(app, "setting", { value, writable: true, configurable: true, enumerable: true });
			install(value);
		},
	});
}
