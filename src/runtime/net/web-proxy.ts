import { BareMuxConnection } from "@mercuryworkshop/bare-mux";
import type { ScramjetController, ScramjetFrame } from "@mercuryworkshop/scramjet";
import { ASSET_PREFIX, WEBVIEW_PREFIX } from "../../shared/constants.ts";
import { getWispUrl } from "../../shared/network-config.ts";

let initializing: Promise<ScramjetController> | null = null;

async function controller(): Promise<ScramjetController> {
	if (!getWispUrl()) {
		throw new Error("The web viewer needs a Wisp proxy. Set its URL in Settings → Obsidian Web.");
	}
	initializing ??= (async () => {
		await new Promise<void>((resolve, reject) => {
			const script = document.createElement("script");
			script.src = `${ASSET_PREFIX}vendor/scramjet/scramjet.all.js`;
			script.onload = () => resolve();
			script.onerror = () => reject(new Error("Unable to load the bundled Scramjet runtime"));
			document.head.appendChild(script);
		});
		const connection = new BareMuxConnection(`${ASSET_PREFIX}vendor/bare-mux/worker.js`);
		await connection.setTransport(`${ASSET_PREFIX}vendor/curl-transport/index.mjs`, [{ websocket: getWispUrl() }]);
		const { ScramjetController } = $scramjetLoadController();
		const proxy = new ScramjetController({
			prefix: WEBVIEW_PREFIX,
			files: {
				wasm: `${ASSET_PREFIX}vendor/scramjet/scramjet.wasm.wasm`,
				all: `${ASSET_PREFIX}vendor/scramjet/scramjet.all.js`,
				sync: `${ASSET_PREFIX}vendor/scramjet/scramjet.sync.js`,
			},
			flags: { syncxhr: false, rewriterLogs: false, captureErrors: false },
		});
		await proxy.init();
		return proxy;
	})();
	initializing.catch(() => {
		initializing = null;
	});
	return initializing;
}

/** Scramjet rewrites the entire page, scripts and subsequent requests through the existing Wisp endpoint. */
export async function createProxyFrame(frame: HTMLIFrameElement): Promise<ScramjetFrame> {
	return (await controller()).createFrame(frame);
}

export async function proxyResourceUrl(url: string): Promise<string> {
	return (await controller()).encodeUrl(url);
}
