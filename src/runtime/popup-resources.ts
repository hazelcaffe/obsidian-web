/**
 * Browsers do not let the service worker control `about:blank` windows, so Obsidian's popout windows cannot load the
 * app's styles, fonts or vault files directly. Their same-origin resources are fetched through the main window and
 * swapped for blob URLs.
 */
const cache = new Map<string, Promise<string>>();
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const ATTRIBUTES: Record<string, string[]> = {
	IMG: ["src"],
	SCRIPT: ["src"],
	VIDEO: ["src", "poster"],
	AUDIO: ["src"],
	SOURCE: ["src"],
	EMBED: ["src"],
	TRACK: ["src"],
	INPUT: ["src"],
	LINK: ["href"],
};

function sameOriginUrl(raw: string | null, base: string): URL | null {
	if (!raw || raw.startsWith("blob:") || raw.startsWith("data:")) {
		return null;
	}
	try {
		const url = new URL(raw, base);
		return url.origin === location.origin ? url : null;
	} catch {
		return null;
	}
}

async function rewriteCss(css: string, base: string): Promise<string> {
	const replacements = new Map<string, Promise<string>>();
	for (const match of css.matchAll(CSS_URL)) {
		const raw = match[2] ?? "";
		const url = sameOriginUrl(raw, base);
		if (url && !replacements.has(raw)) {
			replacements.set(
				raw,
				blobUrl(url.href).catch(() => raw),
			);
		}
	}
	const resolved = new Map<string, string>();
	for (const [raw, promise] of replacements) {
		resolved.set(raw, await promise);
	}
	return css.replace(CSS_URL, (whole, quote: string, raw: string) => {
		const replacement = resolved.get(raw);
		return replacement ? `url(${quote}${replacement}${quote})` : whole;
	});
}

function cached(key: string, href: string, load: () => Promise<string>): Promise<string> {
	let promise = cache.get(key);
	if (!promise) {
		promise = load();
		promise.catch(() => cache.delete(key));
		// Vault files change, so only app files stay cached.
		if (!new URL(href).pathname.startsWith("/_vfs/")) {
			cache.set(key, promise);
		}
	}
	return promise;
}

function blobUrl(href: string): Promise<string> {
	return cached(href, href, async () => {
		const response = await fetch(href);
		if (!response.ok) {
			throw new Error(`${response.status} ${href}`);
		}
		return URL.createObjectURL(await response.blob());
	});
}

/** The app's CSP only allows inline and same-origin styles, so stylesheets are inlined instead of using blobs. */
function stylesheetText(href: string): Promise<string> {
	return cached(`css:${href}`, href, async () => {
		const response = await fetch(href);
		if (!response.ok) {
			throw new Error(`${response.status} ${href}`);
		}
		return rewriteCss(await response.text(), href);
	});
}

const inlined = new WeakMap<Element, HTMLStyleElement>();

function inlineStylesheet(link: HTMLLinkElement, url: URL): void {
	const raw = link.getAttribute("href");
	stylesheetText(url.href).then(
		(css) => {
			if (!link.isConnected || link.getAttribute("href") !== raw) {
				return;
			}
			let style = inlined.get(link);
			if (!style) {
				style = link.ownerDocument.createElement("style");
				style.dataset.obsidianWebStylesheet = url.href;
				inlined.set(link, style);
			}
			style.textContent = css;
			link.after(style);
			link.disabled = true;
		},
		(error: unknown) => console.warn("[obsidian-web] Unable to load popout stylesheet", error),
	);
}

function rewriteElement(element: Element, base: string): void {
	const attributes = ATTRIBUTES[element.tagName];
	if (attributes) {
		for (const attribute of attributes) {
			const raw = element.getAttribute(attribute);
			const url = sameOriginUrl(raw, base);
			if (!url) {
				continue;
			}
			if (element instanceof HTMLLinkElement || element.tagName === "LINK") {
				const rel = element.getAttribute("rel") ?? "";
				if (/\bstylesheet\b/i.test(rel)) {
					inlineStylesheet(element as HTMLLinkElement, url);
					continue;
				}
				if (!/\bicon\b/i.test(rel)) {
					continue;
				}
			}
			blobUrl(url.href).then(
				(blob) => {
					if (element.getAttribute(attribute) === raw) {
						element.setAttribute(attribute, blob);
					}
				},
				(error: unknown) => console.warn("[obsidian-web] Unable to load popout resource", error),
			);
		}
	}
	if (
		element.tagName === "STYLE" &&
		!(element as HTMLElement).dataset.obsidianWebStylesheet &&
		/url\(/.test(element.textContent ?? "")
	) {
		const text = element.textContent ?? "";
		rewriteCss(text, base).then((css) => {
			if (css !== text && element.textContent === text) {
				element.textContent = css;
			}
		});
	}
}

export function proxyPopupResources(popup: Window): void {
	const doc = popup.document;
	const visit = (node: Node): void => {
		if (node.nodeType !== 1) {
			return;
		}
		const element = node as Element;
		rewriteElement(element, doc.baseURI);
		for (const child of element.querySelectorAll("img,script,video,audio,source,embed,track,input,link,style")) {
			rewriteElement(child, doc.baseURI);
		}
	};
	const observer = new (popup as Window & typeof globalThis).MutationObserver((records) => {
		for (const record of records) {
			if (record.type === "attributes") {
				visit(record.target);
			} else if (record.type === "characterData") {
				const parent = record.target.parentElement;
				if (parent?.tagName === "STYLE") {
					rewriteElement(parent, doc.baseURI);
				}
			} else {
				record.addedNodes.forEach(visit);
				for (const node of record.removedNodes) {
					if (node.nodeType === 1) {
						inlined.get(node as Element)?.remove();
					}
				}
			}
		}
	});
	observer.observe(doc, {
		childList: true,
		subtree: true,
		characterData: true,
		attributes: true,
		attributeFilter: ["src", "href", "poster"],
	});
	visit(doc.documentElement);
}
