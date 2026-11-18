import { cbc, ctr, ecb, gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { md5, ripemd160, sha1 } from "@noble/hashes/legacy.js";
import { pbkdf2, pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { scrypt, scryptAsync } from "@noble/hashes/scrypt.js";
import { sha224, sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { sha3_256, sha3_512 } from "@noble/hashes/sha3.js";
import { Buffer } from "buffer";

type BufferEncoding = Parameters<typeof Buffer.from>[1] & string;
type Input = string | ArrayBufferView | ArrayBuffer;
type Callback<T> = (error: Error | null, result?: T) => void;

interface HashState {
	update(data: Uint8Array): HashState;
	digest(): Uint8Array;
	clone(): HashState;
}

interface HashFunction {
	(data: Uint8Array): Uint8Array;
	create(): HashState;
	outputLen: number;
	blockLen: number;
}

const HASHES: Record<string, HashFunction> = {
	md5: md5 as unknown as HashFunction,
	sha1: sha1 as unknown as HashFunction,
	"sha-1": sha1 as unknown as HashFunction,
	ripemd160: ripemd160 as unknown as HashFunction,
	sha224: sha224 as unknown as HashFunction,
	sha256: sha256 as unknown as HashFunction,
	"sha-256": sha256 as unknown as HashFunction,
	sha384: sha384 as unknown as HashFunction,
	"sha-384": sha384 as unknown as HashFunction,
	sha512: sha512 as unknown as HashFunction,
	"sha-512": sha512 as unknown as HashFunction,
	"sha3-256": sha3_256 as unknown as HashFunction,
	"sha3-512": sha3_512 as unknown as HashFunction,
};

function getHash(algorithm: string): HashFunction {
	const hash = HASHES[algorithm.toLowerCase()];
	if (!hash) {
		throw Object.assign(new Error(`Digest method not supported: ${algorithm}`), {
			code: "ERR_CRYPTO_INVALID_DIGEST",
		});
	}
	return hash;
}

function toBytes(data: Input, encoding?: string): Uint8Array {
	if (typeof data === "string") {
		return Buffer.from(data, (encoding as BufferEncoding) || "utf8");
	}
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function output(bytes: Uint8Array, encoding?: string): Buffer | string {
	const buffer = Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
	return encoding && encoding !== "buffer" ? buffer.toString(encoding as BufferEncoding) : buffer;
}

class Hash {
	private state: HashState;
	private finished = false;

	constructor(algorithm: string | HashState) {
		this.state = typeof algorithm === "string" ? getHash(algorithm).create() : algorithm;
	}

	update(data: Input, encoding?: string): this {
		if (this.finished) {
			throw Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" });
		}
		this.state.update(toBytes(data, encoding));
		return this;
	}

	digest(encoding?: string): Buffer | string {
		this.finished = true;
		return output(this.state.digest(), encoding);
	}

	copy(): Hash {
		return new Hash(this.state.clone());
	}
}

class Hmac {
	private state: HashState;

	constructor(algorithm: string, key: Input) {
		this.state = (hmac as unknown as { create(hash: HashFunction, key: Uint8Array): HashState }).create(
			getHash(algorithm),
			toBytes(key),
		);
	}

	update(data: Input, encoding?: string): this {
		this.state.update(toBytes(data, encoding));
		return this;
	}

	digest(encoding?: string): Buffer | string {
		return output(this.state.digest(), encoding);
	}
}

function randomBytes(size: number): Buffer;
function randomBytes(size: number, callback: Callback<Buffer>): void;
function randomBytes(size: number, callback?: Callback<Buffer>): Buffer | undefined {
	const bytes = Buffer.alloc(size);
	for (let offset = 0; offset < size; offset += 65536) {
		crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65536)) as Uint8Array<ArrayBuffer>);
	}
	if (callback) {
		queueMicrotask(() => callback(null, bytes));
		return undefined;
	}
	return bytes;
}

function randomFillSync<T extends ArrayBufferView>(buffer: T, offset = 0, size?: number): T {
	const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, size ?? buffer.byteLength - offset);
	for (let start = 0; start < view.length; start += 65536) {
		crypto.getRandomValues(view.subarray(start, Math.min(view.length, start + 65536)) as Uint8Array<ArrayBuffer>);
	}
	return buffer;
}

function randomInt(min: number, max?: number, callback?: Callback<number>): number | undefined {
	let low = min;
	let high = max;
	if (high === undefined) {
		high = low;
		low = 0;
	}
	const range = high - low;
	const random = new Uint32Array(1);
	crypto.getRandomValues(random);
	const value = low + Math.floor(((random[0] ?? 0) / 2 ** 32) * range);
	if (callback) {
		queueMicrotask(() => callback(null, value));
		return undefined;
	}
	return value;
}

