import { EventEmitter } from "events";

const SPELLCHECK_KEY = "obsidian-web:spellcheck-words";

function readWords(): string[] {
	try {
		const parsed = JSON.parse(localStorage.getItem(SPELLCHECK_KEY) ?? "[]") as unknown;
		return Array.isArray(parsed) ? parsed.filter((word): word is string => typeof word === "string") : [];
	} catch {
		return [];
	}
}

function writeWords(words: string[]): void {
	localStorage.setItem(SPELLCHECK_KEY, JSON.stringify(words));
}

/** Electron's `Session`. Spell checking is done by the browser, so the dictionary APIs only keep state. */
export class Session extends EventEmitter {
	readonly partition: string;
	#languages: string[] = [navigator.language];
	#spellcheck = true;
	#userAgent = navigator.userAgent;
	readonly availableSpellCheckerLanguages: string[] = [...new Set([...(navigator.languages ?? []), "en-US"])];
	readonly webRequest = {
		onBeforeRequest() {},
		onBeforeSendHeaders() {},
		onSendHeaders() {},
		onHeadersReceived() {},
		onResponseStarted() {},
		onBeforeRedirect() {},
		onCompleted() {},
		onErrorOccurred() {},
	};
	readonly cookies = Object.assign(new EventEmitter(), {
		get: async () => [],
		set: async () => undefined,
		remove: async () => undefined,
		flushStore: async () => undefined,
	});
	readonly protocol = {
		handle() {},
		unhandle() {},
		isProtocolHandled: () => false,
		registerFileProtocol: () => true,
		registerStringProtocol: () => true,
	};

	constructor(partition: string) {
		super();
		this.partition = partition;
	}

	setSpellCheckerLanguages(languages: string[]): void {
		this.#languages = [...languages];
	}

	getSpellCheckerLanguages(): string[] {
		return this.#languages;
	}

	setSpellCheckerEnabled(enabled: boolean): void {
		this.#spellcheck = enabled;
	}

	isSpellCheckerEnabled(): boolean {
		return this.#spellcheck;
	}

	setSpellCheckerDictionaryDownloadURL(): void {}

	async listWordsInSpellCheckerDictionary(): Promise<string[]> {
		return readWords();
	}

	addWordToSpellCheckerDictionary(word: string): boolean {
		const words = readWords();
		if (!words.includes(word)) {
			words.push(word);
			writeWords(words);
		}
		return true;
	}

	removeWordFromSpellCheckerDictionary(word: string): boolean {
		writeWords(readWords().filter((existing) => existing !== word));
		return true;
	}

	setUserAgent(userAgent: string): void {
		this.#userAgent = userAgent;
	}

	getUserAgent(): string {
		return this.#userAgent;
	}

	setPermissionRequestHandler(): void {}

	setPermissionCheckHandler(): void {}

	setDevicePermissionHandler(): void {}

	setDisplayMediaRequestHandler(): void {}

	async clearCache(): Promise<void> {}

	async clearStorageData(): Promise<void> {}

	async clearHostResolverCache(): Promise<void> {}

	async getCacheSize(): Promise<number> {
		return 0;
	}

	async setProxy(): Promise<void> {}

	async resolveProxy(): Promise<string> {
		return "DIRECT";
	}

	async closeAllConnections(): Promise<void> {}

	setPreloads(): void {}

	getPreloads(): string[] {
		return [];
	}

	async loadExtension(): Promise<never> {
		throw new Error("Extensions are not supported");
	}

	getAllExtensions(): unknown[] {
		return [];
	}

	setDownloadPath(): void {}
}

const sessions = new Map<string, Session>();

export function getSession(partition: string): Session {
	let session = sessions.get(partition);
	if (!session) {
		session = new Session(partition);
		sessions.set(partition, session);
	}
	return session;
}
