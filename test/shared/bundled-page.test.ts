import assert from "node:assert/strict";
import { it } from "node:test";
import { preparePage, rebaseAssetLiterals } from "../../scripts/obsidian.ts";

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

it("rebases generated pages and only known app resource literals for Pages", () => {
	const { html, scripts } = preparePage(
		'<head></head><body><script src="lib/moment.js"></script></body>',
		"/app.js",
		"/obsidian-web/",
	);
	assert.match(html, /src="\/obsidian-web\/obsidian-web\/runtime.js"/);
	assert.match(html, /href="\/obsidian-web\/favicon.ico"/);
	assert.deepEqual(scripts, ["/obsidian-web/lib/moment.js", "/obsidian-web/app.js"]);
	const source =
		'fetch("/lib/readability.js"); new Worker("/sim.js"); const route="/index.html",file="/home/user/note.md";';
	const result = rebaseAssetLiterals(source, "/obsidian-web/", (path) =>
		["lib/readability.js", "sim.js", "index.html"].includes(path),
	);
	assert.match(result, /fetch\("\/obsidian-web\/lib\/readability.js"\)/);
	assert.match(result, /new Worker\("\/obsidian-web\/sim.js"\)/);
	assert.match(result, /route="\/obsidian-web\/index.html"/);
	assert.match(result, /file="\/home\/user\/note.md"/);
});
