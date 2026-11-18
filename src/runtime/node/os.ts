import { HOME, HOSTNAME, PLATFORM, TEMP, USERNAME } from "../env.ts";

const signals: Record<string, number> = {
	SIGHUP: 1,
	SIGINT: 2,
	SIGQUIT: 3,
	SIGILL: 4,
	SIGTRAP: 5,
	SIGABRT: 6,
	SIGBUS: 7,
	SIGFPE: 8,
	SIGKILL: 9,
	SIGUSR1: 10,
	SIGSEGV: 11,
	SIGUSR2: 12,
	SIGPIPE: 13,
	SIGALRM: 14,
	SIGTERM: 15,
	SIGCHLD: 17,
	SIGCONT: 18,
	SIGSTOP: 19,
	SIGTSTP: 20,
};

const errno: Record<string, number> = {
	E2BIG: 7,
	EACCES: 13,
	EADDRINUSE: 98,
	EAGAIN: 11,
	EBADF: 9,
	EBUSY: 16,
	ECONNREFUSED: 111,
	ECONNRESET: 104,
	EEXIST: 17,
	EINVAL: 22,
	EIO: 5,
	EISDIR: 21,
	ELOOP: 40,
	EMFILE: 24,
	ENAMETOOLONG: 36,
	ENOENT: 2,
	ENOSPC: 28,
	ENOSYS: 38,
	ENOTDIR: 20,
	ENOTEMPTY: 39,
	EPERM: 1,
	EPIPE: 32,
	ETIMEDOUT: 110,
};

function cpus(): Array<{ model: string; speed: number; times: Record<string, number> }> {
	const count = navigator.hardwareConcurrency || 4;
	return Array.from({ length: count }, () => ({
		model: "Browser CPU",
		speed: 2400,
		times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
	}));
}

function totalmem(): number {
	const gigabytes = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
	return gigabytes * 1024 ** 3;
}

function userAgentVersion(): string {
	const match = /\(([^)]+)\)/.exec(navigator.userAgent);
	return match?.[1] ?? "Browser";
}

export const os = {
	EOL: "\n",
	devNull: "/dev/null",
	arch: () => "x64",
	machine: () => "x86_64",
	platform: () => PLATFORM,
	type: () => (PLATFORM === "darwin" ? "Darwin" : "Linux"),
	release: () => "6.0.0",
	version: () => userAgentVersion(),
	hostname: () => HOSTNAME,
	homedir: () => HOME,
	tmpdir: () => TEMP,
	endianness: () => "LE",
	uptime: () => Math.floor(performance.now() / 1000),
	loadavg: () => [0, 0, 0],
	totalmem,
	freemem: () => totalmem() / 2,
	availableParallelism: () => navigator.hardwareConcurrency || 4,
	cpus,
	networkInterfaces: () => ({}),
	userInfo: () => ({ uid: 1000, gid: 1000, username: USERNAME, homedir: HOME, shell: "/bin/sh" }),
	getPriority: () => 0,
	setPriority: () => undefined,
	constants: {
		signals,
		errno,
		priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_HIGH: -7 },
		UV_UDP_REUSEADDR: 4,
	},
};
