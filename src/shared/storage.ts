export const OPFS_VFS_DIR = "vfs";
export const VFS_META_FILE = "vfs-meta.json";

export function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
	return navigator.storage.getDirectory();
}
