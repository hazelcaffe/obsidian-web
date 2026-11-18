import assert from "node:assert/strict";
import * as node from "node:crypto";
import { describe, it } from "node:test";
import { nodeCrypto } from "../../src/runtime/node/crypto.ts";

const KEY = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
const IV = Buffer.from("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf", "hex");
const TEXT = "The quick brown fox jumps over the lazy dog. ".repeat(5);

describe("crypto module", () => {
	it("hashes like Node.js", () => {
		for (const algorithm of ["md5", "sha1", "sha256", "sha512", "sha3-256"]) {
			const ours = nodeCrypto
				.createHash(algorithm)
				.update(TEXT)
				.update(Buffer.from([1, 2, 3]))
				.digest("hex");
			const theirs = node
				.createHash(algorithm)
				.update(TEXT)
				.update(Buffer.from([1, 2, 3]))
				.digest("hex");
			assert.equal(ours, theirs, algorithm);
		}
		const hash = nodeCrypto.createHash("sha256").update("a");
		const copy = hash.copy().update("b");
		assert.equal(hash.digest("base64"), node.createHash("sha256").update("a").digest("base64"));
		assert.equal(copy.digest("hex"), node.createHash("sha256").update("ab").digest("hex"));
	});

	it("computes HMACs and derives keys like Node.js", () => {
		assert.equal(
			nodeCrypto.createHmac("sha256", "secret").update(TEXT).digest("hex"),
			node.createHmac("sha256", "secret").update(TEXT).digest("hex"),
		);
		assert.deepEqual(
			nodeCrypto.pbkdf2Sync("password", "salt", 1000, 32, "sha256"),
			node.pbkdf2Sync("password", "salt", 1000, 32, "sha256"),
		);
		assert.deepEqual(
			nodeCrypto.scryptSync("password", "salt", 32, { N: 1024, r: 8, p: 1 }),
			node.scryptSync("password", "salt", 32, { N: 1024, r: 8, p: 1 }),
		);
		assert.deepEqual(
			Buffer.from(nodeCrypto.hkdfSync("sha256", "key", "salt", "info", 42)),
			Buffer.from(node.hkdfSync("sha256", "key", "salt", "info", 42)),
		);
	});

	it("supports the async key derivation callbacks", async () => {
		const key = await new Promise<Buffer>((resolve, reject) =>
			nodeCrypto.scrypt("pw", "salt", 16, { N: 1024 }, (error, result) =>
				error || !result ? reject(error) : resolve(result),
			),
		);
		assert.deepEqual(key, node.scryptSync("pw", "salt", 16, { N: 1024 }));
	});

	it("encrypts and decrypts AES like Node.js", () => {
		for (const algorithm of ["aes-256-cbc", "aes-256-ctr", "aes-128-cbc"]) {
			const key = algorithm.includes("128") ? KEY.subarray(0, 16) : KEY;
			const cipher = nodeCrypto.createCipheriv(algorithm, key, IV);
			const encrypted = Buffer.concat([cipher.update(TEXT, "utf8") as Buffer, cipher.final() as Buffer]);
			const reference = node.createCipheriv(algorithm, key, IV);
			assert.deepEqual(encrypted, Buffer.concat([reference.update(TEXT, "utf8"), reference.final()]), algorithm);
			const decipher = nodeCrypto.createDecipheriv(algorithm, key, IV);
			assert.equal(
				Buffer.concat([decipher.update(encrypted) as Buffer, decipher.final() as Buffer]).toString(),
				TEXT,
			);
		}
	});

	it("authenticates AES-GCM like Node.js", () => {
		const nonce = IV.subarray(0, 12);
		const cipher = nodeCrypto.createCipheriv("aes-256-gcm", KEY, nonce).setAAD(Buffer.from("header"));
		const encrypted = Buffer.concat([cipher.update(TEXT) as Buffer, cipher.final() as Buffer]);
		const tag = cipher.getAuthTag();
		const reference = node.createCipheriv("aes-256-gcm", KEY, nonce);
		reference.setAAD(Buffer.from("header"));
		assert.deepEqual(encrypted, Buffer.concat([reference.update(TEXT), reference.final()]));
		assert.deepEqual(tag, reference.getAuthTag());
		const decipher = nodeCrypto
			.createDecipheriv("aes-256-gcm", KEY, nonce)
			.setAAD(Buffer.from("header"))
			.setAuthTag(Buffer.from(tag).fill(0));
		decipher.update(encrypted);
		assert.throws(() => decipher.final());
	});

	it("compares buffers in constant time", () => {
		assert.ok(nodeCrypto.timingSafeEqual(Buffer.from("abc"), Buffer.from("abc")));
		assert.ok(!nodeCrypto.timingSafeEqual(Buffer.from("abc"), Buffer.from("abd")));
		assert.throws(() => nodeCrypto.timingSafeEqual(Buffer.from("a"), Buffer.from("ab")));
		assert.equal(nodeCrypto.randomBytes(48).length, 48);
		assert.match(nodeCrypto.randomUUID(), /^[0-9a-f-]{36}$/);
	});
});
