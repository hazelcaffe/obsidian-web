# `obsidian-web`
[Obsidian](https://obsidian.md/) webport by GPT-6 Astra!
```sh
pnpm i
pnpm build
pnpm start # serves dist at `/` & wisp at `/wisp/`
```
http://localhost:3000

## Versions
The build pins Obsidian **1.15.1**, with downloads cached in `.cache/`. To build another release or use a local archive:
```sh
OBSIDIAN_VERSION=1.15.1 pnpm build
OBSIDIAN_ASAR=/path/to/obsidian.asar pnpm build
```
`.asar.gz` is also accepted.

## Networking
**Settings -> Obsidian Web -> Wisp proxy URL**\
Uses [libcurl.js](https://github.com/ading2210/libcurl.js) & [wisp-js](https://github.com/mercuryWorkshop/wisp-js)

## Compatibility
Limitations:
- Plugins requiring native binaries or `child_process` cannot run.
- Browsers reserve shortcuts such as `Ctrl+W`, `Ctrl+T`, and `Ctrl+N`.
- PDF export uses the browser print dialog. Canvas viewport screenshots are not implemented.
- Settings default to an in-page dialog; Obsidian's separate-window option still works.
- Paths use POSIX semantics, including on Windows. Large uncached synchronous file reads can return `EAGAIN`; async reads load the data on demand.
- `safeStorage` uses a key held in the same browser origin, rather than an OS keychain.
