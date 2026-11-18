import { Buffer } from "buffer";
import { invalidArgType, invalidArgValue } from "./errors.ts";

export type Encoding =
	| "ascii"
	| "utf8"
	| "utf-8"
	| "utf16le"
	| "utf-16le"
	| "ucs2"
	| "ucs-2"
	| "base64"
	| "base64url"
	| "latin1"
	| "binary"
	| "hex";

export type EncodingOption = Encoding | "buffer";

const ENCODINGS: ReadonlyMap<string, EncodingOption> = new Map<string, EncodingOption>([
	["utf8", "utf8"],
	["utf-8", "utf8"],
	["ascii", "ascii"],
	["utf16le", "utf16le"],
	["utf-16le", "utf16le"],
	["ucs2", "utf16le"],
	["ucs-2", "utf16le"],
	["base64", "base64"],
	["base64url", "base64url"],
	["latin1", "latin1"],
	["binary", "latin1"],
	["hex", "hex"],
	["buffer", "buffer"],
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Normalize an encoding name; `null`/`undefined` map to `fallback`. */
export function parseEncoding(value: unknown, fallback?: EncodingOption): EncodingOption | undefined {
	if (value === undefined || value === null) {
		return fallback;
	}
	if (typeof value === "string") {
		const encoding = ENCODINGS.get(value.toLowerCase());
		if (encoding) {
			return encoding;
		}
	}
	throw invalidArgValue("encoding", value, "is invalid encoding");
}

export function encodeString(value: string, encoding: EncodingOption = "utf8"): Uint8Array<ArrayBuffer> {
	if (encoding === "utf8" || encoding === "buffer") {
		return textEncoder.encode(value);
	}
	return new Uint8Array(Buffer.from(value, encoding));
}

export function decodeBytes(bytes: Uint8Array<ArrayBuffer>, encoding: Encoding): string {
	if (encoding === "utf8" || encoding === "utf-8") {
		return textDecoder.decode(bytes);
	}
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(encoding);
}

/** Return a fresh `Buffer` copy of `bytes`, or a string if an encoding is given. */
export function bytesToResult(bytes: Uint8Array<ArrayBuffer>, encoding: EncodingOption | undefined): Buffer | string {
	if (encoding === undefined || encoding === "buffer") {
		return Buffer.from(bytes);
	}
	return decodeBytes(bytes, encoding);
}

export function stringToResult(value: string, encoding: EncodingOption | undefined): Buffer | string {
	if (encoding === "buffer") {
		return Buffer.from(value);
	}
	return value;
}

export function isArrayBufferView(value: unknown): value is ArrayBufferView {
	return ArrayBuffer.isView(value);
}

/** A plain Uint8Array view over the bytes of an ArrayBufferView (no copy; `Buffer#slice` would not copy). */
export function viewBytes(value: ArrayBufferView): Uint8Array {
	if (value instanceof Uint8Array && value.constructor === Uint8Array) {
		return value;
	}
	return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/** Convert write data (string or binary) to an owned byte array. */
export function dataToBytes(
	data: unknown,
	encoding: EncodingOption | undefined,
	name = "data",
): Uint8Array<ArrayBuffer> {
	if (typeof data === "string") {
		return encodeString(data, encoding ?? "utf8");
	}
	if (isArrayBufferView(data)) {
		return viewBytes(data).slice();
	}
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data.slice(0));
	}
	throw invalidArgType(name, "of type string or an instance of Buffer, TypedArray, or DataView", data);
}

export function concatBytes(chunks: readonly Uint8Array[], total?: number): Uint8Array<ArrayBuffer> {
	const size = total ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}
