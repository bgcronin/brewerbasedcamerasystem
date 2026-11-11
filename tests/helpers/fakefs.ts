/**
 * In-memory stand-in for the File System Access API, for tests: a folder tree whose
 * writes can be slowed down or made to fail, to stand in for a network share.
 */

export function domError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const fsControl = {
  /** Every write, move and delete takes this long. */
  delayMs: 0,
  /** Writes to paths this returns true for fail (a locked file, a share that has gone away). */
  failWrite: ((_path: string) => false) as (path: string) => boolean,
  reset() {
    this.delayMs = 0;
    this.failWrite = () => false;
  },
};

export class FakeFile {
  readonly kind = 'file' as const;
  modified = Date.now();
  constructor(
    public name: string,
    public parent: FakeDir,
    public data: Blob = new Blob([]),
  ) {}
  path(): string {
    return this.parent.path() + '/' + this.name;
  }
  async getFile(): Promise<File> {
    const type = /\.jpe?g$/i.test(this.name) ? 'image/jpeg' : /\.png$/i.test(this.name) ? 'image/png' : /\.webp$/i.test(this.name) ? 'image/webp' : '';
    return new File([this.data], this.name, { lastModified: this.modified, type });
  }
  async createWritable() {
    if (fsControl.failWrite(this.path())) throw domError('NoModificationAllowedError', 'The file is locked');
    let pending: Blob | null = null;
    return {
      write: async (d: Blob | string) => {
        pending = typeof d === 'string' ? new Blob([d]) : d;
      },
      close: async () => {
        await sleep(fsControl.delayMs);
        if (fsControl.failWrite(this.path())) throw domError('NoModificationAllowedError', 'The file is locked');
        this.data = pending ?? new Blob([]);
        this.modified = Date.now();
      },
      abort: async () => undefined,
    };
  }
  async move(to: string) {
    await sleep(fsControl.delayMs);
    if (!this.parent.children.has(this.name)) throw domError('NotFoundError');
    this.parent.children.delete(this.name);
    this.name = to;
    this.parent.children.set(to, this);
  }
}

export class FakeDir {
  readonly kind = 'directory' as const;
  children = new Map<string, FakeDir | FakeFile>();
  constructor(
    public name: string,
    public parent: FakeDir | null = null,
  ) {}
  path(): string {
    return this.parent ? this.parent.path() + '/' + this.name : this.name;
  }
  async queryPermission() {
    return 'granted';
  }
  async requestPermission() {
    return 'granted';
  }
  async isSameEntry(other: unknown) {
    return other === this;
  }
  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}) {
    const c = this.children.get(name);
    if (c) {
      if (c.kind !== 'directory') throw domError('TypeMismatchError');
      return c;
    }
    if (!opts.create) throw domError('NotFoundError');
    const d = new FakeDir(name, this);
    this.children.set(name, d);
    return d;
  }
  async getFileHandle(name: string, opts: { create?: boolean } = {}) {
    const c = this.children.get(name);
    if (c) {
      if (c.kind !== 'file') throw domError('TypeMismatchError');
      return c;
    }
    if (!opts.create) throw domError('NotFoundError');
    const f = new FakeFile(name, this);
    this.children.set(name, f);
    return f;
  }
  async removeEntry(name: string) {
    await sleep(fsControl.delayMs);
    if (!this.children.has(name)) throw domError('NotFoundError');
    this.children.delete(name);
  }
  async *entries(): AsyncGenerator<[string, FakeDir | FakeFile]> {
    for (const e of [...this.children.entries()]) yield e;
  }
  /** Put a file straight into the folder, as a camera or another program would. */
  drop(name: string, data: Blob): FakeFile {
    const f = new FakeFile(name, this, data);
    this.children.set(name, f);
    return f;
  }
}

/** Every file under a folder, as sorted relative paths. */
export function tree(d: FakeDir, prefix = ''): string[] {
  const out: string[] = [];
  for (const [name, c] of d.children) {
    if (c.kind === 'directory') out.push(...tree(c, prefix + name + '/'));
    else out.push(prefix + name);
  }
  return out.sort();
}

export async function readJson<T = unknown>(d: FakeDir, path: string): Promise<T> {
  const segs = path.split('/');
  let dir: FakeDir = d;
  for (const s of segs.slice(0, -1)) dir = dir.children.get(s) as FakeDir;
  return JSON.parse(await (dir.children.get(segs[segs.length - 1]) as FakeFile).data.text()) as T;
}
