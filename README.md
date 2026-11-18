# obsidian-web

Run the official [Obsidian](https://obsidian.md) desktop app in a web browser.

obsidian-web is an Electron/Node.js compatibility layer for the browser. It loads the unmodified Obsidian
desktop bundle (`obsidian.asar`) and provides everything it expects from Electron:

- **Storage**: a Node.js `fs` implementation backed by the
  [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system),
  so vaults live entirely in your browser.
- **Networking**: `requestUrl`, `fetch` and Node's `http`/`https`/`net` modules are routed through
  [libcurl.js](https://github.com/ading2210/libcurl.js) over a [Wisp](https://github.com/MercuryWorkshop/wisp-protocol)
  proxy, so plugins, the community plugin browser and Obsidian Sync work without CORS restrictions.
- **Electron**: `ipcRenderer`, `remote`, `webFrame`, `shell`, `clipboard`, dialogs, menus and the main process IPC
  handlers are reimplemented in the page.

No Obsidian code is included in this repository. On first launch the app downloads the official release from
[obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) (or lets you pick a local `.asar`)
and stores it in OPFS.

> Obsidian is a trademark of Dynalist Inc. This project is not affiliated with or endorsed by Obsidian. The Obsidian
> application may not be redistributed; host obsidian-web for yourself only.
