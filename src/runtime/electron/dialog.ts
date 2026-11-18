import pathModule from "path-browserify";
import { DOCUMENTS, DOWNLOADS } from "../env.ts";
import { getVfs } from "../vfs-instance.ts";

interface FileFilter {
	name: string;
	extensions: string[];
}

interface OpenDialogOptions {
	title?: string;
	defaultPath?: string;
	buttonLabel?: string;
	filters?: FileFilter[];
	properties?: string[];
	message?: string;
}

interface SaveDialogOptions {
	title?: string;
	defaultPath?: string;
	filters?: FileFilter[];
}

interface MessageBoxOptions {
	message: string;
	type?: string;
	buttons?: string[];
	defaultId?: number;
	cancelId?: number;
	title?: string;
	detail?: string;
	checkboxLabel?: string;
	checkboxChecked?: boolean;
}

function windowOf(target: unknown): Window {
	return (target as { win?: Window } | undefined)?.win ?? window;
}

function splitArgs<T>(args: unknown[]): [Window, T] {
	if (args.length > 1) {
		return [windowOf(args[0]), args[1] as T];
	}
	return [window, (args[0] ?? {}) as T];
}

let uploadCounter = 0;

function pickFiles(win: Window, options: OpenDialogOptions): Promise<string[] | null> {
	const props = options.properties ?? ["openFile"];
	const input = win.document.createElement("input");
	input.type = "file";
	input.multiple = props.includes("multiSelections");
	if (props.includes("openDirectory")) {
		input.webkitdirectory = true;
	}
	const extensions = (options.filters ?? []).flatMap((filter) => filter.extensions).filter((ext) => ext !== "*");
	if (extensions.length > 0 && !props.includes("openDirectory")) {
		input.accept = extensions.map((ext) => `.${ext}`).join(",");
	}
	input.style.display = "none";
	win.document.body.appendChild(input);
	return new Promise((resolve) => {
		const done = (value: string[] | null): void => {
			input.remove();
			resolve(value);
		};
		input.addEventListener("cancel", () => done(null), { once: true });
		input.addEventListener(
			"change",
			() => {
				const files = [...(input.files ?? [])];
				if (files.length === 0) {
					done(null);
					return;
				}
				const vfs = getVfs();
				const root = `/tmp/uploads/${Date.now()}-${uploadCounter++}`;
				const results = new Set<string>();
				for (const file of files) {
					const relative = file.webkitRelativePath || file.name;
					const target = `${root}/${relative}`;
					vfs.registerVirtualFile(target, file);
					results.add(props.includes("openDirectory") ? `${root}/${relative.split("/")[0]}` : target);
				}
				done([...results]);
			},
			{ once: true },
		);
		input.click();
	});
}

function promptPath(win: Window, options: OpenDialogOptions): string[] | undefined {
	const props = options.properties ?? ["openFile"];
	const directory = props.includes("openDirectory");
	const fs = getVfs().fs;
	const base = options.defaultPath ?? DOCUMENTS;
	let listing = "";
	try {
		const dir = fs.statSync(base).isDirectory() ? base : pathModule.dirname(base);
		const entries = fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => !directory || entry.isDirectory())
			.map((entry) => `  ${entry.name}${entry.isDirectory() ? "/" : ""}`)
			.slice(0, 20);
		listing = entries.length > 0 ? `\n\nIn ${dir}:\n${entries.join("\n")}` : "";
	} catch {}
	const kind = directory ? "folder" : "file";
	const answer = win.prompt(
		`${options.title ?? `Choose a ${kind}`}\n\nPath of the ${kind} in this browser's storage:${listing}`,
		base,
	);
	if (!answer) {
		return undefined;
	}
	const resolved = pathModule.resolve(base, answer.trim());
	try {
		if (fs.statSync(resolved).isDirectory() === directory) {
			return [resolved];
		}
	} catch {
		if (directory && props.includes("createDirectory")) {
			fs.mkdirSync(resolved, { recursive: true });
			return [resolved];
		}
	}
	win.alert(`"${resolved}" is not a ${kind}.`);
	return undefined;
}

function savePath(options: SaveDialogOptions): string {
	const fs = getVfs().fs;
	fs.mkdirSync(DOWNLOADS, { recursive: true });
	const name = pathModule.basename(options.defaultPath || "Untitled");
	return `${DOWNLOADS}/${name}`;
}

