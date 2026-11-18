/**
 * End-to-end smoke test: installs Obsidian into a fresh browser profile, creates a vault, edits a note and checks
 * that it survives a reload. Run `pnpm build` first.
 *
 *   OBSIDIAN_ASAR=/path/to/obsidian-1.x.y.asar.gz pnpm test:e2e
 *
 * Without OBSIDIAN_ASAR the latest release is downloaded from GitHub through the Wisp proxy. CHROMIUM_PATH selects
 * the browser, otherwise Playwright's Chromium is used.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type BrowserContext, chromium, type Page } from "playwright-core";

const root = join(import.meta.dirname, "../..");
let server: ChildProcess;
let baseUrl = "";
let context: BrowserContext;
let page: Page;
let profile = "";
const errors: string[] = [];

function startServer(): Promise<string> {
	server = spawn(process.execPath, [join(root, "src/server/main.ts"), "--port", "0"], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	return new Promise((resolve, reject) => {
		server.once("exit", (code) => reject(new Error(`Server exited with ${code}`)));
		server.stdout?.on("data", (chunk: Buffer) => {
			const match = /running at (\S+)/.exec(chunk.toString());
			if (match?.[1]) {
				resolve(match[1].replace(/\/$/, ""));
			}
		});
	});
}

async function waitForApp(target: Page): Promise<void> {
	await target.waitForFunction(
		() => (window as Window & { app?: { workspace?: { layoutReady?: boolean } } }).app?.workspace?.layoutReady,
		null,
		{ timeout: 60_000 },
	);
}

describe("obsidian-web", { timeout: 300_000 }, () => {
	before(async () => {
		baseUrl = await startServer();
		profile = await mkdtemp(join(tmpdir(), "obsidian-web-e2e-"));
		context = await chromium.launchPersistentContext(profile, {
			headless: true,
			...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
		});
		page = context.pages()[0] ?? (await context.newPage());
		page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
	});

	after(async () => {
		await context?.close();
		server?.kill();
		if (profile) {
			await rm(profile, { recursive: true, force: true });
		}
	});

	it("installs Obsidian", async () => {
		await page.goto(`${baseUrl}/`);
		await page.waitForSelector("input[type=checkbox]", { timeout: 30_000 });
		await page.check("input[type=checkbox]");
		if (process.env.OBSIDIAN_ASAR) {
			await page.setInputFiles("input[type=file]", process.env.OBSIDIAN_ASAR);
		} else {
			await page.waitForSelector("option:has-text('latest')", { state: "attached", timeout: 60_000 });
			await page.click("text=Download and install");
		}
		await page.waitForFunction(
			() => /is installed/.test(document.querySelector("#status")?.textContent ?? ""),
			null,
			{
				timeout: 120_000,
			},
		);
	});

	it("creates a vault from the starter", async () => {
		await page.click("text=Open Obsidian");
		await page.waitForSelector("text=Quick start", { timeout: 60_000 });
		await page.click("text=Quick start");
		await waitForApp(page);
		assert.equal(
			await page.evaluate(() =>
				(window as unknown as { app: { vault: { getName(): string } } }).app.vault.getName(),
			),
			"Obsidian Vault",
		);
	});

	it("persists edits across reloads", async () => {
		await page.evaluate(async () => {
			const { vault } = (
				window as unknown as { app: { vault: { create(path: string, data: string): Promise<unknown> } } }
			).app;
			await vault.create("E2E.md", "# Written by the e2e test");
		});
		await page.waitForTimeout(500);
		await page.reload();
		await waitForApp(page);
		const content = await page.evaluate(() =>
			(
				window as unknown as { app: { vault: { adapter: { read(path: string): Promise<string> } } } }
			).app.vault.adapter.read("E2E.md"),
		);
		assert.equal(content, "# Written by the e2e test");
	});

	it("reaches other sites through the proxy", async () => {
		const status = await page.evaluate(async () => {
			const response = await (
				window as unknown as { requestUrl(options: { url: string }): Promise<{ status: number }> }
			).requestUrl({ url: "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/README.md" });
			return response.status;
		});
		assert.equal(status, 200);
	});

	it("does not throw page errors", () => {
		assert.deepEqual(errors, []);
	});
});
