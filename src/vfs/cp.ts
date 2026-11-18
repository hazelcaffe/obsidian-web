import { integerArg, optionsArg } from "./args.ts";
import type { VfsCore } from "./core.ts";
import { invalidArgType, nodeError } from "./errors.ts";
import { dirname, isSameOrAncestor, joinPath, pathArg, resolvePath } from "./path.ts";
import type { Stats } from "./stats.ts";

export interface CpOptions {
	dereference: boolean;
	errorOnExist: boolean;
	filter: ((source: string, destination: string) => unknown) | undefined;
	force: boolean;
	preserveTimestamps: boolean;
	recursive: boolean;
	verbatimSymlinks: boolean;
	mode: number;
}

type Step = () => unknown;
type CpGenerator<T> = Generator<Step, T, unknown>;

function* call<T>(fn: () => T): CpGenerator<T> {
	// The driver feeds back the (awaited, in async mode) result of `fn`.
	return (yield fn) as T;
}

function cpError(code: string, errno: string, detail: string, path: string): Error {
	const prefixes: Record<string, string> = {
		ERR_FS_CP_EINVAL: "Invalid src or dest",
		ERR_FS_CP_DIR_TO_NON_DIR: "Cannot overwrite non-directory with directory",
		ERR_FS_CP_NON_DIR_TO_DIR: "Cannot overwrite directory with non-directory",
		ERR_FS_CP_EEXIST: "Target already exists",
		ERR_FS_EISDIR: "Recursive option not enabled, cannot copy a directory",
	};
	return nodeError(code, `${prefixes[code] ?? "cp failed"}: cp returned ${errno} (${detail}) ${path}`, Error, {
		path,
		syscall: "cp",
	});
}

export function parseCpOptions(options: unknown): CpOptions {
	const opts = optionsArg(options);
	const filter = opts.filter;
	if (filter !== undefined && typeof filter !== "function") {
		throw invalidArgType("options.filter", "of type function", filter);
	}
	return {
		dereference: opts.dereference === true,
		errorOnExist: opts.errorOnExist === true,
		filter:
			typeof filter === "function"
				? (source, destination) => Reflect.apply(filter, undefined, [source, destination])
				: undefined,
		force: opts.force !== false,
		preserveTimestamps: opts.preserveTimestamps === true,
		recursive: opts.recursive === true,
		verbatimSymlinks: opts.verbatimSymlinks === true,
		mode: opts.mode === undefined ? 0 : integerArg(opts.mode, "options.mode"),
	};
}

function checkPair(src: string, dest: string, srcStat: Stats, destStat: Stats | undefined): void {
	if (destStat) {
		if (srcStat.ino === destStat.ino && srcStat.dev === destStat.dev) {
			throw cpError("ERR_FS_CP_EINVAL", "EINVAL", "src and dest cannot be the same", dest);
		}
		if (srcStat.isDirectory() && !destStat.isDirectory()) {
			throw cpError(
				"ERR_FS_CP_DIR_TO_NON_DIR",
				"EISDIR",
				`cannot overwrite non-directory ${dest} with directory ${src}`,
				dest,
			);
		}
		if (!srcStat.isDirectory() && destStat.isDirectory()) {
			throw cpError(
				"ERR_FS_CP_NON_DIR_TO_DIR",
				"ENOTDIR",
				`cannot overwrite directory ${dest} with non-directory ${src}`,
				dest,
			);
		}
	}
}

function* copyEntry(
	core: VfsCore,
	src: string,
	dest: string,
	srcStat: Stats,
	destStat: Stats | undefined,
	options: CpOptions,
): CpGenerator<void> {
	if (srcStat.isDirectory()) {
		if (!options.recursive) {
			throw cpError("ERR_FS_EISDIR", "EISDIR", `${src} is a directory (not copied)`, src);
		}
		if (!destStat) {
			yield* call(() => core.mkdir(dest, false, 0o777));
			yield* call(() => core.chmod(dest, srcStat.mode, true));
		}
		const names = yield* call(() => core.readdir(src, false).map((entry) => entry.name));
		for (const name of names) {
			const childSrc = joinPath(src, name);
			const childDest = joinPath(dest, name);
			const filter = options.filter;
			if (filter && !(yield* call(() => filter(childSrc, childDest)))) {
				continue;
			}
			const childSrcStat = yield* call(() => core.stat(childSrc, options.dereference));
			const childDestStat = yield* call(() => core.stat(childDest, false, false));
			checkPair(childSrc, childDest, childSrcStat, childDestStat);
			yield* copyEntry(core, childSrc, childDest, childSrcStat, childDestStat, options);
		}
	} else if (srcStat.isSymbolicLink()) {
		let target = yield* call(() => core.readlink(src));
		if (!options.verbatimSymlinks && !target.startsWith("/")) {
			target = resolvePath(dirname(src), target);
		}
		if (destStat) {
			if (!options.force) {
				if (options.errorOnExist) {
					throw cpError("ERR_FS_CP_EEXIST", "EEXIST", `${dest} already exists`, dest);
				}
				return;
			}
			yield* call(() => core.unlink(dest));
		}
		yield* call(() => core.symlink(target, dest));
	} else {
		if (destStat) {
			if (!options.force) {
				if (options.errorOnExist) {
					throw cpError("ERR_FS_CP_EEXIST", "EEXIST", `${dest} already exists`, dest);
				}
				return;
			}
			yield* call(() => core.unlink(dest));
		}
		yield* call(() => core.copyFile(src, dest, options.mode));
	}
	if (options.preserveTimestamps && !srcStat.isSymbolicLink()) {
		yield* call(() => core.utimes(dest, srcStat.atimeMs, srcStat.mtimeMs, true));
	}
}

function* cpGenerator(core: VfsCore, source: unknown, destination: unknown, options: CpOptions): CpGenerator<void> {
	const src = resolvePath(core.cwd(), pathArg(source, "src"));
	const dest = resolvePath(core.cwd(), pathArg(destination, "dest"));
	const filter = options.filter;
	if (filter && !(yield* call(() => filter(src, dest)))) {
		return;
	}
	const srcStat = yield* call(() => core.stat(src, options.dereference));
	const destStat = yield* call(() => core.stat(dest, false, false));
	checkPair(src, dest, srcStat, destStat);
	if (srcStat.isDirectory() && isSameOrAncestor(src, dest)) {
		throw cpError("ERR_FS_CP_EINVAL", "EINVAL", `cannot copy ${src} to a subdirectory of self ${dest}`, dest);
	}
	yield* call(() => core.mkdir(dirname(dest), true, 0o777));
	yield* copyEntry(core, src, dest, srcStat, destStat, options);
}

export function cpSync(core: VfsCore, source: unknown, destination: unknown, options?: unknown): void {
	const generator = cpGenerator(core, source, destination, parseCpOptions(options));
	for (let step = generator.next(); !step.done; ) {
		step = generator.next(step.value());
	}
}

export async function cpAsync(core: VfsCore, source: unknown, destination: unknown, options?: unknown): Promise<void> {
	const generator = cpGenerator(core, source, destination, parseCpOptions(options));
	for (let step = generator.next(); !step.done; ) {
		step = generator.next(await core.run(step.value));
	}
}
