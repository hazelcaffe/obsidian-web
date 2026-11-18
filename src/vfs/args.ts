import { O_APPEND, O_CREAT, O_EXCL, O_RDONLY, O_RDWR, O_SYNC, O_TRUNC, O_WRONLY } from "./constants.ts";
import { type EncodingOption, encodeString, isArrayBufferView, parseEncoding, viewBytes } from "./encoding.ts";
import { abortError, invalidArgType, invalidArgValue, outOfRange } from "./errors.ts";

export type Options = Record<string, unknown>;

export function isObject(value: unknown): value is Options {
	return typeof value === "object" && value !== null;
}

/** Normalize an `options` argument: a string means `{ encoding }`. */
export function optionsArg(options: unknown, name = "options"): Options {
	if (options === undefined || options === null || typeof options === "function") {
		return {};
	}
	if (typeof options === "string") {
		return { encoding: options };
	}
	if (isObject(options)) {
		return options;
	}
	throw invalidArgType(name, "of type string or an instance of Object", options);
}

export function encodingOption(options: Options, fallback?: EncodingOption): EncodingOption | undefined {
	return parseEncoding(options.encoding, fallback);
}

const FLAGS: Record<string, number> = {
	r: O_RDONLY,
	rs: O_RDONLY | O_SYNC,
	sr: O_RDONLY | O_SYNC,
	"r+": O_RDWR,
	"rs+": O_RDWR | O_SYNC,
	"sr+": O_RDWR | O_SYNC,
	w: O_TRUNC | O_CREAT | O_WRONLY,
	wx: O_TRUNC | O_CREAT | O_WRONLY | O_EXCL,
	xw: O_TRUNC | O_CREAT | O_WRONLY | O_EXCL,
	"w+": O_TRUNC | O_CREAT | O_RDWR,
	"wx+": O_TRUNC | O_CREAT | O_RDWR | O_EXCL,
	"xw+": O_TRUNC | O_CREAT | O_RDWR | O_EXCL,
	a: O_APPEND | O_CREAT | O_WRONLY,
	ax: O_APPEND | O_CREAT | O_WRONLY | O_EXCL,
	xa: O_APPEND | O_CREAT | O_WRONLY | O_EXCL,
	as: O_APPEND | O_CREAT | O_WRONLY | O_SYNC,
	sa: O_APPEND | O_CREAT | O_WRONLY | O_SYNC,
	"a+": O_APPEND | O_CREAT | O_RDWR,
	"ax+": O_APPEND | O_CREAT | O_RDWR | O_EXCL,
	"xa+": O_APPEND | O_CREAT | O_RDWR | O_EXCL,
	"as+": O_APPEND | O_CREAT | O_RDWR | O_SYNC,
	"sa+": O_APPEND | O_CREAT | O_RDWR | O_SYNC,
};

export function flagsArg(flags: unknown, fallback: number): number {
	if (flags === undefined || flags === null) {
		return fallback;
	}
	if (typeof flags === "number" && Number.isInteger(flags)) {
		return flags;
	}
	if (typeof flags === "string") {
		const value = FLAGS[flags];
		if (value !== undefined) {
			return value;
		}
	}
	throw invalidArgValue("flags", flags, "is invalid");
}

export function modeArg(mode: unknown, fallback: number, name = "mode"): number {
	if (mode === undefined || mode === null) {
		return fallback;
	}
	if (typeof mode === "number" && Number.isInteger(mode) && mode >= 0 && mode <= 0xffffffff) {
		return mode;
	}
	if (typeof mode === "string" && /^[0-7]+$/.test(mode)) {
		return Number.parseInt(mode, 8);
	}
	throw invalidArgValue(name, mode, "must be a 32-bit unsigned integer or an octal string");
}

export function integerArg(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	const number = typeof value === "bigint" ? Number(value) : value;
	if (typeof number !== "number") {
		throw invalidArgType(name, "of type number", value);
	}
	if (!Number.isInteger(number) || number < min || number > max) {
		throw outOfRange(name, `an integer >= ${min} && <= ${max}`, value);
	}
	return number;
}

export function fdArg(fd: unknown): number {
	return integerArg(fd, "fd", 0, 2147483647);
}

