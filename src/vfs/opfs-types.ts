// Structural subset of the File System Access API used by the VFS. The DOM `FileSystemDirectoryHandle` satisfies
// these interfaces (see dom-compat.ts); tests provide an in-memory implementation.

export interface OpfsFile {
	readonly size: number;
	readonly lastModified: number;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export type OpfsWriteChunk =
	| Uint8Array<ArrayBuffer>
	| { type: "write"; position: number; data: Uint8Array<ArrayBuffer> }
	| { type: "truncate"; size: number }
	| { type: "seek"; position: number };

export interface OpfsWritable {
	write(data: OpfsWriteChunk): Promise<void>;
	truncate(size: number): Promise<void>;
	close(): Promise<void>;
	abort?(reason?: unknown): Promise<void>;
}

export interface OpfsHandleBase {
	readonly kind: "file" | "directory";
	readonly name: string;
}

export interface OpfsFileHandle extends OpfsHandleBase {
	readonly kind: "file";
	getFile(): Promise<OpfsFile>;
	createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritable>;
	move?(destination: OpfsDirectoryHandle, newName: string): Promise<void>;
}

export interface OpfsDirectoryHandle extends OpfsHandleBase {
	readonly kind: "directory";
	getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
	getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
	values?(): AsyncIterable<OpfsHandleBase>;
	move?(destination: OpfsDirectoryHandle, newName: string): Promise<void>;
	isSameEntry?(other: OpfsHandleBase): Promise<boolean>;
}

export type OpfsHandle = OpfsFileHandle | OpfsDirectoryHandle;

export interface BlobLike {
	readonly size: number;
	readonly lastModified?: number;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export function isFileHandle(handle: OpfsHandleBase): handle is OpfsFileHandle {
	return handle.kind === "file";
}

export function isDirectoryHandle(handle: OpfsHandleBase): handle is OpfsDirectoryHandle {
	return handle.kind === "directory";
}
