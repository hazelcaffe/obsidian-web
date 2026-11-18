# obsidian-web

Run the official [Obsidian](https://obsidian.md) desktop app in a web browser, entirely on your own machine.

obsidian-web is an Electron and Node.js compatibility layer for the browser. It loads the unmodified Obsidian desktop
bundle (`obsidian.asar`) and gives it everything it expects from Electron:

- **Storage**: a Node.js `fs` module backed by the
  [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system).
  Vaults live in the browser; nothing is stored on a server.
- **Networking**: `requestUrl`, cross-origin `fetch` and `WebSocket`, and Node's `http`/`https`/`net`/`tls`/`dns` go
  through [libcurl.js](https://github.com/ading2210/libcurl.js) over a
  [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) proxy. TLS is end-to-end between the browser and the
  destination, and there is no CORS, just like in Electron.
- **Electron**: `ipcRenderer` and the main process IPC handlers, `remote` (windows, dialogs, menus, clipboard, shell,
  sessions, `safeStorage`...), `webFrame`, `<webview>` and popout windows are reimplemented in the page.

No Obsidian code is included in this repository. On first launch you download the official release from
[obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) (or pick a local `.asar`/`.asar.gz`),
and it is stored in the browser's private storage.

## What works

- Creating, opening, importing and exporting vaults; the vault picker, help and the sandbox vault
- Editing, live preview, graph view, canvas, bases, PDF and media files, search, backlinks, all core plugins
- Community plugins and themes: browsing, installing, updating (plugins using Node.js modules work as long as they
  do not need native code or child processes)
- Obsidian Sync and Publish, using your Obsidian account
- Popout windows, multiple tabs on the same vault (changes are kept in sync between tabs)
- Automatic updates of the Obsidian app from GitHub

## Quick start

Requirements: Node.js 24 or newer, pnpm, and a recent Chromium-based browser (Chrome, Edge, Brave...) or Firefox.
Safari may work but is not tested.

```sh
pnpm install
pnpm build
pnpm start
```

Open <http://localhost:8080>, accept the notice, and pick an Obsidian version to install. The app then opens the vault
picker.

Browsers only allow service workers and OPFS in secure contexts, so use `localhost` or HTTPS. To use obsidian-web from
other devices, give the server a certificate:

```sh
pnpm start --host 0.0.0.0 --cert cert.pem --key key.pem
```

### Server options

| Option                          | Default                  | Description                                                                      |
| ------------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `--host <host>`                 | `127.0.0.1` (env `HOST`) | Interface to listen on                                                           |
| `-p, --port <port>`             | `8080` (env `PORT`)      | Port to listen on                                                                |
| `--cert <file>`, `--key <file>` |                          | Serve over HTTPS                                                                 |
| `--allow-private`               | only on localhost        | Let the proxy reach private and loopback addresses (local services, LAN servers) |
| `--no-wisp`                     |                          | Do not run the Wisp proxy (use an external one)                                  |
| `--trust-proxy`                 |                          | Trust `X-Forwarded-*` headers from a reverse proxy                               |
| `-v, --verbose`                 |                          | Log proxy connections                                                            |

### Static hosting

`dist/public` is a static site and can be served by any web server, as long as `sw.js` is served from the root of
the origin. Without the bundled server you need a Wisp server for network access: set its URL on the setup page
(`/?setup`). The proxy must only accept connections from your origin, otherwise any website could use it.

## Using it

- **Your data** lives in the origin private file system of the browser profile. Ask the browser to keep it
  persistently from the setup page (`/?setup`), and keep backups: clearing site data deletes your vaults.
- **Importing**: on the vault picker, _Import vault_ copies a folder or ZIP archive from your computer. Files can also
  be dropped into a vault.
- **Exporting**: _Reveal in system explorer_ (file explorer context menu, vault picker menu) downloads the file, or
  the folder as a ZIP archive. Files saved by the app (PDF and image exports) are downloaded too.
- **Settings** open inside the page. To get Obsidian's separate settings window, turn on _Open settings in a separate
  window_ in the app settings.

## Limitations

- There are no processes or native modules: `child_process` reports missing executables, and plugins that need them
  (for example Git through the command line) do not work.
- Browsers reserve some shortcuts such as <kbd>Ctrl</kbd>+<kbd>W</kbd>, <kbd>Ctrl</kbd>+<kbd>T</kbd> and
  <kbd>Ctrl</kbd>+<kbd>N</kbd>; they act on the browser tab instead of Obsidian.
- The web viewer uses iframes, so sites that forbid being framed do not load in it.
- _Export to PDF_ opens the browser's print dialog, and screenshots of the canvas viewport are not available.
- System fonts are listed only if the browser grants access to local fonts.
- Windows paths are not emulated: on Windows the app runs as if on Linux.
- `safeStorage` (used for secrets) encrypts with a key kept in the same browser storage, which hides secrets from
  casual inspection of the vault but not from code running in the page.

## How it works

```
browser tab                                              Node.js server (optional)
┌────────────────────────────────────────────────┐       ┌─────────────────────────┐
│ Obsidian app.js (unmodified)                   │       │ static files (dist)     │
│   window.require ─► Node.js modules (src/runtime/node)  │ Wisp proxy (/wisp/)     │
│                 ─► electron (src/runtime/electron)      └───────────▲─────────────┘
│   fs ─► in-memory tree ─► OPFS  (src/vfs)      │                   │ WebSocket
│   fetch/WebSocket/http ─► libcurl.js ──────────┼───────────────────┘
└───────────────────▲────────────────────────────┘
                    │ app files from the asar in OPFS, vault files at /_vfs/
            service worker (src/sw)
```

1. The boot page (`src/boot`) registers the service worker and installs `obsidian.asar` into OPFS.
2. The service worker (`src/sw`) serves the app from the archive at the root of the origin, injects the runtime into
   `index.html`, `starter.html` and `help.html`, and holds back the app scripts until the runtime is ready. It also
   serves vault files (Electron's `app://` file URLs) from OPFS.
3. The runtime (`src/runtime`) mounts the file system, sets up `process`, `Buffer` and `window.require`, the Electron
   modules and the main process IPC handlers, before Obsidian's code runs.

## Development

```sh
pnpm build        # bundle into dist/public (pnpm watch to rebuild on changes)
pnpm start        # serve dist/public with the Wisp proxy
pnpm typecheck    # browser, service worker and Node.js configs
pnpm lint         # Biome (pnpm fix to apply fixes)
pnpm test         # unit tests (node:test)
pnpm test:e2e     # end-to-end test with Playwright, after pnpm build
```

The end-to-end test installs Obsidian into a fresh browser profile. Set `OBSIDIAN_ASAR` to a local
`obsidian-x.y.z.asar(.gz)` to skip the download, and `CHROMIUM_PATH` to use a specific browser.

```
src/
  boot/      setup page: installing Obsidian, network and storage settings
  sw/        service worker
  runtime/   Electron and Node.js emulation loaded into the app pages
  vfs/       OPFS-backed Node.js fs module
  shared/    asar reader, installer, libcurl.js loader
  server/    static server and Wisp proxy
public/      static assets
test/        unit tests and the end-to-end test
```

## License

obsidian-web is released under the [MIT license](LICENSE).

It uses [libcurl.js](https://github.com/ading2210/libcurl.js) and
[wisp-js](https://github.com/MercuryWorkshop/wisp-js), both under the LGPL 3.0. libcurl.js is shipped as a separate
file (`dist/public/obsidian-web/vendor`); the build disables its Node.js environment detection, see
`scripts/build.ts`.

Obsidian is a trademark of Dynalist Inc. This project is not affiliated with or endorsed by Obsidian. The Obsidian
application may not be redistributed: host obsidian-web for yourself, and let every user download Obsidian themselves.
