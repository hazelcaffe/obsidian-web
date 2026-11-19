/** Tests both a plain Python static server and pnpm start's static + Wisp server. Run pnpm build first. */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";

const root = join(import.meta.dirname, "../..");
const { basePath: base = "/" } = JSON.parse(await readFile(join(root, "dist/obsidian-web/app.json"), "utf8")) as {
	basePath: string;
};

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
		let staticRoot: string | undefined;
		let fixture: Server;
		let fixtureOrigin = "";
		const errors: string[] = [];
		const external: string[] = [];
		const consoleErrors: string[] = [];

		before(async () => {
			let directory = join(root, "dist");
			if (base !== "/" && mode === "static") {
				staticRoot = await mkdtemp(join(tmpdir(), "obsidian-web-pages-"));
				const link = join(staticRoot, base.slice(1, -1));
				await mkdir(dirname(link), { recursive: true });
				await symlink(directory, link, "dir");
				directory = staticRoot;
			}
			server =
				mode === "static"
					? spawn("python3", ["-u", "-m", "http.server", "0", "--bind", "127.0.0.1"], {
							cwd: directory,
							stdio: ["ignore", "pipe", "pipe"],
						})
					: spawn(process.execPath, [join(root, "src/server/main.ts"), "--port", "0"], {
							stdio: ["ignore", "pipe", "pipe"],
							env: { ...process.env, WISP_ALLOW_PRIVATE: "1" },
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
			page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
			page.on("console", (message) => {
				if (message.type() === "error") {
					consoleErrors.push(message.text());
				}
			});
			fixture = createServer((request, response) => {
				response.setHeader("X-Frame-Options", "DENY");
				response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
				if (request.url === "/data") {
					response.setHeader("Content-Type", "application/json");
					response.end('{"title":"Proxied page"}');
				} else if (request.url === "/pixel.svg") {
					response.setHeader("Content-Type", "image/svg+xml");
					response.end(
						'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
					);
				} else {
					response.setHeader("Content-Type", "text/html");
					response.end(
						request.url === "/next"
							? '<title>Next page</title><h1 id="next-page">Navigation works</h1>'
							: '<title>Loading</title><h1 id="proxied">Frame-blocked page</h1><img src="/pixel.svg"><a id="next" href="/next">Next</a><script>fetch("/data").then(r=>r.json()).then(d=>document.title=d.title);</script>',
					);
				}
			});
			fixture.listen(0, "127.0.0.1");
			await once(fixture, "listening");
			const address = fixture.address();
			fixtureOrigin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
		});

		after(async () => {
			await browser?.close();
			if (fixture) {
				fixture.closeAllConnections();
				await new Promise<void>((resolve) => fixture.close(() => resolve()));
			}
			if (server?.exitCode === null) {
				const exited = once(server, "exit");
				server.kill();
				await exited;
			}
			if (staticRoot) {
				await rm(staticRoot, { recursive: true, force: true });
			}
		});

		it("opens the bundled app without a setup screen or external downloads", async () => {
			await page.goto(`${origin}${base}`);
			await page.getByRole("button", { name: "Quick start", exact: true }).waitFor({ timeout: 30_000 });
			assert.equal(new URL(page.url()).pathname, `${base}starter.html`);
			assert.equal(await page.locator(".boot, #content .card, input[type=checkbox]").count(), 0);
			assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), `${base}favicon.ico`);
			const icon = await context.request.get(`${origin}${base}favicon.ico`);
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
			it("loads frame-blocked sites, scripts, assets and navigation through Scramjet", async () => {
				await page.evaluate((url) => {
					const view = document.createElement("webview") as HTMLElement & {
						loadURL(url: string): Promise<void>;
					};
					view.id = "proxy-test";
					view.addEventListener("did-fail-load", (event) => {
						view.dataset.error = (event as Event & { errorDescription: string }).errorDescription;
					});
					view.style.cssText = "position:fixed;inset:0;z-index:99999;background:white;";
					document.body.appendChild(view);
					void view.loadURL(url);
				}, `${fixtureOrigin}/denied`);
				await page
					.waitForFunction(
						() => {
							const doc =
								document.querySelector<HTMLIFrameElement>("#proxy-test iframe")?.contentDocument;
							return doc?.title === "Proxied page" && doc.querySelector("img")?.naturalWidth === 20;
						},
						null,
						{ timeout: 30_000 },
					)
					.catch(async (error: unknown) => {
						const state = await page.evaluate(() => {
							const view = document.querySelector<HTMLElement>("#proxy-test");
							const frame = view?.querySelector("iframe");
							return {
								error: view?.dataset.error,
								src: frame?.src,
								body: frame?.contentDocument?.body?.textContent?.slice(0, 1000),
								title: frame?.contentDocument?.title,
							};
						});
						throw new Error(JSON.stringify({ state, consoleErrors, external }), { cause: error });
					});
				const view = page.locator("#proxy-test");
				assert.equal(
					await view.evaluate((element) => (element as unknown as { getURL(): string }).getURL()),
					`${fixtureOrigin}/denied`,
				);
				assert.equal(
					await view.evaluate((element) =>
						(element as unknown as { executeJavaScript(code: string): Promise<string> }).executeJavaScript(
							"location.href",
						),
					),
					`${fixtureOrigin}/denied`,
				);
				await page.frameLocator("#proxy-test iframe").locator("#next").click();
				await page.frameLocator("#proxy-test iframe").locator("#next-page").waitFor();
				assert.equal(
					await view.evaluate((element) => (element as unknown as { getURL(): string }).getURL()),
					`${fixtureOrigin}/next`,
				);
				await view.evaluate((element) => element.remove());
			});

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
			await page.goto(`${origin}${base}`);
			await waitForApp(page);
			assert.equal(await page.evaluate(() => window.app.vault.adapter.read("E2E.md")), "# Bundled and local");
			assert.deepEqual(errors, []);
			assert.deepEqual(external, []);
		});
	});
}
