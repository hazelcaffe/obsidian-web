import { EventEmitter } from "events";

export interface IpcSender {
	readonly id: number;
	readonly win: Window;
	send(channel: string, ...args: unknown[]): void;
}

export interface IpcMainEvent {
	sender: IpcSender;
	returnValue: unknown;
	processId: number;
	frameId: number;
	reply(channel: string, ...args: unknown[]): void;
}

export type IpcListener = (event: IpcMainEvent, ...args: never[]) => void;
export type IpcInvokeHandler = (event: IpcMainEvent, ...args: never[]) => unknown;

const listeners = new Map<string, IpcListener>();
const invokeHandlers = new Map<string, IpcInvokeHandler>();
const warned = new Set<string>();

/** The emulated `ipcMain`: handlers run in the page, synchronously for `sendSync`. */
export const ipcMain = {
	on(channel: string, listener: IpcListener): void {
		listeners.set(channel, listener);
	},
	handle(channel: string, handler: IpcInvokeHandler): void {
		invokeHandlers.set(channel, handler);
	},
};

function createEvent(sender: IpcSender): IpcMainEvent {
	return {
		sender,
		returnValue: undefined,
		processId: 1,
		frameId: 1,
		reply: (channel, ...args) => sender.send(channel, ...args),
	};
}

function dispatch(sender: IpcSender, channel: string, args: unknown[]): IpcMainEvent {
	const event = createEvent(sender);
	const listener = listeners.get(channel);
	if (listener) {
		(listener as (event: IpcMainEvent, ...args: unknown[]) => void)(event, ...args);
	} else if (!warned.has(channel)) {
		warned.add(channel);
		console.warn(`[obsidian-web] Unhandled IPC message "${channel}"`);
	}
	return event;
}

/** The renderer side `ipcRenderer` of one window. Messages from "main" are emitted on it. */
export class IpcRenderer extends EventEmitter {
	readonly #sender: IpcSender;

	constructor(sender: IpcSender) {
		super();
		this.setMaxListeners(0);
		this.#sender = sender;
	}

	sendSync(channel: string, ...args: unknown[]): unknown {
		return dispatch(this.#sender, channel, args).returnValue;
	}

	send(channel: string, ...args: unknown[]): void {
		setTimeout(() => {
			try {
				dispatch(this.#sender, channel, args);
			} catch (error) {
				console.error(`IPC handler for "${channel}" failed`, error);
			}
		}, 0);
	}

	async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
		const handler = invokeHandlers.get(channel);
		if (!handler) {
			throw new Error(`No handler registered for '${channel}'`);
		}
		return (handler as (event: IpcMainEvent, ...args: unknown[]) => unknown)(createEvent(this.#sender), ...args);
	}

	sendTo(): void {}

	sendToHost(): void {}

	postMessage(): void {}
}
