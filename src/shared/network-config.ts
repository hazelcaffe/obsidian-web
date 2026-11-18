export const WISP_KEY = "obsidian-web:wisp-url";

export function defaultWispUrl(origin: string = location.origin): string {
	const url = new URL(origin);
	const local =
		url.hostname === "localhost" ||
		url.hostname.endsWith(".localhost") ||
		url.hostname === "[::1]" ||
		/^127\.\d+\.\d+\.\d+$/.test(url.hostname);
	return local ? `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/wisp/` : "";
}

export function getWispUrl(): string {
	try {
		// An explicitly empty value disables Wisp even on localhost.
		return localStorage.getItem(WISP_KEY) ?? defaultWispUrl();
	} catch {
		return defaultWispUrl();
	}
}

export function normalizeWispUrl(input: string): string {
	const value = input.trim();
	if (!value) {
		return "";
	}
	const url = new URL(value);
	if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
		throw new Error("Use a ws:// or wss:// URL without credentials, query parameters or a fragment.");
	}
	if (!url.pathname.endsWith("/")) {
		url.pathname += "/";
	}
	return url.href;
}

/** null restores the default, while an empty string disables the proxy. */
export function setWispUrl(value: string | null): void {
	if (value === null) {
		localStorage.removeItem(WISP_KEY);
	} else {
		localStorage.setItem(WISP_KEY, normalizeWispUrl(value));
	}
}
