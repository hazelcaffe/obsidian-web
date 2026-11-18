import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AsarArchive } from "../../src/shared/asar.ts";
import { extractTerms } from "../../src/shared/install.ts";

interface Tree {
	[name: string]: string | Tree;
}

/** Builds an archive the way @electron/asar does: pickled header, then file contents. */
function buildAsar(tree: Tree): Uint8Array<ArrayBuffer> {
	const contents: Uint8Array[] = [];
	let offset = 0;
	const toHeader = (node: Tree): object => {
		const files: Record<string, object> = {};
		for (const [name, value] of Object.entries(node)) {
			if (typeof value === "string") {
				const bytes = new TextEncoder().encode(value);
				files[name] = { size: bytes.length, offset: String(offset) };
				contents.push(bytes);
				offset += bytes.length;
			} else {
				files[name] = toHeader(value);
			}
		}
		return { files };
	};
	const json = new TextEncoder().encode(JSON.stringify(toHeader(tree)));
	const padded = Math.ceil(json.length / 4) * 4;
	const header = new Uint8Array(16 + padded);
	const view = new DataView(header.buffer);
	view.setUint32(0, 4, true);
	view.setUint32(4, 8 + padded, true);
	view.setUint32(8, 4 + padded, true);
	view.setUint32(12, json.length, true);
	header.set(json, 16);
	const out = new Uint8Array(header.length + offset);
	out.set(header);
	let position = header.length;
	for (const chunk of contents) {
		out.set(chunk, position);
		position += chunk.length;
	}
	return out;
}

describe("AsarArchive", () => {
	const bytes = buildAsar({
		"index.html": "<html></html>",
		lib: { "a.js": "console.log(1)", deep: { "b.css": "body{}" } },
		"package.json": '{"version":"1.2.3"}',
	});

	it("parses the header and locates files", async () => {
		const archive = await AsarArchive.fromBlob(new Blob([bytes]));
		const location = archive.locate("lib/deep/b.css");
		assert.ok(location);
		const text = new TextDecoder().decode(bytes.subarray(location.start, location.start + location.size));
		assert.equal(text, "body{}");
		assert.equal(archive.locate("/index.html")?.size, 13);
		assert.equal(archive.locate("lib"), null);
		assert.equal(archive.locate("missing.js"), null);
	});

	it("lists directories and walks files", () => {
		const archive = AsarArchive.parse(bytes);
		assert.ok(archive.isDirectory("lib"));
		assert.deepEqual(archive.list("lib").sort(), ["a.js", "deep"]);
		assert.deepEqual(archive.walk().sort(), ["index.html", "lib/a.js", "lib/deep/b.css", "package.json"]);
		assert.deepEqual(archive.walk("lib/deep"), ["lib/deep/b.css"]);
	});

	it("rejects other files", () => {
		assert.throws(() => AsarArchive.parse(new Uint8Array(32)), /Not an asar archive/);
	});
});

describe("extractTerms", () => {
	it("finds the license notice in main.js", () => {
		const main = 'var a=1;var rn="I understand and agree that I am not allowed to \\"distribute\\" it.";var b=2;';
		assert.equal(extractTerms(main), 'I understand and agree that I am not allowed to "distribute" it.');
		assert.equal(extractTerms("var x = 1;"), null);
	});
});
