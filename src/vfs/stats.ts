import type { Buffer } from "buffer";
import { constants, S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } from "./constants.ts";

export interface StatsInit {
	dev: number;
	ino: number;
	mode: number;
	nlink: number;
	uid: number;
	gid: number;
	rdev: number;
	size: number;
	blksize: number;
	blocks: number;
	atimeMs: number;
	mtimeMs: number;
	ctimeMs: number;
	birthtimeMs: number;
}

export class Stats {
	dev = 0;
	ino = 0;
	mode = 0;
	nlink = 0;
	uid = 0;
	gid = 0;
	rdev = 0;
	size = 0;
	blksize = 4096;
	blocks = 0;
	atimeMs = 0;
	mtimeMs = 0;
	ctimeMs = 0;
	birthtimeMs = 0;
	atime: Date;
	mtime: Date;
	ctime: Date;
	birthtime: Date;

	constructor(init?: Partial<StatsInit>) {
		Object.assign(this, init);
		this.atime = new Date(this.atimeMs);
		this.mtime = new Date(this.mtimeMs);
		this.ctime = new Date(this.ctimeMs);
		this.birthtime = new Date(this.birthtimeMs);
	}

	isFile(): boolean {
		return (this.mode & S_IFMT) === S_IFREG;
	}

	isDirectory(): boolean {
		return (this.mode & S_IFMT) === S_IFDIR;
	}

	isSymbolicLink(): boolean {
		return (this.mode & S_IFMT) === S_IFLNK;
	}

	isBlockDevice(): boolean {
		return (this.mode & S_IFMT) === constants.S_IFBLK;
	}

	isCharacterDevice(): boolean {
		return (this.mode & S_IFMT) === constants.S_IFCHR;
	}

	isFIFO(): boolean {
		return (this.mode & S_IFMT) === constants.S_IFIFO;
	}

	isSocket(): boolean {
		return (this.mode & S_IFMT) === constants.S_IFSOCK;
	}
}

export const DIRENT_UNKNOWN = constants.UV_DIRENT_UNKNOWN;
export const DIRENT_FILE = constants.UV_DIRENT_FILE;
export const DIRENT_DIR = constants.UV_DIRENT_DIR;
export const DIRENT_LINK = constants.UV_DIRENT_LINK;

export class Dirent<Name extends string | Buffer = string> {
	name: Name;
	parentPath: string;
	#type: number;

	constructor(name: Name, type: number, parentPath: string) {
		this.name = name;
		this.parentPath = parentPath;
		this.#type = type;
	}

	/** @deprecated Use `parentPath`. */
	get path(): string {
		return this.parentPath;
	}

	isFile(): boolean {
		return this.#type === DIRENT_FILE;
	}

	isDirectory(): boolean {
		return this.#type === DIRENT_DIR;
	}

	isSymbolicLink(): boolean {
		return this.#type === DIRENT_LINK;
	}

	isBlockDevice(): boolean {
		return this.#type === constants.UV_DIRENT_BLOCK;
	}

	isCharacterDevice(): boolean {
		return this.#type === constants.UV_DIRENT_CHAR;
	}

	isFIFO(): boolean {
		return this.#type === constants.UV_DIRENT_FIFO;
	}

	isSocket(): boolean {
		return this.#type === constants.UV_DIRENT_SOCKET;
	}
}

export class StatFs {
	type = 0xef53;
	bsize = 4096;
	blocks = 268435456;
	bfree = 201326592;
	bavail = 201326592;
	files = 16777216;
	ffree = 15728640;
}
