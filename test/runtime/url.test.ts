import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as nodeUrl from "node:url";
import { url } from "../../src/runtime/node/url.ts";

describe("url module", () => {
	it("converts paths to file URLs like Node.js", () => {
		for (const path of ["/home/user/My Vault/note.md", "/a/b#c?d/%e", "/tmp/üñí/ç.md", "/dir/"]) {
			assert.equal(url.pathToFileURL(path).href, nodeUrl.pathToFileURL(path).href, path);
		}
	});

	it("converts file URLs to paths like Node.js", () => {
		for (const href of ["file:///home/user/My%20Vault/note.md", "file:///a/%23b%3Fc", "file:///tmp/%C3%BC"]) {
			assert.equal(url.fileURLToPath(href), nodeUrl.fileURLToPath(href), href);
		}
		assert.throws(() => url.fileURLToPath("https://example.com/"), { code: "ERR_INVALID_URL_SCHEME" });
		assert.throws(() => url.fileURLToPath("file:///a%2Fb"), { code: "ERR_INVALID_FILE_URL_PATH" });
	});

	it("parses and formats legacy URL objects", () => {
		for (const input of [
			"https://user:pass@example.com:8080/a/b?x=1&y=2#hash",
			"http://example.com",
			"/relative/path?q=1",
			"mailto:someone@example.com",
		]) {
			const ours = url.parse(input);
			const theirs = nodeUrl.parse(input);
			for (const key of [
				"protocol",
				"auth",
				"host",
				"port",
				"hostname",
				"hash",
				"search",
				"pathname",
				"path",
			] as const) {
				assert.equal(ours[key], theirs[key], `${key} of ${input}`);
			}
			assert.equal(url.format(ours), nodeUrl.format(theirs), input);
		}
		assert.deepEqual(url.parse("http://a.com/?x=1&x=2&y=3", true).query, { x: ["1", "2"], y: "3" });
	});

	it("resolves relative references", () => {
		const cases: Array<[string, string]> = [
			["http://example.com/a/b", "../c"],
			["http://example.com/a/b", "/root"],
			["/one/two", "three"],
			["http://example.com/", "https://other.org/x"],
		];
		for (const [from, to] of cases) {
			assert.equal(url.resolve(from, to), nodeUrl.resolve(from, to), `${from} + ${to}`);
		}
	});
});
