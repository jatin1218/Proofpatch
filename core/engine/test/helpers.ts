import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PatchEngine } from '../src';
import type { EngineOptions } from '../src';

export async function makeWorkspace(files: Record<string, string>) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pp-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
  return {
    root,
    read: (rel: string) => fsp.readFile(path.join(root, rel), 'utf8'),
    exists: async (rel: string) => fsp.access(path.join(root, rel)).then(() => true, () => false),
    write: (rel: string, c: string) => fsp.writeFile(path.join(root, rel), c),
    cleanup: () => fsp.rm(root, { recursive: true, force: true })
  };
}

export function makeEngine(root: string, extra: Partial<EngineOptions> = {}) {
  // Keep the undo journal outside the workspace so "workspace is unchanged" assertions are exact.
  return new PatchEngine({ workspaceRoot: root, undoDir: path.join(root + '-undo'), ...extra });
}

/** Snapshot of every file in a directory (path -> content) for exact before/after comparisons. */
export async function dirSnapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else out[path.relative(root, abs).split(path.sep).join('/')] = await fsp.readFile(abs, 'utf8');
    }
  }
  await walk(root);
  return out;
}

export const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join('');
