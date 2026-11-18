import { EventEmitter } from "events";
import { IpcRenderer, type IpcSender } from "./ipc.ts";
import { NativeImage } from "./native-image.ts";
import { getSession, type Session } from "./session.ts";

let nextId = 1;
const byWindow = new WeakMap<Window, BrowserWindowShim>();
const byId = new Map<number, BrowserWindowShim>();

export function zoomFactorFor(level: number): number {
	return 1.2 ** level;
}

/** Electron's `webFrame` for one window, implemented with CSS zoom on the root element. */
export class WebFrameShim {
	readonly #win: Window;
	#level = 0;

	constructor(win: Window) {
		this.#win = win;
	}

	setZoomLevel(level: number): void {
		this.#level = Math.max(-8, Math.min(9, Number(level) || 0));
		const root = this.#win.document.documentElement;
		root.style.zoom = this.#level === 0 ? "" : String(zoomFactorFor(this.#level));
		root.style.setProperty("--zoom-factor", String(zoomFactorFor(this.#level)));
	}

	getZoomLevel(): number {
		return this.#level;
	}

	setZoomFactor(factor: number): void {
		this.setZoomLevel(Math.log(factor) / Math.log(1.2));
	}

	getZoomFactor(): number {
		return zoomFactorFor(this.#level);
	}

	setVisualZoomLevelLimits(): Promise<void> {
		return Promise.resolve();
	}

	setSpellCheckProvider(): void {}

	insertCSS(css: string): string {
		const style = this.#win.document.createElement("style");
		style.textContent = css;
		const key = `css-${nextId++}`;
		style.dataset.key = key;
		this.#win.document.head.appendChild(style);
		return key;
	}

	removeInsertCSS(key: string): void {
		this.#win.document.querySelector(`style[data-key="${key}"]`)?.remove();
	}

	executeJavaScript(code: string): Promise<unknown> {
		return Promise.resolve((this.#win as Window & { eval(code: string): unknown }).eval(code));
	}

	getResourceUsage(): Record<string, unknown> {
		return {};
	}

	clearCache(): void {}
}

export class WebContentsShim extends EventEmitter implements IpcSender {
	readonly id: number;
	readonly win: Window;
	readonly ipc: IpcRenderer;
	readonly webFrame: WebFrameShim;
	readonly owner: BrowserWindowShim;
	readonly hostWebContents = null;
	readonly debugger = { attach() {}, detach() {}, isAttached: () => false, sendCommand: async () => ({}) };
	#audioMuted = false;

	constructor(owner: BrowserWindowShim) {
		super();
		this.id = owner.id;
		this.owner = owner;
		this.win = owner.win;
		this.ipc = new IpcRenderer(this);
		this.webFrame = new WebFrameShim(owner.win);
	}

	get session(): Session {
		return getSession("default");
	}

	get zoomLevel(): number {
		return this.webFrame.getZoomLevel();
	}

	set zoomLevel(level: number) {
		this.webFrame.setZoomLevel(level);
	}

	send(channel: string, ...args: unknown[]): void {
		setTimeout(() => this.ipc.emit(channel, { sender: this, senderId: 0, ports: [] }, ...args), 0);
	}

	getURL(): string {
		return this.win.location.href;
	}

	getTitle(): string {
		return this.win.document.title;
	}

	isDestroyed(): boolean {
		return this.win.closed;
	}

	isLoading(): boolean {
		return this.win.document.readyState === "loading";
	}

	isFocused(): boolean {
		return this.win.document.hasFocus();
	}

	focus(): void {
		this.win.focus();
	}

	reload(): void {
		this.win.location.reload();
	}

	reloadIgnoringCache(): void {
		this.win.location.reload();
	}

	getZoomLevel(): number {
		return this.webFrame.getZoomLevel();
	}

	setZoomLevel(level: number): void {
		this.webFrame.setZoomLevel(level);
	}

	getZoomFactor(): number {
		return this.webFrame.getZoomFactor();
	}

	setZoomFactor(factor: number): void {
		this.webFrame.setZoomFactor(factor);
	}

	setVisualZoomLevelLimits(): Promise<void> {
		return Promise.resolve();
	}

	openDevTools(): void {
		console.info("[obsidian-web] Use the browser's developer tools (F12).");
	}

	closeDevTools(): void {}

	toggleDevTools(): void {
		this.openDevTools();
	}

	isDevToolsOpened(): boolean {
		return false;
	}

	#exec(command: string): void {
		this.win.document.execCommand(command);
	}

	undo(): void {
		this.#exec("undo");
	}

	redo(): void {
		this.#exec("redo");
	}

	cut(): void {
		this.#exec("cut");
	}

	copy(): void {
		this.#exec("copy");
	}

	delete(): void {
		this.#exec("delete");
	}

	selectAll(): void {
		this.#exec("selectAll");
	}

	unselect(): void {
		this.win.getSelection()?.removeAllRanges();
	}

	paste(): void {
		navigator.clipboard
			.readText()
			.then((text) => this.win.document.execCommand("insertText", false, text))
			.catch(() => undefined);
	}

	pasteAndMatchStyle(): void {
		this.paste();
	}

	replace(text: string): void {
		this.win.document.execCommand("insertText", false, text);
	}

	replaceMisspelling(text: string): void {
		this.replace(text);
	}

	insertText(text: string): Promise<void> {
		this.replace(text);
		return Promise.resolve();
	}

	showDefinitionForSelection(): void {}

	findInPage(text: string, options: { forward?: boolean; matchCase?: boolean; findNext?: boolean } = {}): number {
		const find = (this.win as Window & { find?: (...args: unknown[]) => boolean }).find;
		const found = find ? find.call(this.win, text, !!options.matchCase, options.forward === false, true) : false;
		const requestId = nextId++;
		setTimeout(() => {
			this.emit(
				"found-in-page",
				{ preventDefault() {} },
				{
					requestId,
					activeMatchOrdinal: found ? 1 : 0,
					matches: found ? 1 : 0,
					finalUpdate: true,
					selectionArea: { x: 0, y: 0, width: 0, height: 0 },
				},
			);
		}, 0);
		return requestId;
	}

	stopFindInPage(): void {
		this.win.getSelection()?.removeAllRanges();
	}

	executeJavaScript(code: string): Promise<unknown> {
		return this.webFrame.executeJavaScript(code);
	}

	insertCSS(css: string): Promise<string> {
		return Promise.resolve(this.webFrame.insertCSS(css));
	}

	removeInsertedCSS(key: string): Promise<void> {
		this.webFrame.removeInsertCSS(key);
		return Promise.resolve();
	}

	async capturePage(): Promise<NativeImage> {
		return new NativeImage();
	}

	print(_options?: unknown, callback?: (success: boolean, reason: string) => void): void {
		this.win.print();
		callback?.(true, "");
	}

	async printToPDF(): Promise<never> {
		throw new Error("printToPDF is not available in the browser; use print() instead");
	}

	setWindowOpenHandler(): void {}

	setAudioMuted(muted: boolean): void {
		this.#audioMuted = muted;
	}

	isAudioMuted(): boolean {
		return this.#audioMuted;
	}

	setIgnoreMenuShortcuts(): void {}

	setBackgroundThrottling(): void {}

	getOSProcessId(): number {
		return 1;
	}

	getProcessId(): number {
		return 1;
	}

	setUserAgent(): void {}

	getUserAgent(): string {
		return navigator.userAgent;
	}

	invalidate(): void {}

	startDrag(): void {}

	downloadURL(url: string): void {
		const link = this.win.document.createElement("a");
		link.href = url;
		link.download = "";
		link.click();
	}
}

/** Electron's `BrowserWindow`, backed by a browser tab or a popup window. */
export class BrowserWindowShim extends EventEmitter {
	readonly id: number;
	readonly win: Window;
	readonly webContents: WebContentsShim;
	readonly isPopup: boolean;
	#alwaysOnTop = false;
	#title: string | null = null;
	#minSize: [number, number] = [0, 0];
	#parent: BrowserWindowShim | null = null;
	appMenu: unknown = null;
	focusTime = 0;

	constructor(win: Window, isPopup: boolean) {
		super();
		this.id = nextId++;
		this.win = win;
		this.isPopup = isPopup;
		this.webContents = new WebContentsShim(this);
		byWindow.set(win, this);
		byId.set(this.id, this);
		win.addEventListener("focus", () => {
			this.focusTime = Date.now();
			this.emit("focus");
		});
		win.addEventListener("blur", () => this.emit("blur"));
		win.document.addEventListener("fullscreenchange", () => {
			this.emit(win.document.fullscreenElement ? "enter-full-screen" : "leave-full-screen");
		});
		win.addEventListener("resize", () => this.emit("resize"));
		win.addEventListener("pagehide", () => {
			this.emit("close", { preventDefault() {} });
			this.emit("closed");
			byId.delete(this.id);
		});
	}

	static fromWebContents(contents: unknown): BrowserWindowShim | null {
		return contents instanceof WebContentsShim ? contents.owner : null;
	}

	static fromId(id: number): BrowserWindowShim | null {
		return byId.get(id) ?? null;
	}

	static getAllWindows(): BrowserWindowShim[] {
		return [...byId.values()].filter((shim) => !shim.win.closed);
	}

	static getFocusedWindow(): BrowserWindowShim | null {
		return BrowserWindowShim.getAllWindows().find((shim) => shim.win.document.hasFocus()) ?? null;
	}

	isDestroyed(): boolean {
		return this.win.closed;
	}

	destroy(): void {
		this.close();
	}

	close(): void {
		this.win.close();
	}

	focus(): void {
		this.win.focus();
	}

	blur(): void {
		this.win.blur();
	}

	isFocused(): boolean {
		return this.win.document.hasFocus();
	}

	show(): void {
		this.win.focus();
	}

	showInactive(): void {}

	hide(): void {}

	isVisible(): boolean {
		return this.win.document.visibilityState === "visible";
	}

	isMinimized(): boolean {
		return this.win.document.visibilityState === "hidden";
	}

	minimize(): void {}

	restore(): void {
		this.win.focus();
	}

	isMaximized(): boolean {
		return !this.isPopup;
	}

	maximize(): void {}

	unmaximize(): void {}

	isNormal(): boolean {
		return true;
	}

	isFullScreen(): boolean {
		return !!this.win.document.fullscreenElement;
	}

	setFullScreen(flag: boolean): void {
		const doc = this.win.document;
		if (flag && !doc.fullscreenElement) {
			doc.documentElement.requestFullscreen().catch(() => undefined);
		} else if (!flag && doc.fullscreenElement) {
			doc.exitFullscreen().catch(() => undefined);
		}
	}

	isSimpleFullScreen(): boolean {
		return this.isFullScreen();
	}

	setSimpleFullScreen(flag: boolean): void {
		this.setFullScreen(flag);
	}

	setFullScreenable(): void {}

	isFullScreenable(): boolean {
		return true;
	}

	setAlwaysOnTop(flag: boolean): void {
		this.#alwaysOnTop = flag;
		this.emit("always-on-top-changed", {}, flag);
	}

	isAlwaysOnTop(): boolean {
		return this.#alwaysOnTop;
	}

	setTitle(title: string): void {
		this.#title = title;
		this.win.document.title = title;
	}

	getTitle(): string {
		return this.#title ?? this.win.document.title;
	}

	getBounds(): { x: number; y: number; width: number; height: number } {
		return { x: this.win.screenX, y: this.win.screenY, width: this.win.outerWidth, height: this.win.outerHeight };
	}

	getContentBounds(): { x: number; y: number; width: number; height: number } {
		return { x: this.win.screenX, y: this.win.screenY, width: this.win.innerWidth, height: this.win.innerHeight };
	}

	getNormalBounds(): { x: number; y: number; width: number; height: number } {
		return this.getBounds();
	}

	setBounds(bounds: { x?: number; y?: number; width?: number; height?: number }): void {
		if (bounds.x !== undefined && bounds.y !== undefined) {
			this.win.moveTo(bounds.x, bounds.y);
		}
		if (bounds.width !== undefined && bounds.height !== undefined) {
			this.win.resizeTo(bounds.width, bounds.height);
		}
	}

	getSize(): [number, number] {
		return [this.win.outerWidth, this.win.outerHeight];
	}

	setSize(width: number, height: number): void {
		this.win.resizeTo(Math.max(width, this.#minSize[0]), Math.max(height, this.#minSize[1]));
	}

	getContentSize(): [number, number] {
		return [this.win.innerWidth, this.win.innerHeight];
	}

	setContentSize(width: number, height: number): void {
		this.setSize(width, height);
	}

	getPosition(): [number, number] {
		return [this.win.screenX, this.win.screenY];
	}

	setPosition(x: number, y: number): void {
		this.win.moveTo(x, y);
	}

	center(): void {}

	setMinimumSize(width: number, height: number): void {
		this.#minSize = [width, height];
	}

	getMinimumSize(): [number, number] {
		return this.#minSize;
	}

	setMaximumSize(): void {}

	setResizable(): void {}

	isResizable(): boolean {
		return true;
	}

	setMovable(): void {}

	setClosable(): void {}

	setFocusable(): void {}

	setParentWindow(parent: BrowserWindowShim | null): void {
		this.#parent = parent;
	}

	getParentWindow(): BrowserWindowShim | null {
		return this.#parent;
	}

	getChildWindows(): BrowserWindowShim[] {
		return BrowserWindowShim.getAllWindows().filter((shim) => shim.getParentWindow() === this);
	}

	setFrameZoomLevel(level: number): void {
		this.webContents.setZoomLevel(Math.max(-2.5, Math.min(3, level)));
	}

	setBackgroundColor(): void {}

	getBackgroundColor(): string {
		return "#00000000";
	}

	setVibrancy(): void {}

	setBackgroundMaterial(): void {}

	setWindowButtonVisibility(): void {}

	setWindowButtonPosition(): void {}

	getWindowButtonPosition(): null {
		return null;
	}

	setTrafficLightPosition(): void {}

	getTrafficLightPosition(): { x: number; y: number } {
		return { x: 0, y: 0 };
	}

	setMenu(menu: unknown): void {
		this.appMenu = menu;
	}

	removeMenu(): void {
		this.appMenu = null;
	}

	setMenuBarVisibility(): void {}

	isMenuBarVisible(): boolean {
		return false;
	}

	setAutoHideMenuBar(): void {}

	setProgressBar(): void {}

	flashFrame(): void {}

	setSkipTaskbar(): void {}

	setIcon(): void {}

	setOverlayIcon(): void {}

	setRepresentedFilename(): void {}

	setDocumentEdited(): void {}

	setTitleBarOverlay(): void {}

	setContentProtection(): void {}

	setOpacity(): void {}

	getOpacity(): number {
		return 1;
	}

	setHasShadow(): void {}

	setIgnoreMouseEvents(): void {}

	setVisibleOnAllWorkspaces(): void {}

	moveTop(): void {
		this.win.focus();
	}

	invalidateShadow(): void {}

	getNativeWindowHandle(): Uint8Array {
		return new Uint8Array(8);
	}

	loadURL(url: string): Promise<void> {
		this.win.location.href = url;
		return Promise.resolve();
	}

	reload(): void {
		this.win.location.reload();
	}
}

export function getWindowShim(win: Window, isPopup = false): BrowserWindowShim {
	return byWindow.get(win) ?? new BrowserWindowShim(win, isPopup);
}

const extraContents = new Map<number, unknown>();

/** Registers a webContents-like object (used by `<webview>` elements) for `webContents.fromId`. */
export function registerWebContents(id: number, contents: unknown): void {
	extraContents.set(id, contents);
}

export function webContentsFromId(id: number): unknown {
	return byId.get(id)?.webContents ?? extraContents.get(id) ?? null;
}

export const webContentsModule = {
	fromId: webContentsFromId,
	getAllWebContents: () => BrowserWindowShim.getAllWindows().map((shim) => shim.webContents),
	getFocusedWebContents: () => BrowserWindowShim.getFocusedWindow()?.webContents ?? null,
	fromFrame: () => null,
	fromDevToolsTargetId: () => null,
};
