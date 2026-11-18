/** Tests both a plain Python static server and pnpm start's static + Wisp server. Run pnpm build first. */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";

const root = join(import.meta.dirname, "../..");

interface App {
	vault: {
		getName(): string;
		create(path: string, data: string): Promise<unknown>;
		adapter: { read(path: string): Promise<string> };
	};
	workspace: { layoutReady: boolean };
	setting: { open(): void };
}

declare global {
	interface Window {
		app: App;
	}
}

async function waitForApp(page: Page): Promise<void> {
	await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 30_000 });
}

for (const mode of ["static", "wisp"] as const) {
	describe(`${mode} server`, { timeout: 120_000 }, () => {
		let server: ChildProcess;
		let browser: Browser;
		let context: BrowserContext;
		let page: Page;
		let origin: string;
		const errors: string[] = [];
		const external: string[] = [];

		before(async () => {
			server =
				mode === "static"
					? spawn("python3", ["-u", "-m", "http.server", "0", "--bind", "127.0.0.1"], {
							cwd: join(root, "dist"),
							stdio: ["ignore", "pipe", "pipe"],
						})
					: spawn(process.execPath, [join(root, "src/server/main.ts"), "--port", "0"], {
							stdio: ["ignore", "pipe", "pipe"],
						});
			server.stderr?.resume();
			origin = await new Promise<string>((resolve, reject) => {
				server.once("error", reject);
				server.once("exit", (code) => reject(new Error(`Server exited: ${code}`)));
				server.stdout?.on("data", (chunk: Buffer) => {
					const output = chunk.toString();
					const match = mode === "static" ? /port (\d+)/.exec(output) : /localhost:(\d+)/.exec(output);
					if (match?.[1]) {
						resolve(`http://127.0.0.1:${match[1]}`);
					}
				});
			});
			browser = await chromium.launch({
				headless: true,
				...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
			});
			context = await browser.newContext();
			// The app, its logo and all startup resources must be bundled, with no runtime upstream downloads.
			await context.route("**/*", (route) => {
				const url = route.request().url();
				if (/^https?:/.test(url) && new URL(url).origin !== origin) {
					external.push(url);
					return route.abort();
				}
				return route.continue();
			});
			page = await context.newPage();
			page.on("pageerror", (error) => errors.push(error.message));
		});

		after(async () => {
			await browser?.close();
			if (server?.exitCode === null) {
				const exited = once(server, "exit");
				server.kill();
				await exited;
			}
		});

		it("opens the bundled app without a setup screen or external downloads", async () => {
			await page.goto(origin);
			await page.getByRole("button", { name: "Quick start", exact: true }).waitFor({ timeout: 30_000 });
			assert.equal(new URL(page.url()).pathname, "/starter.html");
			assert.equal(await page.locator(".boot, #content .card, input[type=checkbox]").count(), 0);
			assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), "/favicon.ico");
			const icon = await context.request.get(`${origin}/favicon.ico`);
			assert.deepEqual(await icon.body(), await readFile(join(root, "dist/favicon.ico")));
			assert.deepEqual(external, []);
		});

		it("creates a vault and persists edits across reloads", async () => {
			await page.getByRole("button", { name: "Quick start", exact: true }).click();
			await waitForApp(page);
			assert.equal(await page.evaluate(() => window.app.vault.getName()), "Obsidian Vault");
			await page.evaluate(async () => {
				await window.app.vault.create("E2E.md", "# Bundled and local");
			});
			await page.reload();
			await waitForApp(page);
			assert.equal(await page.evaluate(() => window.app.vault.adapter.read("E2E.md")), "# Bundled and local");
		});

		it("offers optional Wisp configuration in built-in settings", async () => {
			await page.evaluate(() => window.app.setting.open());
			await page.locator('[data-setting-id="obsidian-web"]').click();
			const input = page.getByRole("textbox", { name: "Wisp proxy URL" });
			assert.equal(await input.inputValue(), `${origin.replace("http:", "ws:")}/wisp/`);
			await input.fill("https://invalid.example/wisp/");
			await page.getByRole("button", { name: "Save and reload" }).click();
			assert.match((await page.getByRole("status").last().textContent()) ?? "", /ws:\/\/ or wss:\/\//);
			assert.equal(await page.evaluate(() => localStorage.getItem("obsidian-web:wisp-url")), null);
			await input.fill("");
			await Promise.all([
				page.waitForEvent("load"),
				page.getByRole("button", { name: "Save and reload" }).click(),
			]);
			await waitForApp(page);
			assert.equal(await page.evaluate(() => localStorage.getItem("obsidian-web:wisp-url")), "");
			await page.evaluate(() => window.app.setting.open());
			await page.locator('[data-setting-id="obsidian-web"]').click();
			assert.equal(await input.inputValue(), "");
			await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Use default" }).click()]);
			await waitForApp(page);
			assert.equal(await page.evaluate(() => localStorage.getItem("obsidian-web:wisp-url")), null);
		});

		if (mode === "wisp") {
			it("serves Wisp on /wisp/", async () => {
				const type = await page.evaluate(
					() =>
						new Promise<number>((resolve, reject) => {
							const socket = new WebSocket(`${location.origin.replace("http:", "ws:")}/wisp/`);
							socket.binaryType = "arraybuffer";
							const timeout = setTimeout(() => {
								socket.close();
								reject(new Error("Wisp handshake timed out"));
							}, 5000);
							socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
								clearTimeout(timeout);
								socket.close();
								resolve(new Uint8Array(event.data)[0] ?? -1);
							};
							socket.onerror = () => {
								clearTimeout(timeout);
								reject(new Error("Wisp handshake failed"));
							};
						}),
				);
				assert.equal(type, 3); // Wisp v1 initial CONTINUE packet.
			});
		}

		it("reopens the vault offline without errors", async () => {
			await context.setOffline(true);
			await page.goto(`${origin}/`);
			await waitForApp(page);
			assert.equal(await page.evaluate(() => window.app.vault.adapter.read("E2E.md")), "# Bundled and local");
			assert.deepEqual(errors, []);
			assert.deepEqual(external, []);
		});
	});
}
