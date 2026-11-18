import { installArchive } from "../../shared/install.ts";
import { getOpenedApp } from "../app-info.ts";
import { curlFetch } from "../net/curl.ts";

const LATEST_RELEASE = "https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest";
const LAST_CHECK_KEY = "obsidian-web:last-update-check";
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;

interface UpdateState {
	status: "" | "update-downloaded" | "update-manual-required";
	latestVersion: string;
	checking: boolean;
	disabled: boolean;
}

const state: UpdateState = { status: "", latestVersion: "", checking: false, disabled: false };

export function getUpdateState(): Readonly<UpdateState> {
	return state;
}

export function setUpdatesDisabled(disabled: boolean): void {
	state.disabled = disabled;
}

function compareVersions(a: string, b: string): number {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

interface Release {
	tag_name: string;
	assets: Array<{ name: string; browser_download_url: string }>;
}

/** Downloads a newer `obsidian.asar` into OPFS, like the desktop app's self updater. It applies on relaunch. */
export async function checkForUpdates(force: boolean): Promise<void> {
	if (state.checking || (state.disabled && !force) || state.status === "update-downloaded") {
		return;
	}
	if (!force && Date.now() - Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0) < CHECK_INTERVAL) {
		return;
	}
	state.checking = true;
	try {
		localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
		const response = await curlFetch(LATEST_RELEASE, { headers: { Accept: "application/vnd.github+json" } });
		if (!response.ok) {
			throw new Error(`GitHub responded with ${response.status}`);
		}
		const release = (await response.json()) as Release;
		const version = release.tag_name.replace(/^v/, "");
		state.latestVersion = version;
		const installed = getOpenedApp().info.version;
		if (compareVersions(version, installed) <= 0 || state.disabled) {
			return;
		}
		const asset = release.assets.find((item) => item.name === `obsidian-${version}.asar.gz`);
		if (!asset) {
			return;
		}
		const download = await curlFetch(asset.browser_download_url, { redirect: "follow" });
		if (!download.ok || !download.body) {
			throw new Error(`Download failed with status ${download.status}`);
		}
		await installArchive(download.body, { gzip: true, sourceLabel: asset.browser_download_url });
		state.status = "update-downloaded";
		console.info(`[obsidian-web] Obsidian ${version} was downloaded and will be used after relaunching.`);
	} catch (error) {
		console.warn("[obsidian-web] Update check failed", error);
	} finally {
		state.checking = false;
	}
}
