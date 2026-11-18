import type { OpenedApp } from "../shared/install.ts";

let opened: OpenedApp | null = null;

export function setOpenedApp(app: OpenedApp): void {
	opened = app;
}

export function getOpenedApp(): OpenedApp {
	if (!opened) {
		throw new Error("Obsidian is not installed");
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
