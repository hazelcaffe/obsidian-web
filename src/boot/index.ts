import type { ClientMessage } from "../shared/constants.ts";
import { type InstalledApp, installArchive, readInstalledApp, uninstallApp } from "../shared/install.ts";
import { defaultWispUrl, getWispUrl, loadLibcurl, setWispUrl } from "../shared/libcurl.ts";
import { LAST_VAULT_KEY } from "../shared/storage-keys.ts";

const RELEASES_API = "https://api.github.com/repos/obsidianmd/obsidian-releases/releases?per_page=30";
const TERMS =
	"Obsidian is proprietary software made by Dynalist Inc. The app is downloaded from the official obsidianmd/obsidian-releases repository into this browser's private storage. I understand and agree that I am not allowed to distribute the Obsidian application, in any form, without explicit approval from the Obsidian team. I also understand that Obsidian is a registered trademark, and I cannot use it without explicit permission granted by the Obsidian team.";

interface Release {
	tag_name: string;
	prerelease: boolean;
	draft: boolean;
	assets: Array<{ name: string; browser_download_url: string; size: number }>;
}

interface AsarRelease {
	version: string;
	url: string;
	size: number;
}

const statusEl = document.getElementById("status") as HTMLElement;
const contentEl = document.getElementById("content") as HTMLElement;

function setStatus(text: string, error = false): void {
	statusEl.textContent = text;
	statusEl.classList.toggle("is-error", error);
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {},
	children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
	const { cls, ...rest } = props;
	const element = Object.assign(document.createElement(tag), rest);
	if (cls) {
		element.className = cls;
	}
	element.append(...children);
	return element;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(0)} KB`;
	}
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function ensureServiceWorker(): Promise<boolean> {
	if (!window.isSecureContext) {
		setStatus("Obsidian Web needs a secure context. Open it over HTTPS or from localhost.", true);
		return false;
	}
	if (!("serviceWorker" in navigator) || !navigator.storage?.getDirectory) {
		setStatus("This browser does not support service workers or the origin private file system.", true);
		return false;
	}
	await navigator.serviceWorker.register("/sw.js", { scope: "/" });
	await navigator.serviceWorker.ready;
	if (!navigator.serviceWorker.controller) {
		await new Promise<void>((resolve) => {
			navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
			setTimeout(resolve, 3000);
		});
	}
	if (!navigator.serviceWorker.controller) {
		location.reload();
		return false;
	}
	await navigator.storage.persist?.().catch(() => false);
	return true;
}

function notifyWorker(message: ClientMessage): void {
	navigator.serviceWorker.controller?.postMessage(message);
}

function launch(): void {
	const last = localStorage.getItem(LAST_VAULT_KEY);
	location.replace(last ? `/index.html?vault=${encodeURIComponent(last)}` : "/starter.html");
}

async function fetchReleases(): Promise<AsarRelease[]> {
	const libcurl = await loadLibcurl();
	const response = await libcurl.fetch(RELEASES_API, {
		headers: { Accept: "application/vnd.github+json", "User-Agent": "obsidian-web" },
	});
	if (!response.ok) {
		throw new Error(`GitHub responded with ${response.status}`);
	}
	const releases = (await response.json()) as Release[];
	const out: AsarRelease[] = [];
	for (const release of releases) {
		if (release.draft || release.prerelease) {
			continue;
		}
		const asset = release.assets.find((a) => /^obsidian-\d+\.\d+\.\d+\.asar\.gz$/.test(a.name));
		if (asset) {
			out.push({
				version: release.tag_name.replace(/^v/, ""),
				url: asset.browser_download_url,
				size: asset.size,
			});
		}
	}
	return out;
}

async function downloadAndInstall(release: AsarRelease, progress: HTMLProgressElement): Promise<InstalledApp> {
	const libcurl = await loadLibcurl();
	const response = await libcurl.fetch(release.url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Download failed with status ${response.status}`);
	}
	const total = Number(response.headers.get("Content-Length")) || release.size;
	progress.max = total;
	return installArchive(response.body, {
		gzip: true,
		sourceLabel: release.url,
		onProgress: (bytes) => {
			progress.value = bytes;
			setStatus(`Downloading Obsidian ${release.version}… ${formatBytes(bytes)} / ${formatBytes(total)}`);
		},
	});
}

