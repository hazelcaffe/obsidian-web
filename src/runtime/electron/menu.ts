import { EventEmitter } from "events";
import { IS_MAC } from "../env.ts";

export interface MenuItemOptions {
	id?: string;
	label?: string;
	sublabel?: string;
	type?: "normal" | "separator" | "submenu" | "checkbox" | "radio";
	role?: string;
	accelerator?: string;
	enabled?: boolean;
	visible?: boolean;
	checked?: boolean;
	submenu?: MenuItemOptions[] | Menu;
	click?: (
		item: MenuItem,
		window: unknown,
		event: {
			shiftKey: boolean;
			ctrlKey: boolean;
			metaKey: boolean;
			altKey: boolean;
			triggeredByAccelerator: boolean;
		},
	) => void;
	before?: string[];
	after?: string[];
	appCommand?: string;
}

const ROLE_LABELS: Record<string, string> = {
	undo: "Undo",
	redo: "Redo",
	cut: "Cut",
	copy: "Copy",
	paste: "Paste",
	pasteandmatchstyle: "Paste and Match Style",
	delete: "Delete",
	selectall: "Select All",
	reload: "Reload",
	forcereload: "Force Reload",
	toggledevtools: "Toggle Developer Tools",
	togglefullscreen: "Toggle Full Screen",
	minimize: "Minimize",
	close: "Close",
	quit: "Quit",
	zoom: "Zoom",
	front: "Bring All to Front",
};

function runRole(role: string, win: Window): void {
	const doc = win.document;
	switch (role.toLowerCase()) {
		case "undo":
		case "redo":
		case "cut":
		case "copy":
		case "delete":
			doc.execCommand(role.toLowerCase());
			break;
		case "paste":
		case "pasteandmatchstyle":
			navigator.clipboard
				.readText()
				.then((text) => doc.execCommand("insertText", false, text))
				.catch(() => undefined);
			break;
		case "selectall":
			doc.execCommand("selectAll");
			break;
		case "reload":
		case "forcereload":
			win.location.reload();
			break;
		case "togglefullscreen":
			if (doc.fullscreenElement) {
				void doc.exitFullscreen();
			} else {
				void doc.documentElement.requestFullscreen();
			}
			break;
		case "close":
			win.close();
			break;
		default:
			break;
	}
}

export class MenuItem {
	id: string | undefined;
	label: string;
	sublabel: string;
	type: NonNullable<MenuItemOptions["type"]>;
	role: string | undefined;
	accelerator: string | undefined;
	enabled: boolean;
	visible: boolean;
	checked: boolean;
	submenu: Menu | undefined;
	click: MenuItemOptions["click"];
	menu: Menu | null = null;

	constructor(options: MenuItemOptions) {
		this.id = options.id;
		this.role = options.role;
		this.label = options.label ?? (options.role ? (ROLE_LABELS[options.role.toLowerCase()] ?? options.role) : "");
		this.sublabel = options.sublabel ?? "";
		this.accelerator = options.accelerator;
		this.enabled = options.enabled ?? true;
		this.visible = options.visible ?? true;
		this.checked = options.checked ?? false;
		this.click = options.click;
		if (options.submenu) {
			this.submenu = options.submenu instanceof Menu ? options.submenu : Menu.buildFromTemplate(options.submenu);
		}
		this.type = options.type ?? (this.submenu ? "submenu" : "normal");
	}
}

interface PopupOptions {
	window?: unknown;
	x?: number;
	y?: number;
	positioningItem?: number;
	callback?: () => void;
}

let lastPointer = { x: 0, y: 0, win: window as Window };
export function trackPointer(win: Window): void {
	win.addEventListener(
		"mousedown",
		(event) => {
			lastPointer = { x: event.clientX, y: event.clientY, win };
		},
		true,
	);
	win.addEventListener(
		"contextmenu",
		(event) => {
			lastPointer = { x: event.clientX, y: event.clientY, win };
		},
		true,
	);
}

function formatAccelerator(accelerator: string): string {
	return accelerator
		.replace(/CommandOrControl|CmdOrCtrl/g, IS_MAC ? "⌘" : "Ctrl")
		.replace(/Command|Cmd/g, "⌘")
		.replace(/Control/g, "Ctrl")
		.replace(/Option|Alt/g, IS_MAC ? "⌥" : "Alt")
		.replace(/Shift/g, IS_MAC ? "⇧" : "Shift")
		.replace(/\+/g, IS_MAC ? "" : "+");
}

let openMenu: { close: () => void } | null = null;

