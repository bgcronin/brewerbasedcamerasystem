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
  } catch (e) {
    await w.abort().catch(() => undefined);
    throw e;
  }
  await w.close();
}

export function isNotFound(e: unknown): boolean {
  return (e as DOMException)?.name === 'NotFoundError';
}

/** Returns null only when the file does not exist; any other failure (locked, unreadable) is thrown. */
export async function readTextFile(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  let fh: FileSystemFileHandle;
  try {
    fh = await dir.getFileHandle(name);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
  return (await fh.getFile()).text();
}

/** Rename a file in place. Uses the native move where the browser has it, otherwise copy + delete. */
export async function renameFile(dir: FileSystemDirectoryHandle, from: string, to: string): Promise<void> {
  if (from === to) return;
  const fh = await dir.getFileHandle(from);
  const movable = fh as FileSystemFileHandle & { move?: (name: string) => Promise<void> };
  if (typeof movable.move === 'function') {
    await movable.move(to);
    return;
  }
  await writeFile(dir, to, await fh.getFile());
  await dir.removeEntry(from);
}
