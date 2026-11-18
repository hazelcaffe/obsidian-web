import {
	getWispUrl,
	type Libcurl,
	type LibcurlRequestInit,
	type LibcurlResponse,
	loadLibcurl,
} from "../../shared/libcurl.ts";

const COOKIE_KEY = "obsidian-web:cookies";

interface HttpSession {
	fetch(input: string, init?: LibcurlRequestInit): Promise<LibcurlResponse>;
	export_cookies(): string;
}

let session: HttpSession | null = null;
let appVersion = "";

export function setAppVersion(version: string): void {
	appVersion = version;
}

/** A user agent like the desktop app's (`... obsidian/x.y.z Chrome/... Electron/... Safari/...`). */
export function electronUserAgent(): string {
	const ua = navigator.userAgent;
	if (!appVersion || ua.includes(" obsidian/")) {
		return ua;
	}
	return ua.replace(/ Safari\//, ` obsidian/${appVersion} Electron/44.0.0 Safari/`);
}

export function getCurl(): Promise<Libcurl> {
	return loadLibcurl();
}

async function getSession(): Promise<HttpSession> {
	const libcurl = await loadLibcurl();
	if (!session) {
		const HTTPSession = (libcurl as unknown as { HTTPSession: new (options: object) => HttpSession }).HTTPSession;
		let jar = "";
		try {
			jar = localStorage.getItem(COOKIE_KEY) ?? "";
		} catch {}
		session = new HTTPSession({ enable_cookies: true, cookie_jar: jar });
		const save = (): void => {
			try {
				const cookies = session?.export_cookies();
				if (cookies) {
					localStorage.setItem(COOKIE_KEY, cookies);
				}
			} catch {}
		};
		addEventListener("pagehide", save);
		setInterval(save, 60_000);
	}
	return session;
}

/** Performs an HTTP request through libcurl.js and the Wisp proxy. Not subject to CORS. */
export async function curlFetch(url: string, init: LibcurlRequestInit = {}): Promise<LibcurlResponse> {
	const headers = new Headers(init.headers);
	if (!headers.has("User-Agent")) {
		headers.set("User-Agent", electronUserAgent());
	}
	if (!headers.has("Accept")) {
		headers.set("Accept", "*/*");
	}
	if (!headers.has("Accept-Language")) {
		headers.set("Accept-Language", navigator.languages?.join(",") || "en-US");
	}
	const plain: Record<string, string> = {};
	headers.forEach((value, key) => {
		plain[key] = value;
	});
	return (await getSession()).fetch(url, { ...init, headers: plain });
}

/** Whether a URL must be fetched through the proxy (an http(s) URL on another origin). */
export function needsProxy(url: string | URL, base: string = location.href): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url, base);
	} catch {
		return false;
	}
	if (
		parsed.protocol !== "http:" &&
		parsed.protocol !== "https:" &&
		parsed.protocol !== "ws:" &&
		parsed.protocol !== "wss:"
	) {
		return false;
	}
	if (parsed.host === location.host) {
		return false;
	}
	const wisp = getWispUrl();
	return !parsed.href.startsWith(wisp);
}
