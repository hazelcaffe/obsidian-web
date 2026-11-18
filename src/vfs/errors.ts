const SYSTEM_ERRORS = {
	EPERM: [-1, "operation not permitted"],
	ENOENT: [-2, "no such file or directory"],
	EIO: [-5, "i/o error"],
	EBADF: [-9, "bad file descriptor"],
	EAGAIN: [-11, "resource temporarily unavailable"],
	EACCES: [-13, "permission denied"],
	EBUSY: [-16, "resource busy or locked"],
	EEXIST: [-17, "file already exists"],
	EXDEV: [-18, "cross-device link not permitted"],
	ENOTDIR: [-20, "not a directory"],
	EISDIR: [-21, "illegal operation on a directory"],
	EINVAL: [-22, "invalid argument"],
	EMFILE: [-24, "too many open files"],
	ENOSPC: [-28, "no space left on device"],
	EROFS: [-30, "read-only file system"],
	ENAMETOOLONG: [-36, "name too long"],
	ENOSYS: [-38, "function not implemented"],
	ENOTEMPTY: [-39, "directory not empty"],
	ELOOP: [-40, "too many symbolic links encountered"],
	ENOTSUP: [-95, "operation not supported on socket"],
	ECANCELED: [-125, "operation canceled"],
} as const;

export type ErrorCode = keyof typeof SYSTEM_ERRORS;

export interface FsError extends Error {
	code: string;
	errno?: number;
	syscall?: string;
	path?: string;
	dest?: string;
}

export function fsError(code: ErrorCode, syscall: string, path?: string, dest?: string, detail?: string): FsError {
	const [errno, description] = SYSTEM_ERRORS[code];
	let message = `${code}: ${description}${detail ? ` (${detail})` : ""}, ${syscall}`;
	if (path !== undefined) {
		message += ` '${path}'`;
	}
	if (dest !== undefined) {
		message += ` -> '${dest}'`;
	}
	const error: FsError = Object.assign(new Error(message), { errno, code, syscall });
	if (path !== undefined) {
		error.path = path;
	}
	if (dest !== undefined) {
		error.dest = dest;
	}
	return error;
}

export function isFsError(value: unknown, code?: string): value is FsError {
	return (
		value instanceof Error &&
		"code" in value &&
		typeof value.code === "string" &&
		(code === undefined || value.code === code)
	);
}

/** Node's internal `ERR_*` errors (TypeError/RangeError/SystemError style). */
export function nodeError(
	code: string,
	message: string,
	ErrorClass: ErrorConstructor | TypeErrorConstructor | RangeErrorConstructor = Error,
	extra: Record<string, unknown> = {},
): FsError {
	return Object.assign(new ErrorClass(message), { code }, extra);
}

export function invalidArgType(name: string, expected: string, actual: unknown): FsError {
	return nodeError(
		"ERR_INVALID_ARG_TYPE",
		`The "${name}" argument must be ${expected}. Received ${describe(actual)}`,
		TypeError,
	);
}

export function invalidArgValue(name: string, value: unknown, reason = "is invalid"): FsError {
	return nodeError(
		"ERR_INVALID_ARG_VALUE",
		`The argument '${name}' ${reason}. Received ${describe(value)}`,
		TypeError,
	);
}

export function outOfRange(name: string, range: string, value: unknown): FsError {
	return nodeError(
		"ERR_OUT_OF_RANGE",
		`The value of "${name}" is out of range. It must be ${range}. Received ${describe(value)}`,
		RangeError,
	);
}

export function abortError(signal?: { reason?: unknown }): FsError {
	return Object.assign(new Error("The operation was aborted"), {
		name: "AbortError",
		code: "ABORT_ERR",
		cause: signal?.reason,
	});
}

function describe(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (value === undefined) {
		return "undefined";
	}
	if (typeof value === "function") {
		return `function ${value.name}`;
	}
	if (typeof value === "object") {
		const name = value.constructor?.name;
		return name ? `an instance of ${name}` : "an object";
	}
	let shown = String(value);
	if (shown.length > 28) {
		shown = `${shown.slice(0, 25)}...`;
	}
	if (typeof value === "string") {
		shown = `'${shown}'`;
	}
	return `type ${typeof value} (${shown})`;
}

/** Map a DOMException thrown by OPFS to a Node-style error. */
export function fromDomError(error: unknown, syscall: string, path: string): FsError {
	if (isFsError(error)) {
		return error;
	}
	const name = error instanceof Error || isNamed(error) ? error.name : "";
	let code: ErrorCode = "EIO";
	switch (name) {
		case "NotFoundError":
			code = "ENOENT";
			break;
		case "TypeMismatchError":
			code = "ENOTDIR";
			break;
		case "QuotaExceededError":
			code = "ENOSPC";
			break;
		case "InvalidModificationError":
			code = "ENOTEMPTY";
			break;
		case "NoModificationAllowedError":
			code = "EBUSY";
			break;
		case "NotAllowedError":
		case "SecurityError":
			code = "EACCES";
			break;
	}
	const message = error instanceof Error ? error.message : String(error);
	const result = fsError(code, syscall, path, undefined, message || undefined);
	result.cause = error;
	return result;
}

function isNamed(value: unknown): value is { name: string } {
	return typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";
}

export function isDomError(error: unknown, name: string): boolean {
	return isNamed(error) && error.name === name;
}
