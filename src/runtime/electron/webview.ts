import type { ScramjetFrame } from "@mercuryworkshop/scramjet";
import { EventEmitter } from "events";
import { createProxyFrame, proxyResourceUrl } from "../net/web-proxy.ts";
import { registerWebContents } from "./browser-window.ts";

const TAG = "obsidian-webview";
let nextId = 100_000;

function webviewEvent(type: string, detail: Record<string, unknown> = {}): Event {
	return Object.assign(new Event(type), detail);
}

/** Electron's webview backed by a Scramjet-rewritten page over Wisp. */
function defineWebview(win: Window & typeof globalThis): void {
	if (win.customElements.get(TAG)) {
		return;
	}
	class WebViewElement extends win.HTMLElement {
		readonly #frame: HTMLIFrameElement;
		readonly #contentsId = nextId++;
		readonly #contents: EventEmitter;
		readonly #history: string[] = [];
		#index = -1;
		#loading = false;
		#zoom = 1;
		#proxy: ScramjetFrame | null = null;
		#proxyReady: Promise<void> | null = null;
		#url = "";
		#navigation = 0;
		#titleObserver: MutationObserver | null = null;
		allowpopups = false;
		partition = "";
		useragent = "";

		constructor() {
			super();
			this.#frame = win.document.createElement("iframe");
			this.#frame.setAttribute(
				"sandbox",
				"allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
			);
			this.#frame.setAttribute(
				"allow",
				"fullscreen; clipboard-write; autoplay; encrypted-media; picture-in-picture",
			);
			this.#frame.referrerPolicy = "strict-origin-when-cross-origin";
			this.#frame.style.cssText = "border:0;width:100%;height:100%;flex:1;background:inherit;";
			this.#frame.addEventListener("load", () => this.#onLoad());
			this.#contents = Object.assign(new EventEmitter(), {
				id: this.#contentsId,
				noContextMenu: false,
				isDestroyed: () => !this.isConnected,
				setIgnoreMenuShortcuts: () => undefined,
				setWindowOpenHandler: () => undefined,
				setAudioMuted: () => undefined,
				isAudioMuted: () => false,
				getURL: () => this.getURL(),
				getTitle: () => this.getTitle(),
				executeJavaScript: (code: string) => this.executeJavaScript(code),
				focus: () => this.#frame.focus(),
			});
			registerWebContents(this.#contentsId, this.#contents);
		}

		static get observedAttributes(): string[] {
			return ["src"];
		}

		connectedCallback(): void {
			this.style.display ||= "flex";
			if (!this.#frame.isConnected) {
				this.appendChild(this.#frame);
			}
			queueMicrotask(() => this.dispatchEvent(webviewEvent("dom-ready")));
		}

		attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
			if (name === "src" && value) {
				this.#navigate(value, true);
			}
		}

		get src(): string {
			return this.getAttribute("src") ?? "";
		}

		set src(value: string) {
			this.setAttribute("src", value);
		}

		#navigate(url: string, push: boolean): void {
			if (push) {
				this.#history.splice(this.#index + 1);
				this.#history.push(url);
				this.#index = this.#history.length - 1;
			}
			this.#loading = true;
			this.#url = url;
			const navigation = ++this.#navigation;
			this.dispatchEvent(webviewEvent("did-start-loading"));
			this.dispatchEvent(webviewEvent("did-start-navigation", { url, isMainFrame: true, isInPlace: false }));
			if (url === "about:blank") {
				this.#frame.src = url;
				return;
			}
			this.#ensureProxy()
				.then(() => {
					if (navigation === this.#navigation) {
						this.#proxy?.go(url);
					}
				})
				.catch((error: unknown) => {
					if (navigation !== this.#navigation) {
						return;
					}
					this.#loading = false;
					this.dispatchEvent(
						webviewEvent("did-fail-load", {
							errorCode: -2,
							errorDescription: error instanceof Error ? error.message : String(error),
							validatedURL: url,
							isMainFrame: true,
						}),
					);
					this.dispatchEvent(webviewEvent("did-stop-loading"));
				});
		}

		#ensureProxy(): Promise<void> {
			this.#proxyReady ??= createProxyFrame(this.#frame)
				.then((frame) => {
					this.#proxy = frame;
					frame.addEventListener("navigate", (event) => {
						this.#loading = true;
						this.dispatchEvent(webviewEvent("did-start-loading"));
						this.dispatchEvent(webviewEvent("did-start-navigation", { url: event.url, isMainFrame: true }));
					});
					frame.addEventListener("urlchange", (event) => {
						if (event.url !== this.#url) {
							this.#history.splice(this.#index + 1);
							this.#history.push(event.url);
							this.#index = this.#history.length - 1;
							this.#url = event.url;
							this.dispatchEvent(
								webviewEvent("did-navigate-in-page", { url: event.url, isMainFrame: true }),
							);
						}
					});
				})
				.catch((error: unknown) => {
					this.#proxyReady = null;
					throw error;
				});
			return this.#proxyReady;
		}

		#onLoad(): void {
			if (!this.#frame.src || this.#frame.src === "about:blank") {
				return;
			}
			this.#loading = false;
			const url = this.getURL();
			this.dispatchEvent(webviewEvent("did-navigate", { url, httpResponseCode: 200, httpStatusText: "OK" }));
			this.dispatchEvent(webviewEvent("did-finish-load"));
			this.dispatchEvent(webviewEvent("did-stop-loading"));
			this.dispatchEvent(webviewEvent("page-title-updated", { title: this.getTitle(), explicitSet: false }));
			this.#titleObserver?.disconnect();
			const head = this.#frame.contentDocument?.head;
			if (head) {
				this.#titleObserver = new win.MutationObserver(() => {
					this.dispatchEvent(
						webviewEvent("page-title-updated", { title: this.getTitle(), explicitSet: true }),
					);
				});
				this.#titleObserver.observe(head, { subtree: true, childList: true, characterData: true });
			}
			try {
				const origin = new URL(url).origin;
				void proxyResourceUrl(`${origin}/favicon.ico`).then((icon) => {
					if (this.#url === url) {
						this.dispatchEvent(webviewEvent("page-favicon-updated", { favicons: [icon] }));
					}
				});
			} catch {}
		}

		loadURL(url: string): Promise<void> {
			this.setAttribute("src", url);
			return Promise.resolve();
		}

		getURL(): string {
			return this.#url || this.src;
		}

		getTitle(): string {
			try {
				const title = this.#frame.contentDocument?.title;
				if (title) {
					return title;
				}
			} catch {}
			try {
				return new URL(this.getURL()).hostname;
			} catch {
				return "";
			}
		}

		isLoading(): boolean {
			return this.#loading;
		}

		isLoadingMainFrame(): boolean {
			return this.#loading;
		}

		stop(): void {
			this.#navigation++;
			this.#loading = false;
			this.#frame.contentWindow?.stop();
			this.dispatchEvent(webviewEvent("did-stop-loading"));
		}

		reload(): void {
			const url = this.#history[this.#index];
			if (url) {
				this.#navigate(url, false);
			}
		}

		reloadIgnoringCache(): void {
			this.reload();
		}

		canGoBack(): boolean {
			return this.#index > 0;
		}

		canGoForward(): boolean {
			return this.#index < this.#history.length - 1;
		}

		goBack(): void {
			if (this.canGoBack()) {
				this.#index--;
				this.#navigate(this.#history[this.#index] ?? "about:blank", false);
			}
		}

		goForward(): void {
			if (this.canGoForward()) {
				this.#index++;
				this.#navigate(this.#history[this.#index] ?? "about:blank", false);
			}
		}

		goToIndex(index: number): void {
			if (index >= 0 && index < this.#history.length) {
				this.#index = index;
				this.#navigate(this.#history[index] ?? "about:blank", false);
			}
		}

		async executeJavaScript(code: string): Promise<unknown> {
			const target = this.#frame.contentWindow as (Window & { eval(code: string): unknown }) | null;
			if (!target) {
				throw new Error("The page is not loaded");
			}
			// Evaluate inside Scramjet's virtual window so URL and network APIs use the viewed site's origin.
			const rewrite = (target as typeof target & { $scramjet$rewrite?: (code: string) => string })
				.$scramjet$rewrite;
			return target.eval(rewrite ? rewrite(code) : code);
		}

		async insertCSS(css: string): Promise<string> {
			const doc = this.#frame.contentDocument;
			if (doc) {
				const style = doc.createElement("style");
				style.textContent = css;
				doc.head.appendChild(style);
			}
			return "";
		}

		setZoomFactor(factor: number): void {
			this.#zoom = factor;
			this.#frame.style.zoom = String(factor);
		}

		getZoomFactor(): number {
			return this.#zoom;
		}

		setZoomLevel(level: number): void {
			this.setZoomFactor(1.2 ** level);
		}

		getZoomLevel(): number {
			return Math.log(this.#zoom) / Math.log(1.2);
		}

		findInPage(): number {
			return 0;
		}

		stopFindInPage(): void {}

		getWebContentsId(): number {
			return this.#contentsId;
		}

		openDevTools(): void {}

		closeDevTools(): void {}

		isDevToolsOpened(): boolean {
			return false;
		}

		setUserAgent(userAgent: string): void {
			this.useragent = userAgent;
		}

		getUserAgent(): string {
			return this.useragent || navigator.userAgent;
		}

		setAudioMuted(): void {}

		isAudioMuted(): boolean {
			return false;
		}

		print(): void {
			this.#frame.contentWindow?.print();
		}

		override focus(): void {
			this.#frame.focus();
		}
	}
	win.customElements.define(TAG, WebViewElement);
	const style = win.document.createElement("style");
	style.textContent = `${TAG}{display:flex;flex:1;width:100%;height:100%;}${TAG}[hidden]{display:none;}`;
	(win.document.head ?? win.document.documentElement).appendChild(style);
}

/** `document.createElement("webview")` creates the polyfilled element (custom element names need a hyphen). */
export function installWebview(win: Window & typeof globalThis): void {
	defineWebview(win);
	const proto = win.Document.prototype;
	const createElement = proto.createElement;
	proto.createElement = function (this: Document, tagName: string, options?: ElementCreationOptions): HTMLElement {
		if (typeof tagName === "string" && tagName.toLowerCase() === "webview") {
			return createElement.call(this, TAG, options);
		}
		return createElement.call(this, tagName, options);
	} as Document["createElement"];
}
