import * as path from 'node:path';
import type { FileSystem } from './fs';
import { EngineError, globToRegExp, isProtectedPath, isSecretPath, normalizeRel, toAbs } from './paths';
import { splitLines } from './diff';
import type { StagedMap } from './types';

export interface StagedProvider {
  peekStaged(): StagedMap;
  getStagedFingerprint(): string;
}

export const DEFAULT_IGNORE_DIRS = [
  '.git',
  '.proofpatch',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
  'dist',
  'build',
  '.next',
  'target',
  'coverage'
];

export interface ListOptions {
  /** Restrict to a workspace-relative directory. */
  dir?: string;
  maxEntries?: number;
  includeSecrets?: boolean;
}
export interface SearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
  /** e.g. ["src/**\/*.py"] */
  globs?: string[];
  dir?: string;
  maxFileBytes?: number;
}
export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

/**
 * The single, consistent view of the workspace: disk content with accepted (staged) hunks overlaid.
 * MCP read/list/search/symbol tools and validation snapshots must all go through this class so that
 * nobody observes a different version of a file than anyone else.
 */
export class WorkspaceView {
  constructor(
    private readonly root: string,
    private readonly fs: FileSystem,
    private readonly staged: StagedProvider,
    private readonly ignoreDirs: Set<string>
  ) {}

  private rel(p: string): string {
    return normalizeRel(this.root, p);
  }

  /** Is this path currently modified/created/deleted by staged hunks? */
  isStaged(p: string): boolean {
    return this.staged.peekStaged().has(this.rel(p));
  }

  async exists(p: string): Promise<boolean> {
    const rel = this.rel(p);
    const s = this.staged.peekStaged().get(rel);
    if (s) return s.kind !== 'delete';
    return (await this.fs.kind(toAbs(this.root, rel))) === 'file';
  }

  async readFile(p: string): Promise<string> {
    const rel = this.rel(p);
    const s = this.staged.peekStaged().get(rel);
    if (s) {
      if (s.kind === 'delete') throw new EngineError('NOT_FOUND', `${rel} is deleted in the staged view`);
      return s.content ?? '';
    }
    const abs = toAbs(this.root, rel);
    const kind = await this.fs.kind(abs);
    if (kind === 'none') throw new EngineError('NOT_FOUND', `${rel} does not exist`);
    if (kind !== 'file') throw new EngineError('NOT_A_FILE', `${rel} is a ${kind}`);
    return this.fs.readFile(abs);
  }

  /** Bounded read, 1-based inclusive line range. */
  async readLines(p: string, startLine: number, endLine: number) {
    const lines = splitLines(await this.readFile(p));
    const start = Math.max(1, Math.floor(startLine));
    const end = Math.min(lines.length, Math.floor(endLine));
    return {
      path: this.rel(p),
      startLine: start,
      endLine: end,
      totalLines: lines.length,
      text: start > end ? '' : lines.slice(start - 1, end).join('')
    };
  }

  private async walkDisk(dirRel: string, opts: ListOptions, out: string[], limit: number): Promise<boolean> {
    let entries;
    try {
      entries = await this.fs.readdir(dirRel ? toAbs(this.root, dirRel) : this.root);
    } catch {
      return false;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isDir) {
        if (this.ignoreDirs.has(e.name) || isProtectedPath(rel)) continue;
        if (await this.walkDisk(rel, opts, out, limit)) return true;
      } else if (e.isFile) {
        if (!opts.includeSecrets && isSecretPath(rel)) continue;
        out.push(rel);
        if (out.length >= limit) return true;
      }
    }
    return false;
  }

  /** Sorted workspace-relative file paths, as the staged view sees them. */
  async listFiles(opts: ListOptions = {}): Promise<{ files: string[]; truncated: boolean }> {
    const limit = opts.maxEntries ?? 20000;
    const dir = opts.dir ? this.rel(opts.dir) : '';
    const disk: string[] = [];
    const truncated = await this.walkDisk(dir, opts, disk, limit);
    const set = new Set(disk);
    for (const [rel, s] of this.staged.peekStaged()) {
      if (dir && !rel.startsWith(dir + '/')) continue;
      if (s.kind === 'delete') set.delete(rel);
      else if (!isProtectedPath(rel) && (opts.includeSecrets || !isSecretPath(rel))) set.add(rel);
    }
    return { files: [...set].sort(), truncated };
  }

  /** Overlay-consistent text search (plain substring by default). */
  async search(query: string, opts: SearchOptions = {}) {
    if (!query) throw new EngineError('BAD_QUERY', 'Empty search query');
    const maxResults = opts.maxResults ?? 100;
    const maxBytes = opts.maxFileBytes ?? 1_000_000;
    let re: RegExp;
    try {
      const src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(src, opts.caseSensitive ? '' : 'i');
    } catch (e) {
      throw new EngineError('BAD_QUERY', `Invalid regular expression: ${(e as Error).message}`);
    }
    const globRes = (opts.globs ?? []).map(globToRegExp);
    const { files } = await this.listFiles({ dir: opts.dir });
    const matches: SearchMatch[] = [];
    let scanned = 0;
    let truncated = false;
    for (const f of files) {
      if (globRes.length && !globRes.some((g) => g.test(f))) continue;
      let text: string;
      try {
        text = await this.readFile(f);
      } catch {
        continue;
      }
      if (text.length > maxBytes || text.includes('\0')) continue;
      scanned++;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = re.exec(lines[i]);
        if (m) {
          matches.push({ path: f, line: i + 1, column: m.index + 1, text: lines[i].replace(/\r$/, '').slice(0, 300) });
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
        }
      }
      if (truncated) break;
    }
    return { matches, truncated, filesScanned: scanned };
  }

  /**
   * For tools that search the DISK directly (e.g. ripgrep): the paths whose content differs from disk.
   * Re-run the search on these paths via search()/readFile() and merge, so results stay consistent.
   */
  async overlayState() {
    const modified: string[] = [];
    const created: string[] = [];
    const deleted: string[] = [];
    for (const [rel, s] of this.staged.peekStaged()) {
      if (s.kind === 'delete') deleted.push(rel);
      else if ((await this.fs.kind(toAbs(this.root, rel))) === 'file') modified.push(rel);
      else created.push(rel);
    }
    return { modified: modified.sort(), created: created.sort(), deleted: deleted.sort(), fingerprint: this.staged.getStagedFingerprint() };
  }

  /** Absolute path helper for adapters. */
  absolute(p: string): string {
    return path.join(this.root, ...this.rel(p).split('/'));
  }
}