function render(menu: Menu, win: Window, x: number, y: number, onClose: () => void, parent?: HTMLElement): () => void {
	const doc = win.document;
	const el = doc.createElement("div");
	el.className = "menu obsidian-web-menu";
	el.style.position = "fixed";
	el.style.zIndex = "var(--layer-menu, 65)";
	el.setAttribute("role", "menu");
	let submenuClose: (() => void) | null = null;
	let lastWasSeparator = true;
	const visible = menu.items.filter((item) => item.visible);
	for (const [index, item] of visible.entries()) {
		if (item.type === "separator") {
			if (!lastWasSeparator && index < visible.length - 1) {
				el.appendChild(Object.assign(doc.createElement("div"), { className: "menu-separator" }));
			}
			lastWasSeparator = true;
			continue;
		}
		lastWasSeparator = false;
		const row = doc.createElement("div");
		row.className = "menu-item tappable";
		if (!item.enabled) {
			row.classList.add("is-disabled");
		}
		const icon = doc.createElement("div");
		icon.className = "menu-item-icon";
		if ((item.type === "checkbox" || item.type === "radio") && item.checked) {
			icon.textContent = "✓";
		}
		const title = doc.createElement("div");
		title.className = "menu-item-title";
		title.textContent = item.label.replace(/&(?!&)/g, "");
		row.append(icon, title);
		if (item.accelerator) {
			const hint = doc.createElement("div");
			hint.className = "menu-item-hotkey";
			hint.style.marginInlineStart = "auto";
			hint.style.opacity = "0.6";
			hint.textContent = formatAccelerator(item.accelerator);
			row.appendChild(hint);
		}
		if (item.submenu) {
			const arrow = doc.createElement("div");
			arrow.className = "menu-item-icon mod-submenu";
			arrow.textContent = "›";
			row.appendChild(arrow);
			row.addEventListener("mouseenter", () => {
				submenuClose?.();
				const rect = row.getBoundingClientRect();
				submenuClose = item.submenu ? render(item.submenu, win, rect.right, rect.top, onClose, el) : null;
			});
		} else {
			row.addEventListener("mouseenter", () => {
				submenuClose?.();
				submenuClose = null;
			});
		}
		row.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (!item.enabled || item.submenu) {
				return;
			}
			onClose();
			if (item.type === "checkbox") {
				item.checked = !item.checked;
			}
			if (item.click) {
				item.click(item, undefined, {
					shiftKey: event.shiftKey,
					ctrlKey: event.ctrlKey,
					metaKey: event.metaKey,
					altKey: event.altKey,
					triggeredByAccelerator: false,
				});
			} else if (item.role) {
				runRole(item.role, win);
			}
		});
		el.appendChild(row);
	}
	(parent ?? doc.body).appendChild(el);
	const width = el.offsetWidth;
	const height = el.offsetHeight;
	const left =
		x + width > win.innerWidth ? Math.max(0, parent ? x - width - (parent.offsetWidth ?? 0) : x - width) : x;
	const top = y + height > win.innerHeight ? Math.max(0, win.innerHeight - height - 4) : y;
	el.style.left = `${left}px`;
	el.style.top = `${top}px`;
	return () => {
		submenuClose?.();
		el.remove();
	};
}

export class Menu extends EventEmitter {
	items: MenuItem[] = [];

	static buildFromTemplate(template: Array<MenuItemOptions | MenuItem>): Menu {
		const menu = new Menu();
		for (const entry of template) {
			menu.append(entry instanceof MenuItem ? entry : new MenuItem(entry));
		}
		return menu;
	}

	static setApplicationMenu(): void {}

	static getApplicationMenu(): Menu | null {
		return null;
	}

	static sendActionToFirstResponder(): void {}

	append(item: MenuItem): void {
		item.menu = this;
		this.items.push(item);
	}

	insert(position: number, item: MenuItem): void {
		item.menu = this;
		this.items.splice(position, 0, item);
	}

	getMenuItemById(id: string): MenuItem | null {
		for (const item of this.items) {
			if (item.id === id) {
				return item;
			}
			const found = item.submenu?.getMenuItemById(id);
			if (found) {
				return found;
			}
		}
		return null;
	}

	popup(options: PopupOptions = {}): void {
		openMenu?.close();
		const target = (options.window as { win?: Window } | undefined)?.win ?? lastPointer.win;
		const x = options.x ?? lastPointer.x;
		const y = options.y ?? lastPointer.y;
		let closed = false;
		const close = (): void => {
			if (closed) {
				return;
			}
			closed = true;
			dispose();
			target.removeEventListener("mousedown", outside, true);
			target.removeEventListener("keydown", onEscape, true);
			target.removeEventListener("blur", close);
			openMenu = null;
			this.emit("menu-will-close");
			options.callback?.();
		};
		const dispose = render(this, target, x, y, close);
		const outside = (event: MouseEvent): void => {
			if (!(event.target as Element | null)?.closest?.(".obsidian-web-menu")) {
				close();
			}
		};
		const onEscape = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				close();
			}
		};
		setTimeout(() => {
			if (!closed) {
				target.addEventListener("mousedown", outside, true);
				target.addEventListener("keydown", onEscape, true);
				target.addEventListener("blur", close);
			}
		}, 0);
		openMenu = { close };
		this.emit("menu-will-show");
	}

	closePopup(): void {
		openMenu?.close();
	}
}
