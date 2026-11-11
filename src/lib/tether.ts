/**
 * Watches a "hot folder" for new photos.
 *
 * This is how full-resolution stills get in from a Canon EOS: Canon's EOS
 * Utility (Remote Shooting) saves every shot to a folder on the PC, and this
 * watcher picks each one up the moment it has finished writing. The same works
 * for any camera software that saves to a folder (e.g. CSO Phoenix exports).
 */

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
/** Files a browser can't display: camera RAW, and HEIF from newer Canon bodies. */
const RAW_EXT = /\.(cr2|cr3|crw|nef|arw|dng|raf|orf|rw2|hif|heic|heif)$/i;
const IGNORE = /^(\.|~\$|thumbs\.db$|desktop\.ini$)|\.(tmp|part|crdownload)$/i;

export interface TetherEvents {
  /**
   * A new photo has appeared and is still being written. Called once per file, a second or two
   * before `onFile`: the moment to note which patient and eye are selected.
   */
  onSeen?(path: string): void;
  /** The photo is complete. Throw to have it tried again (up to three times; `attempt` counts from 1). */
  onFile(file: File, path: string, handle: FileSystemFileHandle, parent: FileSystemDirectoryHandle, attempt: number): Promise<void> | void;
  /** A photo that arrived while nobody was watching (found when watching starts). */
  onMissed?(file: File, path: string, handle: FileSystemFileHandle, parent: FileSystemDirectoryHandle): void;
  onRawOnly?(name: string): void;
  /** A scan of the folder failed. `streak` is how many have failed in a row. */
  onError?(err: unknown, streak: number): void;
  /** The folder is readable again after one or more failed scans. */
  onRecovered?(): void;
}

interface Seen {
  size: number;
  modified: number;
}

const MAX_ATTEMPTS = 3;
/** How long a file must be unchanged before it is read (mtime is coarse on FAT/SMB and lags on NTFS). */
const SETTLE_MS = 1500;
/** After this long unchanged a file is taken as finished even if it doesn't end the way a JPEG should. */
const SETTLE_ANYWAY_MS = 8000;

/** True when the data ends with a JPEG end-of-image marker, i.e. the camera has finished writing it. */
async function looksComplete(file: File): Promise<boolean> {
  if (!/\.jpe?g$/i.test(file.name) || file.size < 4) return true;
  const tail = new Uint8Array(await file.slice(file.size - 2).arrayBuffer());
  return tail[0] === 0xff && tail[1] === 0xd9;
}

export class FolderWatcher {
  private seen = new Map<string, Seen>();
  /** Files being written: their last signature and when (on this PC's steady clock) it stopped changing. */
  private pending = new Map<string, Seen & { since: number }>();
  private attempts = new Map<string, number>();
  private timer: number | null = null;
  private busy = false;
  private stopped = true;
  private failures = 0;

  constructor(
    readonly dir: FileSystemDirectoryHandle,
    private events: TetherEvents,
    private intervalMs = 900,
  ) {}

  get running(): boolean {
    return !this.stopped;
  }

  /**
   * Files already in the folder when watching starts are treated as old and left alone, except
   * those newer than `missedSince` (when Lumen last watched this folder): they are photos taken
   * while Lumen was closed or waiting for permission, and are handed to `onMissed`.
   */
  async start(missedSince?: number): Promise<void> {
    this.stopped = false;
    for await (const entry of this.walk(this.dir, '', 0)) {
      this.seen.set(entry.path, { size: entry.file.size, modified: entry.file.lastModified });
      const missed = missedSince != null && entry.file.lastModified > missedSince && entry.file.lastModified <= Date.now() + 60_000;
      if (missed && IMAGE_EXT.test(entry.path)) this.events.onMissed?.(entry.file, entry.path, entry.handle, entry.parent);
    }
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = window.setTimeout(() => void this.poll(), this.intervalMs);
  }

  private async poll() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const entries = [];
      for await (const entry of this.walk(this.dir, '', 0)) entries.push(entry);
      if (this.failures) {
        this.failures = 0;
        this.events.onRecovered?.();
      }
      const stem = (p: string) => p.replace(/\.[^.]+$/, '').toLowerCase();
      const imageStems = new Set(entries.filter((e) => IMAGE_EXT.test(e.path)).map((e) => stem(e.path)));
      for (const { path, file, handle, parent } of entries) {
        if (this.stopped) break;
        const sig = { size: file.size, modified: file.lastModified };
        const prev = this.seen.get(path);
        if (prev && prev.size === sig.size) {
          // Already dealt with. A change of timestamp alone (a viewer or a sync tool touching the
          // file) is not a new photo.
          if (prev.modified !== sig.modified) this.seen.set(path, sig);
          continue;
        }
        if (RAW_EXT.test(path)) {
          this.seen.set(path, sig);
          // RAW+JPEG is fine (the JPEG is imported); RAW on its own can't be shown in a browser.
          if (!imageStems.has(stem(path))) this.events.onRawOnly?.(file.name);
          continue;
        }
        // Wait until the file stops growing: EOS Utility writes large JPEGs in chunks. The wait is
        // timed on this PC's steady clock, not the file's timestamp, which may be set by a camera
        // or a file server whose clock is ahead of or behind this one.
        const now = performance.now();
        const pend = this.pending.get(path);
        if (!pend) this.events.onSeen?.(path);
        if (!pend || pend.size !== sig.size || pend.modified !== sig.modified || sig.size === 0) {
          this.pending.set(path, { ...sig, since: now });
          continue;
        }
        const quiet = now - pend.since;
        if (quiet < SETTLE_MS) continue;
        if (quiet < SETTLE_ANYWAY_MS && !(await looksComplete(file))) continue;
        this.pending.delete(path);
        this.seen.set(path, sig);
        const attempt = (this.attempts.get(path) ?? 0) + 1;
        try {
          await this.events.onFile(file, path, handle, parent, attempt);
          this.attempts.delete(path);
        } catch {
          // Try again on the next polls (the file may still have been mid-write); the last attempt
          // is told so, and what happens to the photo then is up to the listener.
          if (attempt < MAX_ATTEMPTS) {
            this.attempts.set(path, attempt);
            this.seen.delete(path);
          } else {
            this.attempts.delete(path);
          }
        }
      }
    } catch (e) {
      this.failures++;
      this.events.onError?.(e, this.failures);
    } finally {
      this.busy = false;
      this.schedule();
    }
  }

  /** Scan the folder and up to two levels of sub-folders (EOS Utility can create dated sub-folders). */
  private async *walk(
    dir: FileSystemDirectoryHandle,
    prefix: string,
    depth: number,
  ): AsyncGenerator<{ path: string; file: File; handle: FileSystemFileHandle; parent: FileSystemDirectoryHandle }> {
    for await (const [name, entry] of dir.entries()) {
      if (IGNORE.test(name)) continue;
      const path = prefix + name;
      if (entry.kind === 'directory') {
        if (depth < 2) yield* this.walk(entry as FileSystemDirectoryHandle, path + '/', depth + 1);
        continue;
      }
      if (!IMAGE_EXT.test(name) && !RAW_EXT.test(name)) continue;
      try {
        const handle = entry as FileSystemFileHandle;
        yield { path, file: await handle.getFile(), handle, parent: dir };
      } catch {
        // File vanished or is locked mid-write; try again next poll.
      }
    }
  }
}

/** The last attempt a watcher makes for one file. */
export const TETHER_LAST_ATTEMPT = MAX_ATTEMPTS;

export function isImageFile(name: string): boolean {
  return IMAGE_EXT.test(name);
}
