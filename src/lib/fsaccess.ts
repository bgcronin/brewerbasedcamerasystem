/** Thin helpers around the File System Access API (Chrome / Edge). */

export const fsSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export type PermissionMode = 'read' | 'readwrite';

export async function hasPermission(handle: FileSystemHandle, mode: PermissionMode): Promise<boolean> {
  try {
    return (await handle.queryPermission({ mode })) === 'granted';
  } catch {
    return false;
  }
}

/** Must be called from a user gesture (click / key press) when permission isn't already granted. */
export async function requestPermission(handle: FileSystemHandle, mode: PermissionMode): Promise<boolean> {
  try {
    if ((await handle.queryPermission({ mode })) === 'granted') return true;
    return (await handle.requestPermission({ mode })) === 'granted';
  } catch {
    return false;
  }
}

export async function pickDirectory(id: string, mode: PermissionMode): Promise<FileSystemDirectoryHandle | null> {
  if (!fsSupported) return null;
  try {
    return await window.showDirectoryPicker({ id, mode, startIn: 'documents' });
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return null;
    throw e;
  }
}

export async function getDirPath(root: FileSystemDirectoryHandle, segments: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const s of segments) dir = await dir.getDirectoryHandle(s, { create });
  return dir;
}

export async function fileExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob | string): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(data);
  } finally {
    await w.close();
  }
}

export async function readTextFile(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    const fh = await dir.getFileHandle(name);
    return await (await fh.getFile()).text();
  } catch {
    return null;
  }
}
