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

export function isNotFound(e: unknown): boolean {
  return (e as DOMException)?.name === 'NotFoundError';
}

/**
 * False only when nothing has that name. Any other failure (folder unreachable, permission lost)
 * is thrown, so "couldn't look" is never mistaken for "isn't there".
 */
export async function fileExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    if ((e as DOMException)?.name === 'TypeMismatchError') return true; // a folder has that name
    throw e;
  }
}

/** Size in bytes, or null when the file does not exist. */
export async function fileSize(dir: FileSystemDirectoryHandle, name: string): Promise<number | null> {
  try {
    return (await (await dir.getFileHandle(name)).getFile()).size;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

export async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob | string): Promise<void> {
  const existed = await fileExists(dir, name);
  const fh = await dir.getFileHandle(name, { create: true });
  try {
    const w = await fh.createWritable();
    try {
      await w.write(data);
    } catch (e) {
      await w.abort().catch(() => undefined);
      throw e;
    }
    await w.close();
  } catch (e) {
    // Don't leave an empty file behind where there was none: it would look like a real photo.
    if (!existed) await dir.removeEntry(name).catch(() => undefined);
    throw e;
  }
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

/**
 * Rename a file in place. Uses the native move where the browser has it and falls back to
 * copy + delete if that is missing or fails. Never replaces another file unless `overwrite` is set
 * (the native move would do so silently).
 */
export async function renameFile(dir: FileSystemDirectoryHandle, from: string, to: string, overwrite = false): Promise<void> {
  if (from === to) return;
  const fh = await dir.getFileHandle(from);
  if (!overwrite && (await fileExists(dir, to))) throw new Error(`A file named ${to} already exists`);
  const movable = fh as FileSystemFileHandle & { move?: (name: string) => Promise<void> };
  if (typeof movable.move === 'function') {
    try {
      await movable.move(to);
      return;
    } catch (e) {
      if (isNotFound(e)) throw e;
      // Some drives and network shares refuse a move; copying still works there.
    }
  }
  await writeFile(dir, to, await fh.getFile());
  await dir.removeEntry(from);
}