function messageBox(win: Window, options: MessageBoxOptions): Promise<{ response: number; checkboxChecked: boolean }> {
	const doc = win.document;
	const buttons = options.buttons?.length ? options.buttons : ["OK"];
	const container = doc.createElement("div");
	container.className = "modal-container mod-dim obsidian-web-dialog";
	const bg = doc.createElement("div");
	bg.className = "modal-bg";
	bg.style.opacity = "0.85";
	const modal = doc.createElement("div");
	modal.className = "modal";
	const title = doc.createElement("div");
	title.className = "modal-title";
	title.textContent = options.title || options.message;
	const content = doc.createElement("div");
	content.className = "modal-content";
	if (options.title) {
		content.appendChild(Object.assign(doc.createElement("p"), { textContent: options.message }));
	}
	if (options.detail) {
		content.appendChild(Object.assign(doc.createElement("p"), { textContent: options.detail }));
	}
	let checkbox: HTMLInputElement | null = null;
	if (options.checkboxLabel) {
		const label = doc.createElement("label");
		checkbox = Object.assign(doc.createElement("input"), { type: "checkbox", checked: !!options.checkboxChecked });
		label.append(checkbox, ` ${options.checkboxLabel}`);
		content.appendChild(label);
	}
	const buttonRow = doc.createElement("div");
	buttonRow.className = "modal-button-container";
	modal.append(title, content, buttonRow);
	container.append(bg, modal);
	return new Promise((resolve) => {
		const finish = (response: number): void => {
			container.remove();
			win.removeEventListener("keydown", onKey, true);
			resolve({ response, checkboxChecked: checkbox?.checked ?? false });
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				finish(options.cancelId ?? buttons.length - 1);
			}
		};
		buttons.forEach((label, index) => {
			const button = doc.createElement("button");
			button.textContent = label;
			if (index === (options.defaultId ?? 0)) {
				button.className = "mod-cta";
			}
			button.addEventListener("click", () => finish(index));
			buttonRow.appendChild(button);
		});
		bg.addEventListener("click", () => finish(options.cancelId ?? buttons.length - 1));
		win.addEventListener("keydown", onKey, true);
		doc.body.appendChild(container);
		(buttonRow.querySelector(".mod-cta") as HTMLElement | null)?.focus();
	});
}

export const dialog = {
	showOpenDialogSync(...args: unknown[]): string[] | undefined {
		const [win, options] = splitArgs<OpenDialogOptions>(args);
		return promptPath(win, options);
	},
	async showOpenDialog(...args: unknown[]): Promise<{ canceled: boolean; filePaths: string[] }> {
		const [win, options] = splitArgs<OpenDialogOptions>(args);
		const paths = await pickFiles(win, options);
		return { canceled: !paths, filePaths: paths ?? [] };
	},
	showSaveDialogSync(...args: unknown[]): string | undefined {
		const [, options] = splitArgs<SaveDialogOptions>(args);
		return savePath(options);
	},
	async showSaveDialog(...args: unknown[]): Promise<{ canceled: boolean; filePath: string }> {
		const [, options] = splitArgs<SaveDialogOptions>(args);
		return { canceled: false, filePath: savePath(options) };
	},
	showMessageBoxSync(...args: unknown[]): number {
		const [win, options] = splitArgs<MessageBoxOptions>(args);
		const buttons = options.buttons ?? ["OK"];
		const text = [options.message, options.detail].filter(Boolean).join("\n\n");
		if (buttons.length <= 1) {
			win.alert(text);
			return 0;
		}
		return win.confirm(`${text}\n\n[OK] ${buttons[options.defaultId ?? 0]}`)
			? (options.defaultId ?? 0)
			: (options.cancelId ?? buttons.length - 1);
	},
	showMessageBox(...args: unknown[]): Promise<{ response: number; checkboxChecked: boolean }> {
		const [win, options] = splitArgs<MessageBoxOptions>(args);
		return messageBox(win, options);
	},
	showErrorBox(title: string, content: string): void {
		void messageBox(window, { message: title, detail: content, type: "error" });
	},
	showCertificateTrustDialog: async (): Promise<void> => undefined,
};