interface ScryptOptions {
	N?: number;
	r?: number;
	p?: number;
	cost?: number;
	blockSize?: number;
	parallelization?: number;
	maxmem?: number;
}

function scryptParams(options: ScryptOptions = {}): { N: number; r: number; p: number; maxmem: number } {
	return {
		N: options.N ?? options.cost ?? 16384,
		r: options.r ?? options.blockSize ?? 8,
		p: options.p ?? options.parallelization ?? 1,
		maxmem: options.maxmem ?? 2 ** 31,
	};
}

function scryptCallback(
	password: Input,
	salt: Input,
	keylen: number,
	optionsOrCallback: ScryptOptions | Callback<Buffer>,
	maybeCallback?: Callback<Buffer>,
): void {
	const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
	const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
	scryptAsync(toBytes(password), toBytes(salt), { ...scryptParams(options), dkLen: keylen }).then(
		(key) => callback?.(null, Buffer.from(key)),
		(error: unknown) => callback?.(error instanceof Error ? error : new Error(String(error))),
	);
}

function pbkdf2Callback(
	password: Input,
	salt: Input,
	iterations: number,
	keylen: number,
	digest: string,
	callback: Callback<Buffer>,
): void {
	pbkdf2Async(getHash(digest) as never, toBytes(password), toBytes(salt), { c: iterations, dkLen: keylen }).then(
		(key) => callback(null, Buffer.from(key)),
		(error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
	);
}

function hkdfSync(digest: string, ikm: Input, salt: Input, info: Input, keylen: number): ArrayBuffer {
	const key = hkdf(getHash(digest) as never, toBytes(ikm), toBytes(salt), toBytes(info), keylen);
	return key.slice().buffer;
}

interface CipherMode {
	keyLength: number;
	ivLength: number;
	mode: "cbc" | "ctr" | "gcm" | "ecb";
}

function cipherMode(algorithm: string): CipherMode {
	const match = /^(?:id-)?aes-?(128|192|256)-?(cbc|ctr|gcm|ecb)$/i.exec(algorithm);
	if (!match) {
		throw Object.assign(new Error(`Unsupported cipher: ${algorithm}`), { code: "ERR_CRYPTO_UNKNOWN_CIPHER" });
	}
	const mode = (match[2] ?? "cbc").toLowerCase() as CipherMode["mode"];
	return { keyLength: Number(match[1]) / 8, ivLength: mode === "gcm" ? 12 : 16, mode };
}

class Cipher {
	private chunks: Uint8Array[] = [];
	private aad: Uint8Array | undefined;
	private authTag: Uint8Array | undefined;
	private autoPadding = true;
	private readonly mode: CipherMode;
	private readonly key: Uint8Array;
	private readonly iv: Uint8Array;
	private readonly decrypt: boolean;

	constructor(algorithm: string, key: Input, iv: Input | null, decrypt: boolean) {
		this.mode = cipherMode(algorithm);
		this.key = toBytes(key);
		this.iv = iv ? toBytes(iv) : new Uint8Array(0);
		this.decrypt = decrypt;
		if (this.key.length !== this.mode.keyLength) {
			throw Object.assign(new RangeError("Invalid key length"), { code: "ERR_CRYPTO_INVALID_KEYLEN" });
		}
	}

	update(data: Input, inputEncoding?: string, outputEncoding?: string): Buffer | string {
		this.chunks.push(toBytes(data, inputEncoding));
		return output(new Uint8Array(0), outputEncoding);
	}

	final(outputEncoding?: string): Buffer | string {
		const input = Buffer.concat(this.chunks);
		this.chunks = [];
		const { mode } = this.mode;
		let result: Uint8Array;
		if (mode === "gcm") {
			const cipher = gcm(this.key, this.iv, this.aad);
			if (this.decrypt) {
				if (!this.authTag) {
					throw new Error("Unsupported state or unable to authenticate data");
				}
				result = cipher.decrypt(Buffer.concat([input, this.authTag]));
			} else {
				const sealed = cipher.encrypt(input);
				result = sealed.subarray(0, sealed.length - 16);
				this.authTag = sealed.subarray(sealed.length - 16);
			}
		} else if (mode === "ctr") {
			const cipher = ctr(this.key, this.iv);
			result = this.decrypt ? cipher.decrypt(input) : cipher.encrypt(input);
		} else if (mode === "ecb") {
			const cipher = ecb(this.key, { disablePadding: !this.autoPadding });
			result = this.decrypt ? cipher.decrypt(input) : cipher.encrypt(input);
		} else {
			const cipher = cbc(this.key, this.iv, { disablePadding: !this.autoPadding });
			result = this.decrypt ? cipher.decrypt(input) : cipher.encrypt(input);
		}
		return output(result, outputEncoding);
	}

	setAAD(aad: Input): this {
		this.aad = toBytes(aad);
		return this;
	}

	setAuthTag(tag: Input): this {
		this.authTag = toBytes(tag);
		return this;
	}

	getAuthTag(): Buffer {
		if (!this.authTag) {
			throw new Error("Attempting to get auth tag in unsupported state");
		}
		return Buffer.from(this.authTag);
	}

	setAutoPadding(value = true): this {
		this.autoPadding = value;
		return this;
	}
}

function unsupported(name: string): () => never {
	return () => {
		throw Object.assign(new Error(`crypto.${name} is not supported in the browser`), {
			code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
		});
	};
}

export const nodeCrypto = {
	webcrypto: globalThis.crypto,
	subtle: globalThis.crypto.subtle,
	getRandomValues: <T extends ArrayBufferView>(array: T): T => globalThis.crypto.getRandomValues(array as never) as T,
	randomUUID: (): string => globalThis.crypto.randomUUID(),
	randomBytes,
	pseudoRandomBytes: randomBytes,
	randomFillSync,
	randomFill<T extends ArrayBufferView>(buffer: T, ...args: unknown[]): void {
		const callback = args.at(-1) as Callback<T>;
		const offset = typeof args[0] === "number" ? args[0] : 0;
		const size = typeof args[1] === "number" ? args[1] : undefined;
		const result = randomFillSync(buffer, offset, size);
		queueMicrotask(() => callback(null, result));
	},
	randomInt,
	createHash: (algorithm: string): Hash => new Hash(algorithm),
	createHmac: (algorithm: string, key: Input): Hmac => new Hmac(algorithm, key),
	hash: (algorithm: string, data: Input, encoding = "hex"): Buffer | string =>
		new Hash(algorithm).update(data).digest(encoding),
	getHashes: (): string[] => Object.keys(HASHES),
	getCiphers: (): string[] => [
		"aes-128-cbc",
		"aes-192-cbc",
		"aes-256-cbc",
		"aes-128-ctr",
		"aes-256-ctr",
		"aes-128-gcm",
		"aes-256-gcm",
		"aes-128-ecb",
		"aes-256-ecb",
	],
	createCipheriv: (algorithm: string, key: Input, iv: Input | null): Cipher => new Cipher(algorithm, key, iv, false),
	createDecipheriv: (algorithm: string, key: Input, iv: Input | null): Cipher => new Cipher(algorithm, key, iv, true),
	pbkdf2Sync: (password: Input, salt: Input, iterations: number, keylen: number, digest: string): Buffer =>
		Buffer.from(
			pbkdf2(getHash(digest) as never, toBytes(password), toBytes(salt), { c: iterations, dkLen: keylen }),
		),
	pbkdf2: pbkdf2Callback,
	scryptSync: (password: Input, salt: Input, keylen: number, options?: ScryptOptions): Buffer =>
		Buffer.from(scrypt(toBytes(password), toBytes(salt), { ...scryptParams(options), dkLen: keylen })),
	scrypt: scryptCallback,
	hkdfSync,
	hkdf(digest: string, ikm: Input, salt: Input, info: Input, keylen: number, callback: Callback<ArrayBuffer>): void {
		try {
			const key = hkdfSync(digest, ikm, salt, info, keylen);
			queueMicrotask(() => callback(null, key));
		} catch (error) {
			queueMicrotask(() => callback(error as Error));
		}
	},
	timingSafeEqual: (a: ArrayBufferView, b: ArrayBufferView): boolean => {
		const x = toBytes(a);
		const y = toBytes(b);
		if (x.length !== y.length) {
			throw Object.assign(new RangeError("Input buffers must have the same byte length"), {
				code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH",
			});
		}
		let diff = 0;
		for (let i = 0; i < x.length; i++) {
			diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
		}
		return diff === 0;
	},
	createSign: unsupported("createSign"),
	createVerify: unsupported("createVerify"),
	generateKeyPair: unsupported("generateKeyPair"),
	generateKeyPairSync: unsupported("generateKeyPairSync"),
	publicEncrypt: unsupported("publicEncrypt"),
	privateDecrypt: unsupported("privateDecrypt"),
	createECDH: unsupported("createECDH"),
	createDiffieHellman: unsupported("createDiffieHellman"),
	constants: {},
	Hash,
	Hmac,
};
