export interface AsarFileEntry {
	size: number;
	offset: string;
	unpacked?: boolean;
	executable?: boolean;
}

export interface AsarDirectoryEntry {
	files: Record<string, AsarEntry>;
}

export interface AsarLinkEntry {
	link: string;
}

export type AsarEntry = AsarFileEntry | AsarDirectoryEntry | AsarLinkEntry;

export interface AsarFileLocation {
	start: number;
	size: number;
}

/** A parsed asar header. File data lives at `dataOffset + entry.offset` in the archive. */
export class AsarArchive {
	readonly root: AsarDirectoryEntry;
	readonly dataOffset: number;

	constructor(root: AsarDirectoryEntry, dataOffset: number) {
		this.root = root;
		this.dataOffset = dataOffset;
	}

	/** Parses the header from the first bytes of an archive (`readHeaderLength` tells how many are needed). */
	static parse(bytes: Uint8Array): AsarArchive {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (bytes.byteLength < 16 || view.getUint32(0, true) !== 4) {
			throw new Error("Not an asar archive");
		}
		const headerSize = view.getUint32(4, true);
		const jsonSize = view.getUint32(12, true);
		if (bytes.byteLength < 16 + jsonSize) {
			throw new Error("Truncated asar header");
		}
		const json = new TextDecoder().decode(bytes.subarray(16, 16 + jsonSize));
		const root = JSON.parse(json) as AsarDirectoryEntry;
		if (!root || typeof root !== "object" || !("files" in root)) {
			throw new Error("Invalid asar header");
		}
		return new AsarArchive(root, 8 + headerSize);
	}

	/** Number of bytes needed from the start of the archive to parse the header, given its first 16 bytes. */
	static readHeaderLength(prefix: Uint8Array): number {
		const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
		return 16 + view.getUint32(12, true);
	}

	static async fromBlob(blob: Blob): Promise<AsarArchive> {
		const prefix = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
		const length = AsarArchive.readHeaderLength(prefix);
		return AsarArchive.parse(new Uint8Array(await blob.slice(0, length).arrayBuffer()));
	}

	getEntry(path: string): AsarEntry | null {
		let entry: AsarEntry = this.root;
		for (const part of path.split("/")) {
			if (part === "" || part === ".") {
				continue;
			}
			if (!("files" in entry)) {
				return null;
			}
			const next: AsarEntry | undefined = Object.hasOwn(entry.files, part) ? entry.files[part] : undefined;
			if (!next) {
				return null;
			}
			entry = next;
		}
		return entry;
	}

	locate(path: string): AsarFileLocation | null {
		const entry = this.getEntry(path);
		if (!entry || !("size" in entry) || entry.unpacked) {
			return null;
		}
		return { start: this.dataOffset + Number(entry.offset), size: entry.size };
	}

	isDirectory(path: string): boolean {
		const entry = this.getEntry(path);
		return !!entry && "files" in entry;
	}

	list(path: string): string[] {
		const entry = this.getEntry(path);
		return entry && "files" in entry ? Object.keys(entry.files) : [];
	}

	/** Lists every file path (relative, `/` separated) below `path`. */
	walk(path = ""): string[] {
		const out: string[] = [];
		const visit = (dir: AsarDirectoryEntry, prefix: string): void => {
			for (const [name, child] of Object.entries(dir.files)) {
				const childPath = prefix ? `${prefix}/${name}` : name;
				if ("files" in child) {
					visit(child, childPath);
				} else if ("size" in child) {
					out.push(childPath);
				}
			}
		};
		const start = this.getEntry(path);
		if (start && "files" in start) {
			visit(start, path.replace(/^\/+|\/+$/g, ""));
		}
		return out;
	}
}
