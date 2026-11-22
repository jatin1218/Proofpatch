import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface DirEntry {
  name: string;
  isDir: boolean;
  isFile: boolean;
}

/**
 * Storage abstraction. The engine only touches the workspace through this interface, so the VS Code
 * extension can plug in a vscode.workspace.fs-based implementation (see adapters/vscode).
 * Symlinks are reported as 'symlink' and are never followed, read through or written through.
 */
export interface FileSystem {
  kind(abs: string): Promise<'file' | 'dir' | 'symlink' | 'none'>;
  readFile(abs: string): Promise<string>;
  /** Must be atomic per file: readers see old or new content, never a partial write. */
  writeFileAtomic(abs: string, content: string): Promise<void>;
  remove(abs: string): Promise<void>;
  readdir(abs: string): Promise<DirEntry[]>;
  realpath?(abs: string): Promise<string>;
}

const isNotFound = (e: unknown) =>
  typeof e === 'object' && e !== null && ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '');

export class NodeFileSystem implements FileSystem {
  async kind(abs: string): Promise<'file' | 'dir' | 'symlink' | 'none'> {
    try {
      const st = await fsp.lstat(abs);
      if (st.isSymbolicLink()) return 'symlink';
      if (st.isDirectory()) return 'dir';
      return st.isFile() ? 'file' : 'none';
    } catch (e) {
      if (isNotFound(e)) return 'none';
      throw e;
    }
  }

  readFile(abs: string): Promise<string> {
    return fsp.readFile(abs, 'utf8');
  }

  async writeFileAtomic(abs: string, content: string): Promise<void> {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    let mode: number | undefined;
    try {
      mode = (await fsp.stat(abs)).mode & 0o777; // keep executable bits etc.
    } catch {
      /* new file */
    }
    const tmp = `${abs}.pp-tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    const fh = await fsp.open(tmp, 'w', 0o644);
    try {
      await fh.writeFile(content, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      if (mode !== undefined) await fsp.chmod(tmp, mode);
      await fsp.rename(tmp, abs);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
  }

  async remove(abs: string): Promise<void> {
    await fsp.rm(abs, { force: true });
  }

  async readdir(abs: string): Promise<DirEntry[]> {
    const ents = await fsp.readdir(abs, { withFileTypes: true });
    // Dirent for a symlink reports neither dir nor file -> symlinks are skipped on purpose.
    return ents.map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }));
  }

  realpath(abs: string): Promise<string> {
    return fsp.realpath(abs);
  }
}

/** In-memory backend for tests, with write-failure injection. Paths must be absolute POSIX paths. */
export class MemoryFileSystem implements FileSystem {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>(['/']);
  /** Throw from writeFileAtomic/remove when this predicate returns true. */
  failWhen?: (op: 'write' | 'remove', abs: string) => boolean;

  constructor(init: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(init)) this.put(p, c);
  }

  private put(abs: string, content: string) {
    this.files.set(abs, content);
    for (let d = path.dirname(abs); !this.dirs.has(d); d = path.dirname(d)) this.dirs.add(d);
  }

  async kind(abs: string): Promise<'file' | 'dir' | 'symlink' | 'none'> {
    if (this.files.has(abs)) return 'file';
    if (this.dirs.has(abs)) return 'dir';
    return 'none';
  }
  async readFile(abs: string): Promise<string> {
    const c = this.files.get(abs);
    if (c === undefined) throw Object.assign(new Error(`ENOENT: ${abs}`), { code: 'ENOENT' });
    return c;
  }
  async writeFileAtomic(abs: string, content: string): Promise<void> {
    if (this.failWhen?.('write', abs)) throw new Error(`injected write failure: ${abs}`);
    this.put(abs, content);
  }
  async remove(abs: string): Promise<void> {
    if (this.failWhen?.('remove', abs)) throw new Error(`injected remove failure: ${abs}`);
    this.files.delete(abs);
  }
  async readdir(abs: string): Promise<DirEntry[]> {
    const out = new Map<string, DirEntry>();
    for (const f of this.files.keys()) if (path.dirname(f) === abs) out.set(path.basename(f), { name: path.basename(f), isDir: false, isFile: true });
    for (const d of this.dirs) if (d !== abs && path.dirname(d) === abs) out.set(path.basename(d), { name: path.basename(d), isDir: true, isFile: false });
    return [...out.values()];
  }
  async realpath(abs: string): Promise<string> {
    return abs;
  }
}
