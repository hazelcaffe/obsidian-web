# obsidian-web

The Obsidian desktop app in the browser, with local vaults stored in OPFS.

## Build and run

Requires Node.js 24+, pnpm, and a recent Chromium-based browser or Firefox.

```sh
pnpm i
pnpm build
pnpm start
```

Open **http://localhost:3000**. `pnpm start` serves `dist/` at `/` and a Wisp proxy at `/wisp/`.
Use `PORT=8080 pnpm start` or `pnpm start --port 8080` to change the port.

The build automatically downloads Obsidian and the official favicon, then includes them in `dist/`.
The page opens directly into your last vault or Obsidian's vault picker. There is no installer screen or runtime
download from GitHub.

### Plain static hosting

`dist/` is a complete static site. For example:

```sh
cd dist
python3 -m http.server 3000
```

Or deploy its contents at the root of any static web host. No API backend, certificate flags, special response headers,
or application server is needed. OPFS and service workers use browser secure contexts: localhost HTTP or HTTPS.

### Bundled version

The build pins Obsidian **1.15.1**, with downloads cached in `.cache/`. To build another release or use a local archive:

```sh
OBSIDIAN_VERSION=1.15.1 pnpm build
OBSIDIAN_ASAR=/path/to/obsidian.asar pnpm build
```

`.asar.gz` is also accepted. Rebuild and deploy `dist/` to update the app; the browser does not fetch a separate
Obsidian installation. Application files, fonts, libraries, sandbox notes and the favicon are all served locally.

## Networking

**Settings → Obsidian Web → Wisp proxy URL** configures optional networking for Sync and plugins needing
CORS-free requests. This is a built-in setting, available with community plugins disabled.

- On localhost, the default is the same origin's `/wisp/`, supplied by `pnpm start`.
- On other hosts, the default is **none**.
- An empty saved URL disables Wisp, including on localhost. **Use default** restores the origin's default.
- A custom `ws://` or `wss://` URL is saved for this browser and origin.

With a proxy configured, libcurl.js tunnels HTTP, WebSocket and plugin networking through Wisp; TLS runs in the
browser. Without one, HTTP and WebSocket requests use normal browser networking and its CORS rules. Raw TCP/TLS
plugin APIs require Wisp. Local editing, vault storage and installed offline plugins work without it.

## Vaults and plugins

- **Create/open:** use Obsidian's vault picker. Vaults are directories in browser-private OPFS storage.
- **Import:** the vault picker's **Import vault** copies a folder or ZIP from your computer. Files can also be dropped
  into an open vault.
- **Export:** **Show in system explorer** downloads the selected file or a ZIP of the selected folder.
- **Plugins/themes:** install them from Obsidian's settings. They use the original Obsidian API and the browser's
  Node/Electron compatibility layer. Dataview, Calendar, Excalidraw and Templater were exercised during development.
- **Offline:** after the initial load, the service worker caches the bundled app. Vault data remains in OPFS across
  reloads, and multiple tabs receive filesystem changes through BroadcastChannel.

Clearing site data removes local vaults. Export backups or use your preferred sync solution for important data.

## Compatibility

This runs Obsidian's original renderer, including live preview, graph, canvas, bases, PDFs, search and settings.
Official Sync uses the original client and your Obsidian account; authenticated end-to-end sync has not been tested.

Browser limitations remain:

- Plugins requiring native binaries or `child_process` cannot run.
- Browsers reserve shortcuts such as Ctrl+W, Ctrl+T and Ctrl+N.
- The web viewer uses iframes; sites that forbid framing cannot load in it.
- PDF export uses the browser print dialog. Canvas viewport screenshots are not implemented.
- Settings default to an in-page dialog; Obsidian's separate-window option still works.
- Paths use POSIX semantics, including on Windows. Large uncached synchronous file reads can return `EAGAIN`;
  async reads load the data on demand.
- `safeStorage` uses a key held in the same browser origin, rather than an OS keychain.

## Development

```sh
pnpm watch        # rebuild runtime changes
pnpm typecheck    # strict browser, worker and Node TypeScript checks
pnpm lint         # Biome; pnpm fix applies fixes
pnpm test         # node:test unit tests
pnpm test:e2e     # after pnpm build; tests Python static hosting and the optional Wisp server
```

The end-to-end tests need Python 3 and Playwright Chromium. `CHROMIUM_PATH` selects an installed Chromium executable.
They verify automatic startup with external downloads blocked, persistence, the built-in Wisp setting, a Wisp
handshake, and reopening the vault offline.

```
scripts/      downloads and extracts the Obsidian bundle at build time
src/runtime/  Electron/Node emulation, OPFS startup and built-in web settings
src/vfs/      OPFS-backed Node fs API with watchers and cross-tab updates
src/sw/       local vault resource serving and offline static asset caching
src/shared/   archive parser, bundle metadata and network configuration
src/server/   optional dist/ server with /wisp/
dist/         generated standalone static site (including Obsidian)
```

Generated HTML waits for the filesystem and runtime before loading Obsidian's scripts in their original order.
The app's JavaScript is extracted unchanged. Vault resource URLs are served from OPFS by the service worker.
Existing vault storage from earlier obsidian-web builds is preserved.

## License

The compatibility layer is [MIT licensed](LICENSE). Bundled Obsidian application files and the official logo retain
their upstream licensing. This project is not affiliated with Dynalist Inc.

[libcurl.js](https://github.com/ading2210/libcurl.js) and
[wisp-js](https://github.com/MercuryWorkshop/wisp-js) are LGPL-3.0. libcurl.js is shipped separately under
`dist/obsidian-web/vendor/`; the build disables its Node environment detection so it works with the emulated
`process` global. Its license is included alongside it.
