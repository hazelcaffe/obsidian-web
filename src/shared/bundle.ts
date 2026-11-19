import { appUrl } from "./paths.ts";

export interface BundleInfo {
	version: string;
	basePath: string;
	terms: string;
	scripts: Record<string, string[]>;
	sandbox: string[];
}

export const BUNDLE_INFO_URL = appUrl("obsidian-web/app.json");

/** Marks generated app pages, distinguishing them from pages served by an older service worker. */
export const BUNDLE_MARKER = "obsidian-web-bundled";
