import assert from "node:assert/strict";
import { it } from "node:test";
import { preparePage } from "../../scripts/obsidian.ts";

it("moves script execution behind the OPFS runtime and includes the official local favicon", () => {
	const source = `<html><head><link rel="preload" href="app.js" as="script"/></head><body>
<script>document.write("legacy startup");</script>
<script defer src="lib/moment.js"></script><script src="enhance.js"></script></body></html>`;
	const result = preparePage(source, "/app.js");
	assert.deepEqual(result.scripts, ["/lib/moment.js", "/enhance.js", "/app.js"]);
	assert.equal((result.html.match(/<script\b/g) ?? []).length, 1);
	assert.match(result.html, /defer src="\/obsidian-web\/runtime.js"/);
	assert.match(result.html, /href="\/favicon.ico"/);
	assert.doesNotMatch(result.html, /legacy startup|rel="preload"/);
});
