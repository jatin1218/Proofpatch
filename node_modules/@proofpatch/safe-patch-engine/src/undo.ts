import * as path from 'node:path';
import type { FileSystem } from './fs';
import type { UndoRecord } from './types';

/** Durable undo journal: one JSON file per applied change set, written atomically. */
export class UndoStore {
  constructor(
    private readonly fs: FileSystem,
    private readonly dir: string,
    private readonly maxRecords: number
  ) {}

  private file(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  async save(record: UndoRecord): Promise<void> {
    await this.fs.writeFileAtomic(this.file(record.id), JSON.stringify(record));
  }

  async load(id: string): Promise<UndoRecord | null> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    try {
      if ((await this.fs.kind(this.file(id))) !== 'file') return null;
      return JSON.parse(await this.fs.readFile(this.file(id))) as UndoRecord;
    } catch {
      return null;
    }
  }

  /** Newest first. */
  async list(): Promise<UndoRecord[]> {
    let entries;
    try {
      entries = await this.fs.readdir(this.dir);
    } catch {
      return [];
    }
    const out: UndoRecord[] = [];
    for (const e of entries) {
      if (!e.isFile || !e.name.endsWith('.json')) continue;
      const rec = await this.load(e.name.slice(0, -5));
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /** Drop the oldest records beyond the cap. Records that still need attention are kept. */
  async prune(): Promise<void> {
    const all = await this.list();
    const removable = all.filter((r) => r.status !== 'applying' && r.status !== 'needs-attention');
    for (const rec of removable.slice(this.maxRecords)) await this.fs.remove(this.file(rec.id));
  }
}
