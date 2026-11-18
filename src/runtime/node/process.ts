import { EventEmitter } from "events";
import {
	APP_PATH,
	chromeVersion,
	ELECTRON_VERSION,
	EXEC_PATH,
	HOME,
	NODE_VERSION,
	PLATFORM,
	USERNAME,
} from "../env.ts";

let cwd = "/";
const startTime = performance.now();

function hrtime(previous?: [number, number]): [number, number] {
	const now = performance.timeOrigin + performance.now();
	let seconds = Math.floor(now / 1000);
	let nanos = Math.floor((now % 1000) * 1e6);
	if (previous) {
		seconds -= previous[0];
		nanos -= previous[1];
		if (nanos < 0) {
			seconds--;
			nanos += 1e9;
		}
	}
	return [seconds, nanos];
}
hrtime.bigint = (): bigint => BigInt(Math.floor((performance.timeOrigin + performance.now()) * 1e6));

function writeOutput(log: (text: string) => void, text: unknown): boolean {
	log(String(text).replace(/\n$/, ""));
	return true;
}

export interface BrowserProcess extends EventEmitter {
	[key: string]: unknown;
	platform: string;
	env: Record<string, string | undefined>;
	versions: Record<string, string>;
	cwd(): string;
	chdir(dir: string): void;
	nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void;
}

const env: Record<string, string | undefined> = {
	HOME,
	USER: USERNAME,
	LOGNAME: USERNAME,
	SHELL: "/bin/sh",
	PATH: "/usr/local/bin:/usr/bin:/bin",
	LANG: `${(navigator.language || "en-US").replace("-", "_")}.UTF-8`,
	TMPDIR: "/tmp",
	TERM: "xterm-256color",
	NODE_ENV: "production",
};

export const process = Object.assign(new EventEmitter(), {
	title: "obsidian",
	type: "renderer",
	platform: PLATFORM,
	arch: "x64",
	version: `v${NODE_VERSION}`,
	versions: {
		node: NODE_VERSION,
		electron: ELECTRON_VERSION,
		chrome: chromeVersion(),
		v8: "14.0.0",
		uv: "1.51.0",
		modules: "140",
		napi: "10",
	},
	release: { name: "node" },
	env,
	argv: [EXEC_PATH],
	argv0: "obsidian",
	execArgv: [] as string[],
	execPath: EXEC_PATH,
	resourcesPath: APP_PATH.slice(0, APP_PATH.lastIndexOf("/")),
	pid: 1000 + Math.floor(Math.random() * 30000),
	ppid: 1,
	exitCode: undefined as number | undefined,
	contextIsolated: false,
	sandboxed: false,
	noDeprecation: true,
	throwDeprecation: false,
	traceDeprecation: false,
	browser: false,
	config: { variables: {} },
	features: { inspector: false, ipv6: true, tls: true },
	stdout: { write: (text: string) => writeOutput(console.log, text), isTTY: false },
	stderr: { write: (text: string) => writeOutput(console.error, text), isTTY: false },
	stdin: { isTTY: false, on() {}, resume() {}, pause() {} },
	cwd: (): string => cwd,
	chdir: (dir: string): void => {
		cwd = dir.startsWith("/") ? dir : `${cwd.replace(/\/$/, "")}/${dir}`;
	},
	umask: (): number => 0o022,
	getuid: (): number => 1000,
	geteuid: (): number => 1000,
	getgid: (): number => 1000,
	getegid: (): number => 1000,
	getgroups: (): number[] => [1000],
	nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void {
		queueMicrotask(() => callback(...args));
	},
	hrtime,
	uptime: (): number => (performance.now() - startTime) / 1000,
	memoryUsage: Object.assign(
		() => {
			const memory = (
				performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }
			).memory;
			const used = memory?.usedJSHeapSize ?? 0;
			return { rss: used, heapTotal: memory?.totalJSHeapSize ?? 0, heapUsed: used, external: 0, arrayBuffers: 0 };
		},
		{ rss: () => 0 },
	),
	cpuUsage: () => ({ user: 0, system: 0 }),
	resourceUsage: () => ({}),
	getSystemMemoryInfo: () => ({ total: 8 * 1024 * 1024, free: 4 * 1024 * 1024 }),
	getProcessMemoryInfo: async () => ({ private: 0, shared: 0, residentSet: 0 }),
	getHeapStatistics: () => ({}),
	getCPUUsage: () => ({ percentCPUUsage: 0, idleWakeupsPerSecond: 0 }),
	emitWarning: (warning: unknown): void => console.warn(warning),
	binding: (name: string): never => {
		throw new Error(`No such module: ${name}`);
	},
	dlopen: (): never => {
		throw new Error("Native modules are not supported in the browser");
	},
	kill: (): boolean => false,
	exit: (code?: number): void => {
		console.warn(`process.exit(${code ?? 0}) ignored`);
	},
	abort: (): void => {
		console.warn("process.abort() ignored");
	},
	crash: (): void => {},
	hang: (): void => {},
}) as unknown as BrowserProcess;
