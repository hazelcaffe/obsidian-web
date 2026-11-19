/** Inline so there is feedback before the runtime bundle has downloaded. */
export function loadingScreen(base: string): { style: string; html: string } {
	return {
		style: `<style id="obsidian-web-loading-style">
#obsidian-web-loading {
	position: fixed; inset: 0; z-index: 99998;
	display: grid; place-content: center; justify-items: center; gap: 16px;
	background: #1e1e1e; color: #dadada; font: 14px system-ui, sans-serif;
}
#obsidian-web-loading img { width: 48px; height: 48px; }
#obsidian-web-loading p { margin: 0; }
#obsidian-web-loading progress {
	width: 220px; height: 4px; border: 0; border-radius: 4px;
	overflow: hidden; accent-color: #8a5cf5; background: #363636;
}
#obsidian-web-loading progress::-webkit-progress-bar { background: #363636; }
#obsidian-web-loading progress::-webkit-progress-value { background: #8a5cf5; }
#obsidian-web-loading progress::-moz-progress-bar { background: #8a5cf5; }
@media (prefers-color-scheme: light) {
	#obsidian-web-loading { background: #f6f6f6; color: #333; }
}
</style>`,
		html: `<div id="obsidian-web-loading" role="status" aria-live="polite" aria-busy="true">
<img src="${base}icon.png" alt="" width="48" height="48"/>
<p id="obsidian-web-loading-status">Downloading app files…</p>
<progress aria-label="App download progress"></progress>
</div>`,
	};
}