/** `null`, `undefined` and -1 mean "current file position". */
export function positionArg(position: unknown): number | null {
	if (position === undefined || position === null || position === -1 || position === -1n) {
		return null;
	}
	return integerArg(position, "position");
}

export function lengthArg(length: unknown, fallback = 0): number {
	if (length === undefined || length === null) {
		return fallback;
	}
	return Math.max(0, integerArg(length, "len", Number.MIN_SAFE_INTEGER));
}

/** Convert a time argument (seconds, numeric string or Date) to milliseconds. */
export function timeArg(time: unknown, name: string): number {
	if (typeof time === "string" && time.trim() !== "" && Number.isFinite(Number(time))) {
		return Number(time) * 1000;
	}
	if (typeof time === "number") {
		return Number.isFinite(time) && time >= 0 ? time * 1000 : Date.now();
	}
	if (typeof time === "bigint") {
		return Number(time) * 1000;
	}
	if (time instanceof Date) {
		return time.getTime();
	}
	throw invalidArgType(name, "of type number or an instance of Date", time);
}

export function callbackArg(callback: unknown): (...args: unknown[]) => void {
	if (typeof callback !== "function") {
		throw invalidArgType("cb", "of type function", callback);
	}
	return (...args) => Reflect.apply(callback, undefined, args);
}

export function checkAborted(signal: unknown): void {
	if (isObject(signal) && signal.aborted === true) {
		throw abortError(signal);
	}
}

export interface BufferSlice {
	buffer: Uint8Array;
	offset: number;
	length: number;
	position: number | null;
}

/** Parse `(buffer, offset, length, position)` or `(buffer, { offset, length, position })` for reads. */
export function readArgs(
	buffer: unknown,
	offsetOrOptions?: unknown,
	length?: unknown,
	position?: unknown,
): BufferSlice {
	if (!isArrayBufferView(buffer)) {
		throw invalidArgType("buffer", "an instance of Buffer, TypedArray, or DataView", buffer);
	}
	const bytes = viewBytes(buffer);
	let offsetValue = offsetOrOptions;
	let lengthValue = length;
	let positionValue = position;
	if (isObject(offsetOrOptions)) {
		offsetValue = offsetOrOptions.offset;
		lengthValue = offsetOrOptions.length;
		positionValue = offsetOrOptions.position;
	}
	const offset =
		offsetValue === undefined || offsetValue === null ? 0 : integerArg(offsetValue, "offset", 0, bytes.byteLength);
	const count =
		lengthValue === undefined || lengthValue === null
			? bytes.byteLength - offset
			: integerArg(lengthValue, "length", 0, bytes.byteLength - offset);
	return { buffer: bytes, offset, length: count, position: positionArg(positionValue) };
}

export interface WriteData {
	bytes: Uint8Array;
	position: number | null;
}

/** Parse the buffer or string forms of `write()`. */
export function writeArgs(data: unknown, a?: unknown, b?: unknown, c?: unknown): WriteData {
	if (typeof data === "string") {
		const encoding = parseEncoding(typeof b === "string" ? b : undefined, "utf8");
		return { bytes: encodeString(data, encoding), position: positionArg(a) };
	}
	if (!isArrayBufferView(data)) {
		throw invalidArgType("buffer", "of type string or an instance of Buffer, TypedArray, or DataView", data);
	}
	const bytes = viewBytes(data);
	let offsetValue = a;
	let lengthValue = b;
	let positionValue = c;
	if (isObject(a)) {
		offsetValue = a.offset;
		lengthValue = a.length;
		positionValue = a.position;
	}
	const offset =
		offsetValue === undefined || offsetValue === null ? 0 : integerArg(offsetValue, "offset", 0, bytes.byteLength);
	const count =
		lengthValue === undefined || lengthValue === null
			? bytes.byteLength - offset
			: integerArg(lengthValue, "length", 0, bytes.byteLength - offset);
	return { bytes: bytes.subarray(offset, offset + count), position: positionArg(positionValue) };
}

export function buffersArg(buffers: unknown): Uint8Array[] {
	if (!Array.isArray(buffers) || !buffers.every((item) => isArrayBufferView(item))) {
		throw invalidArgType("buffers", "an instance of ArrayBufferView[]", buffers);
	}
	return buffers.map((item: ArrayBufferView) => viewBytes(item));
}
