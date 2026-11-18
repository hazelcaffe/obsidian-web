export type ModuleFactory = () => unknown;
export type WindowModuleFactory = (win: Window) => unknown;

const shared = new Map<string, ModuleFactory>();
const perWindow = new Map<string, WindowModuleFactory>();
const sharedCache = new Map<string, unknown>();
const windowCaches = new WeakMap<Window, Map<string, unknown>>();

export function defineModule(names: string | string[], factory: ModuleFactory): void {
	for (const name of Array.isArray(names) ? names : [names]) {
		shared.set(name, factory);
	}
}

export function defineWindowModule(names: string | string[], factory: WindowModuleFactory): void {
	for (const name of Array.isArray(names) ? names : [names]) {
		perWindow.set(name, factory);
	}
}

export function builtinModules(): string[] {
	return [...shared.keys(), ...perWindow.keys()].sort();
}

function notFound(name: string): Error {
	return Object.assign(new Error(`Cannot find module '${name}'`), { code: "MODULE_NOT_FOUND" });
}

function normalize(name: string): string {
	return name.startsWith("node:") ? name.slice(5) : name;
}

export function loadModule(win: Window, request: string): unknown {
	const name = normalize(request);
	const windowFactory = perWindow.get(name);
	if (windowFactory) {
		let cache = windowCaches.get(win);
		if (!cache) {
			cache = new Map();
			windowCaches.set(win, cache);
		}
		if (!cache.has(name)) {
			cache.set(name, windowFactory(win));
		}
		return cache.get(name);
	}
	if (sharedCache.has(name)) {
		return sharedCache.get(name);
	}
	const factory = shared.get(name);
	if (!factory) {
		throw notFound(request);
	}
	const value = factory();
	sharedCache.set(name, value);
	return value;
}

export interface BrowserRequire {
	(request: string): unknown;
	resolve: ((request: string) => string) & { paths: (request: string) => string[] | null };
	cache: Record<string, unknown>;
	main: undefined;
}

export function createRequire(win: Window): BrowserRequire {
	const require = ((request: string) => loadModule(win, request)) as BrowserRequire;
	require.resolve = Object.assign(
		(request: string) => {
			const name = normalize(request);
			if (shared.has(name) || perWindow.has(name)) {
				return request;
			}
			throw notFound(request);
		},
		{ paths: () => null },
	);
	require.cache = {};
	require.main = undefined;
	return require;
}
