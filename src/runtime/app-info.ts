import type { BundleInfo } from "../shared/bundle.ts";

let opened: BundleInfo | null = null;

export function setOpenedApp(app: BundleInfo): void {
	opened = app;
}

export function getOpenedApp(): BundleInfo {
	if (!opened) {
		throw new Error("The Obsidian bundle has not loaded");
	}
	return opened;
}

export const DEFAULT_POLICY = {
	policy: {
		plugins: true,
		corePlugins: {},
		communityPlugins: [],
		privatePlugins: [],
		themes: true,
		snippets: true,
		devTools: true,
		insider: false,
	},
	status: "not managed",
	source: "",
	diagnostics: [],
};