function renderSetup(installed: InstalledApp | null): void {
	contentEl.replaceChildren();
	setStatus(installed ? `Obsidian ${installed.version} is installed.` : "Obsidian is not installed yet.");

	if (installed) {
		contentEl.append(
			el("div", { cls: "card" }, [
				el("h2", { textContent: "Open" }),
				el("p", { textContent: "Your vaults are stored in this browser's origin private file system." }),
				el("div", { cls: "row" }, [
					el("button", { cls: "mod-cta", textContent: "Open Obsidian", onclick: launch }),
					el("button", {
						textContent: "Manage vaults",
						onclick: () => location.replace("/starter.html"),
					}),
				]),
			]),
		);
	}

	const agree = el("input", { type: "checkbox", checked: !!installed });
	const versionSelect = el("select", { disabled: true }, [el("option", { textContent: "Loading releases…" })]);
	const downloadButton = el("button", { cls: "mod-cta", textContent: "Download and install", disabled: true });
	const fileInput = el("input", { type: "file", accept: ".asar,.gz,application/gzip", hidden: true });
	const fileButton = el("button", { textContent: "Install from file…" });
	const progress = el("progress", { value: 0, max: 1, hidden: true });
	let releases: AsarRelease[] = [];

	const busy = (value: boolean): void => {
		downloadButton.disabled = value || !agree.checked || releases.length === 0;
		fileButton.disabled = value || !agree.checked;
		versionSelect.disabled = value || releases.length === 0;
		progress.hidden = !value;
	};
	agree.addEventListener("change", () => busy(false));

	const finish = (info: InstalledApp): void => {
		notifyWorker({ type: "app-updated" });
		setStatus(`Installed Obsidian ${info.version}.`);
		renderSetup(info);
	};

	downloadButton.addEventListener("click", async () => {
		const release = releases[versionSelect.selectedIndex];
		if (!release) {
			return;
		}
		busy(true);
		try {
			finish(await downloadAndInstall(release, progress));
		} catch (error) {
			console.error(error);
			setStatus(`Installation failed: ${error instanceof Error ? error.message : String(error)}`, true);
			busy(false);
		}
	});

	fileButton.addEventListener("click", () => fileInput.click());
	fileInput.addEventListener("change", async () => {
		const file = fileInput.files?.[0];
		if (!file) {
			return;
		}
		busy(true);
		progress.max = file.size;
		try {
			const header = new Uint8Array(await file.slice(0, 2).arrayBuffer());
			const info = await installArchive(file.stream(), {
				gzip: header[0] === 0x1f && header[1] === 0x8b,
				sourceLabel: file.name,
				onProgress: (bytes) => {
					progress.value = bytes;
					setStatus(`Installing ${file.name}… ${formatBytes(bytes)}`);
				},
			});
			finish(info);
		} catch (error) {
			console.error(error);
			setStatus(`Installation failed: ${error instanceof Error ? error.message : String(error)}`, true);
			busy(false);
		}
		fileInput.value = "";
	});

	contentEl.append(
		el("div", { cls: "card" }, [
			el("h2", { textContent: installed ? "Update or reinstall" : "Install Obsidian" }),
			el("p", {
				textContent:
					"Obsidian Web runs the official Obsidian desktop app. No Obsidian code ships with Obsidian Web: choose a release to download from GitHub through the Wisp proxy, or pick an obsidian-x.y.z.asar(.gz) file you downloaded yourself.",
			}),
			el("p", { cls: "notice", textContent: TERMS }),
			el("label", { cls: "checkbox" }, [agree, el("span", { textContent: "I understand and agree." })]),
			el("div", { cls: "row" }, [versionSelect, downloadButton, fileButton, fileInput]),
			progress,
		]),
	);

	const wispInput = el("input", { type: "url", value: getWispUrl(), placeholder: defaultWispUrl() });
	contentEl.append(
		el("div", { cls: "card" }, [
			el("h2", { textContent: "Network" }),
			el("p", {
				cls: "muted",
				textContent:
					"Requests to other sites (community plugins, Sync, publishing, plugin APIs) are tunneled through a Wisp server with libcurl.js, so TLS is end-to-end encrypted between this browser and the destination.",
			}),
			el("div", { cls: "row" }, [
				wispInput,
				el("button", {
					textContent: "Save",
					onclick: () => {
						setWispUrl(wispInput.value.trim() || null);
						location.reload();
					},
				}),
			]),
		]),
	);

	if (installed) {
		contentEl.append(
			el("div", { cls: "card" }, [
				el("h2", { textContent: "Storage" }),
				el("p", {
					cls: "muted",
					textContent: `Installed from ${installed.source} on ${new Date(installed.installedAt).toLocaleString()}.`,
				}),
				el("div", { cls: "row" }, [
					el("button", {
						textContent: "Remove app files",
						onclick: async () => {
							if (confirm("Remove the downloaded Obsidian app? Your vaults are kept.")) {
								await uninstallApp();
								notifyWorker({ type: "app-updated" });
								renderSetup(null);
							}
						},
					}),
				]),
			]),
		);
	}

	busy(false);
	fetchReleases()
		.then((list) => {
			releases = list;
			versionSelect.replaceChildren(
				...list.map((release, index) =>
					el("option", {
						textContent: `${release.version}${index === 0 ? " (latest)" : ""} — ${formatBytes(release.size)}`,
					}),
				),
			);
			busy(false);
		})
		.catch((error: unknown) => {
			console.error(error);
			versionSelect.replaceChildren(el("option", { textContent: "Unable to reach GitHub through Wisp" }));
		});
}

async function main(): Promise<void> {
	if (!(await ensureServiceWorker())) {
		return;
	}
	const installed = await readInstalledApp();
	const params = new URLSearchParams(location.search);
	if (installed && !params.has("setup")) {
		setStatus(`Starting Obsidian ${installed.version}…`);
		launch();
		return;
	}
	renderSetup(installed);
}

main().catch((error: unknown) => {
	console.error(error);
	setStatus(error instanceof Error ? error.message : String(error), true);
});
