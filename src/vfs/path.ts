import { invalidArgType, invalidArgValue, nodeError } from "./errors.ts";

export type PathLike = string | Uint8Array | URL;

const decoder = new TextDecoder();

function isUrlLike(value: unknown): value is URL {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { href?: unknown }).href === "string" &&
		typeof (value as { protocol?: unknown }).protocol === "string" &&
		typeof (value as { pathname?: unknown }).pathname === "string"
	);
}

export function fileUrlToPath(url: URL | string): string {
	const parsed = typeof url === "string" ? new URL(url) : url;
	if (parsed.protocol !== "file:") {
		throw nodeError("ERR_INVALID_URL_SCHEME", "The URL must be of scheme file", TypeError);
	}
	if (parsed.hostname !== "" && parsed.hostname !== "localhost") {
		throw nodeError("ERR_INVALID_FILE_URL_HOST", `File URL host must be "localhost" or empty on linux`, TypeError);
	}
	if (/%2f/i.test(parsed.pathname)) {
		throw nodeError("ERR_INVALID_FILE_URL_PATH", "File URL path must not include encoded / characters", TypeError);
	}
	return decodeURIComponent(parsed.pathname);
}

/** Convert a `PathLike` argument to a string, validating it like Node does. */
export function pathArg(value: unknown, name = "path"): string {
	let path: string;
	if (typeof value === "string") {
		path = value;
	} else if (value instanceof Uint8Array) {
		path = decoder.decode(value);
	} else if (isUrlLike(value)) {
		path = fileUrlToPath(value);
	} else {
		throw invalidArgType(name, "of type string or an instance of Buffer or URL", value);
	}
	if (path.includes("\u0000")) {
		throw invalidArgValue(name, path, "must be a string, Uint8Array, or URL without null bytes");
	}
	return path;
}

export function splitPath(path: string): string[] {
	return path.split("/").filter((part) => part !== "" && part !== ".");
}

/** Resolve `path` against `cwd` and normalize `.`, `..` and duplicate slashes. */
export function resolvePath(cwd: string, path: string): string {
	const full = path.startsWith("/") ? path : `${cwd}/${path}`;
	const out: string[] = [];
	for (const part of splitPath(full)) {
		if (part === "..") {
			out.pop();
		} else {
			out.push(part);
		}
	}
	return `/${out.join("/")}`;
}

export function dirname(path: string): string {
	const index = path.lastIndexOf("/");
	return index <= 0 ? "/" : path.slice(0, index);
}

export function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(dir: string, name: string): string {
	return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** True if `ancestor` is a strict ancestor of `path` (both normalized absolute paths). */
export function isAncestor(ancestor: string, path: string): boolean {
	if (ancestor === "/") {
		return path !== "/";
	}
	return path.length > ancestor.length && path.startsWith(ancestor) && path[ancestor.length] === "/";
}

export function isSameOrAncestor(ancestor: string, path: string): boolean {
	return ancestor === path || isAncestor(ancestor, path);
}

/** Path of `path` relative to its ancestor `base` ("" if equal). */
export function relativeTo(base: string, path: string): string {
	if (base === path) {
		return "";
	}
	return base === "/" ? path.slice(1) : path.slice(base.length + 1);
}
