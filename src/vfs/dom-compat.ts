// Compile-time check (browser tsconfig only) that real OPFS handles satisfy the VFS's structural types.
import type { BlobLike, OpfsDirectoryHandle, OpfsFileHandle } from "./opfs-types.ts";

export type DomDirectoryHandleIsCompatible<T extends OpfsDirectoryHandle = FileSystemDirectoryHandle> = T;
export type DomFileHandleIsCompatible<T extends OpfsFileHandle = FileSystemFileHandle> = T;
export type DomFileIsBlobLike<T extends BlobLike = File> = T;
