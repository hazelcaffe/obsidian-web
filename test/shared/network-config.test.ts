import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultWispUrl, normalizeWispUrl } from "../../src/shared/network-config.ts";

describe("optional Wisp configuration", () => {
	it("uses /wisp/ only on loopback origins by default", () => {
		assert.equal(defaultWispUrl("http://localhost:3000"), "ws://localhost:3000/wisp/");
		assert.equal(defaultWispUrl("https://127.0.0.1:1234"), "wss://127.0.0.1:1234/wisp/");
		assert.equal(defaultWispUrl("http://[::1]:3000"), "ws://[::1]:3000/wisp/");
		for (const origin of ["https://notes.example", "http://192.168.1.8:3000", "https://localhost.example"]) {
			assert.equal(defaultWispUrl(origin), "");
		}
	});
	it("accepts none and validates explicit WebSocket endpoints", () => {
		assert.equal(normalizeWispUrl("  "), "");
		assert.equal(normalizeWispUrl("wss://proxy.example/wisp"), "wss://proxy.example/wisp/");
		for (const value of ["https://proxy.example/", "garbage", "ws://user:pass@host/", "wss://host/#fragment"]) {
			assert.throws(() => normalizeWispUrl(value));
		}
	});
});
