import type { ClientMessage, StartupProgress } from "../shared/constants.ts";

export function showLoading(message: string, completed?: number, total?: number): void {
	const status = document.getElementById("obsidian-web-loading-status");
	if (status) {
		status.textContent = message;
	}
	const progress = document.querySelector<HTMLProgressElement>("#obsidian-web-loading progress");
	if (progress) {
		if (completed !== undefined && total) {
			progress.max = total;
			progress.value = completed;
		} else {
			progress.removeAttribute("value");
		}
	}
}

/** Subscribe to the installing worker, which may already have downloaded some of the app. */
export function watchDownload(worker: ServiceWorker): () => void {
	const channel = new MessageChannel();
	channel.port1.onmessage = (event: MessageEvent<StartupProgress>) => {
		const { completed, total } = event.data;
		showLoading(`Downloading app files… ${completed} / ${total}`, completed, total);
	};
	const message: ClientMessage = { type: "startup-progress" };
	worker.postMessage(message, [channel.port2]);
	return () => channel.port1.close();
}

export function hideLoading(): void {
	document.getElementById("obsidian-web-loading")?.remove();
	document.getElementById("obsidian-web-loading-style")?.remove();
}
