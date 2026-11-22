import { EventEmitter } from 'node:events';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  applyHunks,
  computeHunks,
  detectEol,
  formatUnified,
  normalizeEol,
  renderHunk,
  splitLines,
  unifiedDiffText
} from './diff';
import { NodeFileSystem, type FileSystem } from './fs';
import { EMPTY_FINGERPRINT, sha256 } from './hash';
import { DEFAULT_IGNORE_DIRS, WorkspaceView } from './overlay';
import { EngineError, isProtectedPath, isSecretPath, normalizeRel, toAbs } from './paths';
import { UndoStore } from './undo';
import type {
  ApplyResult,
  ChangeSetSummary,
  ConflictInfo,
  EngineOptions,
  FileKind,
  FileSummary,
  Hunk,
  HunkDecision,
  ProposeResult,
  RecoveryReport,
  StagedMap,
  UndoFileRecord,
  UndoRecord,
  UndoResult
} from './types';

interface FileEntry {
  path: string;
  kind: FileKind;
  baseContent: string;
  baseHash: string | null;
  baseLines: string[];
  proposedContent: string;
  hunks: Hunk[];
  turnId?: string;
}

interface ChangeSet {
  id: string;
  description?: string;
  createdAt: string;
  files: Map<string, FileEntry>;
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => undefined);
    return p;
  }
}

class ApplyConflict extends Error {
  constructor(public readonly conflicts: ConflictInfo[]) {
    super('conflict');
  }
}

const hashOrNull = (c: string | null) => (c === null ? null : sha256(c));

/**
 * PatchEngine - owns the whole patch lifecycle:
 *   PROPOSED -> (per-hunk) ACCEPTED/REJECTED -> STAGED in overlay -> APPLIED (explicit) -> UNDONE
 *
 * Invariants:
 *  1. The real workspace is only ever written by apply(), undo() and recover(). Never by proposing,
 *     reviewing, cancelling or discarding.
 *  2. apply() refuses when files changed on disk since the proposal (conflict) and writes nothing.
 *  3. apply() is all-or-nothing: a failed write rolls back every file already written.
 *  4. Every apply is journaled to disk BEFORE the first write, so a crash can be recovered.
 *
 * Events (EventEmitter): proposal-updated, hunk-decision, staged-changed, applied, undone, conflict,
 * cancelled, discarded, recovered.
 */
export class PatchEngine extends EventEmitter implements StagedProviderLike {
  readonly root: string;
  readonly fs: FileSystem;
  readonly view: WorkspaceView;

  private readonly undoStore: UndoStore;
  private readonly contextLines: number;
  private readonly mergeGap: number;
  private readonly maxFileBytes: number;
  private readonly allowSecretPaths: boolean;
  private readonly ignoreDirs: Set<string>;

  private current: ChangeSet | null = null;
  private version = 0;
  private stagedCache: { version: number; map: StagedMap; fingerprint: string } | null = null;
  private lastFingerprint = EMPTY_FINGERPRINT;
  private readonly cancelledTurns = new Set<string>();
  private readonly lock = new Mutex();
  private rootRealCache: string | null = null;

  constructor(opts: EngineOptions) {
    super();
    this.root = path.resolve(opts.workspaceRoot);
    this.fs = opts.fs ?? new NodeFileSystem();
    this.contextLines = opts.contextLines ?? 3;
    this.mergeGap = opts.mergeGap ?? this.contextLines * 2;
    this.maxFileBytes = opts.maxFileBytes ?? 1_000_000;
    this.allowSecretPaths = opts.allowSecretPaths ?? false;
    this.ignoreDirs = new Set(opts.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
    this.undoStore = new UndoStore(
      this.fs,
      opts.undoDir ? path.resolve(opts.undoDir) : path.join(this.root, '.proofpatch', 'undo'),
      opts.maxUndoRecords ?? 50
    );
    this.view = new WorkspaceView(this.root, this.fs, this, this.ignoreDirs);
  }

  // ------------------------------------------------------------------ staged state (read side)

  /** Staged (accepted-hunk) content per path. Synchronous, cached per state version. */
  peekStaged(): StagedMap {
    return this.stagedState().map;
  }

  /** SHA-256 over (path, kind, base hash, staged content hash) of every staged file. */
  getStagedFingerprint(): string {
    return this.stagedState().fingerprint;
  }

  hasStagedChanges(): boolean {
    return this.stagedState().map.size > 0;
  }

  private stagedState() {
    if (this.stagedCache?.version === this.version) return this.stagedCache;
    const map: StagedMap = new Map();
    const entries: { p: string; k: string; b: string | null; h: string | null }[] = [];
    for (const [rel, e] of [...(this.current?.files ?? [])].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const accepted = e.hunks.filter((h) => h.state === 'accepted');
      if (accepted.length === 0) continue;
      if (e.kind === 'delete') {
        map.set(rel, { kind: 'delete', content: null });
        entries.push({ p: rel, k: 'delete', b: e.baseHash, h: null });
      } else {
        const content = applyHunks(e.baseLines, accepted);
        if (e.kind === 'modify' && content === e.baseContent) continue;
        map.set(rel, { kind: 'write', content });
        entries.push({ p: rel, k: e.kind, b: e.baseHash, h: sha256(content) });
      }
    }
    const fingerprint = entries.length === 0 ? EMPTY_FINGERPRINT : sha256(JSON.stringify(entries));
    this.stagedCache = { version: this.version, map, fingerprint };
    return this.stagedCache;
  }

  private mutated(event?: string, data?: unknown) {
    this.version++;
    if (event) this.emit(event, data);
    const fp = this.getStagedFingerprint();
    if (fp !== this.lastFingerprint) {
      const previous = this.lastFingerprint;
      this.lastFingerprint = fp;
      this.emit('staged-changed', { fingerprint: fp, previous, stagedFiles: [...this.peekStaged().keys()] });
    }
  }

  // ------------------------------------------------------------------ proposing

  /** Propose complete new content for a file (creates the file if it does not exist). */
  proposeFile(input: { path: string; newContent: string; turnId?: string; description?: string }): Promise<ProposeResult> {
    return this.guarded(() => this.doPropose(input.path, 'content', input.newContent, input.turnId, input.description));
  }

  /**
   * Propose search/replace edits. Edits accumulate on top of any pending proposal for the same file.
   * Each oldText must match exactly once unless replaceAll is set (ambiguity is reported, never guessed).
   */
  proposeEdits(input: {
    path: string;
    edits: { oldText: string; newText: string; replaceAll?: boolean }[];
    turnId?: string;
    description?: string;
  }): Promise<ProposeResult> {
    return this.guarded(async () => {
      const rel = this.checkPath(input.path);
      const existing = this.current?.files.get(rel);
      if (existing?.kind === 'delete') throw new EngineError('NOT_FOUND', `${rel} is proposed for deletion`);
      let text: string;
      if (existing) text = existing.proposedContent;
      else {
        const b = await this.readBase(rel);
        if (!b.exists) throw new EngineError('NOT_FOUND', `${rel} does not exist; use proposeFile to create it`);
        text = b.content;
      }
      const style = detectEol(text);
      if (!Array.isArray(input.edits) || input.edits.length === 0) throw new EngineError('BAD_EDITS', 'No edits given');
      input.edits.forEach((edit, editIndex) => {
        if (typeof edit.oldText !== 'string' || edit.oldText.length === 0) throw new EngineError('BAD_EDITS', `edit ${editIndex}: oldText must be non-empty`, { editIndex });
        const oldT = normalizeEol(edit.oldText, style);
        const newT = normalizeEol(edit.newText ?? '', style);
        const count = text.split(oldT).length - 1;
        if (count === 0) throw new EngineError('EDIT_NOT_FOUND', `edit ${editIndex}: oldText not found in ${rel}`, { editIndex });
        if (count > 1 && !edit.replaceAll) throw new EngineError('EDIT_AMBIGUOUS', `edit ${editIndex}: oldText matches ${count} places in ${rel}; add context or set replaceAll`, { editIndex, matches: count });
        text = text.split(oldT).join(newT);
      });
      return this.doPropose(rel, 'content', text, input.turnId, input.description);
    });
  }

  proposeDelete(input: { path: string; turnId?: string; description?: string }): Promise<ProposeResult> {
    return this.guarded(() => this.doPropose(input.path, 'delete', '', input.turnId, input.description));
  }

  /** Run under the lock; turn EngineErrors into {ok:false} results so callers (MCP tools) get clean errors. */
  private guarded(fn: () => Promise<ProposeResult>): Promise<ProposeResult> {
    return this.lock.run(async () => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof EngineError) return { ok: false as const, code: e.code, message: e.message, details: e.details };
        throw e;
      }
    });
  }

  private checkPath(input: string): string {
    const rel = normalizeRel(this.root, input);
    if (isProtectedPath(rel)) throw new EngineError('PATH_PROTECTED', `${rel} is protected and cannot be modified`);
    if (!this.allowSecretPaths && isSecretPath(rel)) throw new EngineError('PATH_SECRET', `${rel} looks like a secrets file and cannot be modified by proposals`);
    return rel;
  }

  private checkText(content: string, label: string) {
    if (content.includes('\0')) throw new EngineError('BINARY_FILE', `${label} appears to be binary; only text files are supported`);
    if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes) throw new EngineError('FILE_TOO_LARGE', `${label} exceeds ${this.maxFileBytes} bytes`);
  }

  private async rootReal(): Promise<string> {
    if (!this.rootRealCache) this.rootRealCache = this.fs.realpath ? await this.fs.realpath(this.root) : this.root;
    return this.rootRealCache;
  }

  /** Reject paths that escape the workspace through symlinked directories. */
  private async assertInsideRoot(abs: string) {
    if (!this.fs.realpath) return;
    const rootReal = await this.rootReal();
    let probe = abs;
    for (;;) {
      if ((await this.fs.kind(probe)) !== 'none') break;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const real = await this.fs.realpath(probe);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      throw new EngineError('PATH_OUTSIDE_WORKSPACE', 'Path resolves outside the workspace (symlink)');
    }
  }

  private async readBase(rel: string): Promise<{ exists: boolean; content: string }> {
    const abs = toAbs(this.root, rel);
    await this.assertInsideRoot(abs);
    const kind = await this.fs.kind(abs);
    if (kind === 'none') return { exists: false, content: '' };
    if (kind !== 'file') throw new EngineError('NOT_A_FILE', `${rel} is a ${kind}; refusing to modify it`);
    const content = await this.fs.readFile(abs);
    this.checkText(content, rel);
    return { exists: true, content };
  }

  private async doPropose(
    inputPath: string,
    mode: 'content' | 'delete',
    newContent: string,
    turnId: string | undefined,
    description: string | undefined
  ): Promise<ProposeResult> {
    if (turnId && this.cancelledTurns.has(turnId)) {
      return { ok: false, code: 'TURN_CANCELLED', message: `Turn ${turnId} was cancelled; late proposal ignored` };
    }
    const rel = this.checkPath(inputPath);
    const existing = this.current?.files.get(rel);
    let base: { exists: boolean; content: string; hash: string | null };
    if (existing) base = { exists: existing.kind !== 'create', content: existing.baseContent, hash: existing.baseHash };
    else {
      const b = await this.readBase(rel);
      base = { ...b, hash: b.exists ? sha256(b.content) : null };
    }
    if (mode === 'delete' && !base.exists) throw new EngineError('NOT_FOUND', `${rel} does not exist`);
    if (typeof newContent !== 'string') throw new EngineError('BAD_CONTENT', 'newContent must be a string');

    const proposed = mode === 'delete' ? '' : normalizeEol(newContent, detectEol(base.content));
    this.checkText(proposed, rel);

    if (mode === 'content' && base.exists && proposed === base.content) {
      // The proposal equals the file on disk: nothing to review. Drop any earlier proposal for it.
      if (existing && this.current) {
        this.current.files.delete(rel);
        if (this.current.files.size === 0) this.current = null;
        this.mutated('proposal-updated', { path: rel, removed: true });
      }
      return { ok: true, path: rel, kind: 'modify', noChange: true, changeSetId: this.current?.id ?? null, hunkCount: 0, added: 0, removed: 0, hunkIds: [] };
    }

    const kind: FileKind = mode === 'delete' ? 'delete' : base.exists ? 'modify' : 'create';
    const baseLines = splitLines(base.content);
    const hunks = computeHunks(rel, baseLines, splitLines(proposed), { contextLines: this.contextLines, mergeGap: this.mergeGap });
    if (hunks.length === 0 && kind !== 'modify') {
      hunks.push({ id: sha256(`${rel}\0synthetic\0${kind}`).slice(0, 12), index: 0, state: 'proposed', oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 0, oldLines: [], newLines: [], contextBefore: [], contextAfter: [], synthetic: true });
    }
    // Keep earlier decisions for hunks that are unchanged by this re-proposal.
    if (existing) {
      const prior = new Map(existing.hunks.map((h) => [h.id, h.state] as const));
      for (const h of hunks) {
        const s = prior.get(h.id);
        if (s === 'accepted' || s === 'rejected') h.state = s;
      }
    }

    if (!this.current) this.current = { id: randomUUID(), createdAt: new Date().toISOString(), files: new Map() };
    if (description) this.current.description = description;
    this.current.files.set(rel, { path: rel, kind, baseContent: base.content, baseHash: base.hash, baseLines, proposedContent: proposed, hunks, turnId });
    this.mutated('proposal-updated', { path: rel });

    return {
      ok: true,
      path: rel,
      kind,
      changeSetId: this.current.id,
      hunkCount: hunks.length,
      added: hunks.reduce((n, h) => n + h.newLines.length, 0),
      removed: hunks.reduce((n, h) => n + h.oldLines.length, 0),
      hunkIds: hunks.map((h) => h.id)
    };
  }

  // ------------------------------------------------------------------ review

  getPreview(filePath: string) {
    const entry = this.requireChangeSet().files.get(filePath);
    if (!entry) throw new EngineError("NOT_FOUND", "Proposal no longer exists");
    return { original: entry.baseContent, proposed: entry.proposedContent };
  }

  getChangeSet(): ChangeSetSummary | null {
    const cs = this.current;
    if (!cs) return null;
    const files: FileSummary[] = [...cs.files.values()]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((e) => {
        const pending = e.hunks.filter((h) => h.state === 'proposed').length;
        const accepted = e.hunks.filter((h) => h.state === 'accepted').length;
        const rejected = e.hunks.filter((h) => h.state === 'rejected').length;
        const status = pending > 0 ? (accepted + rejected > 0 ? 'partial' : 'proposed') : accepted === e.hunks.length ? 'accepted' : rejected === e.hunks.length ? 'rejected' : 'partial';
        return {
          path: e.path,
          kind: e.kind,
          baseHash: e.baseHash,
          turnId: e.turnId,
          status,
          added: e.hunks.reduce((n, h) => n + h.newLines.length, 0),
          removed: e.hunks.reduce((n, h) => n + h.oldLines.length, 0),
          hunks: e.hunks.map(renderHunk)
        };
      });
    const all = [...cs.files.values()].flatMap((e) => e.hunks);
    return {
      id: cs.id,
      description: cs.description,
      createdAt: cs.createdAt,
      fingerprint: this.getStagedFingerprint(),
      counts: {
        files: cs.files.size,
        hunks: all.length,
        accepted: all.filter((h) => h.state === 'accepted').length,
        rejected: all.filter((h) => h.state === 'rejected').length,
        pending: all.filter((h) => h.state === 'proposed').length
      },
      files
    };
  }

  /** Unified diff text (git-apply compatible). By default only the accepted hunks. */
  toUnifiedDiff(opts: { acceptedOnly?: boolean } = {}): string {
    const acceptedOnly = opts.acceptedOnly ?? true;
    let out = '';
    for (const e of [...(this.current?.files.values() ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      out += formatUnified(e.path, e.hunks.filter((h) => !acceptedOnly || h.state === 'accepted'), e.kind);
    }
    return out;
  }

  setHunkDecision(hunkId: string, decision: HunkDecision): Promise<void> {
    return this.lock.run(async () => {
      for (const e of this.requireChangeSet().files.values()) {
        const h = e.hunks.find((x) => x.id === hunkId);
        if (h) {
          h.state = decision;
          this.mutated('hunk-decision', { hunkId, path: e.path, decision });
          return;
        }
      }
      throw new EngineError('HUNK_NOT_FOUND', `No such hunk: ${hunkId}`);
    });
  }

  setFileDecision(filePath: string, decision: HunkDecision): Promise<void> {
    return this.lock.run(async () => {
      const rel = normalizeRel(this.root, filePath);
      const e = this.requireChangeSet().files.get(rel);
      if (!e) throw new EngineError('FILE_NOT_IN_CHANGESET', `${rel} is not part of the change set`);
      e.hunks.forEach((h) => (h.state = decision));
      this.mutated('hunk-decision', { path: rel, decision });
    });
  }

  setAllDecisions(decision: HunkDecision): Promise<void> {
    return this.lock.run(async () => {
      for (const e of this.requireChangeSet().files.values()) e.hunks.forEach((h) => (h.state = decision));
      this.mutated('hunk-decision', { decision });
    });
  }

  private requireChangeSet(): ChangeSet {
    if (!this.current) throw new EngineError('NO_CHANGESET', 'There is no open change set');
    return this.current;
  }

  // ------------------------------------------------------------------ cancel / discard

  /**
   * Cancel an agent turn: drops every file last proposed during that turn and ignores any later
   * proposal carrying the same turnId. Nothing was written to disk, so the workspace is untouched.
   */
  cancelTurn(turnId: string): Promise<{ removedFiles: string[] }> {
    return this.lock.run(async () => {
      this.cancelledTurns.add(turnId);
      if (this.cancelledTurns.size > 1000) this.cancelledTurns.delete(this.cancelledTurns.values().next().value as string);
      const removed: string[] = [];
      if (this.current) {
        for (const [rel, e] of [...this.current.files]) {
          if (e.turnId === turnId) {
            this.current.files.delete(rel);
            removed.push(rel);
          }
        }
        if (this.current.files.size === 0) this.current = null;
      }
      this.mutated('cancelled', { turnId, removedFiles: removed });
      return { removedFiles: removed };
    });
  }

  /** Throw away the whole open change set (the user rejected everything). */
  discard(): Promise<boolean> {
    return this.lock.run(async () => {
      const had = this.current !== null;
      this.current = null;
      this.mutated('discarded', { had });
      return had;
    });
  }

  // ------------------------------------------------------------------ conflict detection

  private async diskState(rel: string): Promise<{ kind: string; hash: string | null; content: string | null }> {
    const abs = toAbs(this.root, rel);
    const kind = await this.fs.kind(abs);
    if (kind === 'none') return { kind, hash: null, content: null };
    if (kind !== 'file') return { kind, hash: `non-file:${kind}`, content: null };
    const content = await this.fs.readFile(abs);
    return { kind, hash: sha256(content), content };
  }

  private async conflictFor(e: FileEntry): Promise<ConflictInfo | null> {
    const d = await this.diskState(e.path);
    if (e.kind === 'create') {
      if (d.kind === 'none') return null;
      return { path: e.path, reason: 'created-externally', expectedHash: null, actualHash: d.hash, diskDiff: d.content !== null ? unifiedDiffText(e.path, '', d.content) : undefined };
    }
    if (d.kind === 'none') return { path: e.path, reason: 'deleted-externally', expectedHash: e.baseHash, actualHash: null };
    if (d.hash === e.baseHash) return null;
    return { path: e.path, reason: 'modified-externally', expectedHash: e.baseHash, actualHash: d.hash, diskDiff: d.content !== null ? unifiedDiffText(e.path, e.baseContent, d.content) : undefined };
  }

  /** Non-destructive check: would apply() hit a conflict right now? */
  checkConflicts(): Promise<ConflictInfo[]> {
    return this.lock.run(async () => {
      const cs = this.current;
      if (!cs) return [];
      const out: ConflictInfo[] = [];
      for (const rel of this.peekStaged().keys()) {
        const c = await this.conflictFor(cs.files.get(rel)!);
        if (c) out.push(c);
      }
      return out;
    });
  }

  // ------------------------------------------------------------------ apply

  /**
   * Write the accepted hunks to disk. Requires every hunk to be decided (accepted/rejected) unless
   * ignorePending is set. Never call this from the agent side: it is the user's explicit action.
   */
  apply(opts: { ignorePending?: boolean } = {}): Promise<ApplyResult> {
    return this.lock.run(() => this.doApply(opts));
  }

  private async doApply(opts: { ignorePending?: boolean }): Promise<ApplyResult> {
    const cs = this.current;
    if (!cs) return { ok: false, code: 'NO_CHANGESET', message: 'There is no open change set' };
    const pending = [...cs.files.values()].flatMap((e) => e.hunks).filter((h) => h.state === 'proposed').length;
    if (pending > 0 && !opts.ignorePending) {
      return { ok: false, code: 'PENDING_HUNKS', message: `${pending} hunk(s) have not been accepted or rejected`, pending };
    }
    const staged = this.peekStaged();
    if (staged.size === 0) return { ok: false, code: 'NOTHING_STAGED', message: 'No hunks are accepted; nothing to apply' };

    const plan = [...staged].map(([rel, s]) => {
      const e = cs.files.get(rel)!;
      return { e, rel, abs: toAbs(this.root, rel), staged: s, op: (e.kind === 'create' ? 'create' : s.kind === 'delete' ? 'delete' : 'write') as 'write' | 'create' | 'delete' };
    });

    const conflicts: ConflictInfo[] = [];
    for (const p of plan) {
      const c = await this.conflictFor(p.e);
      if (c) conflicts.push(c);
    }
    if (conflicts.length) {
      this.emit('conflict', { conflicts });
      return { ok: false, code: 'CONFLICT', message: `${conflicts.length} file(s) changed on disk since the proposal; nothing was written`, conflicts };
    }

    const record: UndoRecord = {
      id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      changeSetId: cs.id,
      description: cs.description,
      fingerprint: this.getStagedFingerprint(),
      status: 'applying',
      files: plan.map((p) => ({
        path: p.rel,
        op: p.op,
        beforeHash: p.e.baseHash,
        beforeContent: p.op === 'create' ? null : p.e.baseContent,
        afterHash: hashOrNull(p.staged.content)
      }))
    };
    // Journal first: if we crash mid-write, recover() can roll back.
    await this.undoStore.save(record);

    const touched: UndoFileRecord[] = [];
    try {
      for (const p of plan) {
        const again = await this.conflictFor(p.e); // just-in-time re-check right before writing
        if (again) throw new ApplyConflict([again]);
        const rec = record.files.find((f) => f.path === p.rel)!;
        touched.push(rec);
        if (p.staged.kind === 'delete') await this.fs.remove(p.abs);
        else {
          await this.assertInsideRoot(p.abs);
          await this.fs.writeFileAtomic(p.abs, p.staged.content ?? '');
        }
      }
      for (const p of plan) {
        const d = await this.diskState(p.rel);
        if (d.hash !== hashOrNull(p.staged.content)) throw new Error(`post-write verification failed for ${p.rel}`);
      }
    } catch (err) {
      const failures = await this.restoreFiles(touched.reverse());
      record.status = failures.length ? 'needs-attention' : 'rolled-back';
      record.note = failures.length ? `rollback incomplete: ${failures.join('; ')}` : String((err as Error).message);
      await this.undoStore.save(record);
      if (err instanceof ApplyConflict) {
        this.emit('conflict', { conflicts: err.conflicts });
        return { ok: false, code: 'CONFLICT', message: 'A file changed on disk during apply; all changes were rolled back', conflicts: err.conflicts, rolledBack: failures.length === 0 };
      }
      return failures.length
        ? { ok: false, code: 'ROLLBACK_FAILED', message: `Apply failed (${(err as Error).message}) and rollback was incomplete: ${failures.join('; ')}`, rolledBack: false }
        : { ok: false, code: 'WRITE_FAILED', message: `Apply failed and was rolled back: ${(err as Error).message}`, rolledBack: true };
    }

    record.status = 'applied';
    await this.undoStore.save(record);
    await this.undoStore.prune();
    const files = plan.map((p) => ({ path: p.rel, op: p.op }));
    const fingerprint = record.fingerprint;
    for (const e of cs.files.values()) e.hunks.forEach((h) => h.state === 'accepted' && (h.state = 'applied'));
    this.current = null;
    this.mutated('applied', { undoId: record.id, files, fingerprint });
    return { ok: true, undoId: record.id, files, fingerprint };
  }

  /** Restore pre-apply content. Returns descriptions of failures (empty = fully restored). */
  private async restoreFiles(files: UndoFileRecord[]): Promise<string[]> {
    const failures: string[] = [];
    for (const f of files) {
      try {
        const abs = toAbs(this.root, f.path);
        // Already in its pre-apply state (e.g. the write itself failed before landing): nothing to restore.
        if ((await this.diskState(f.path)).hash === f.beforeHash) continue;
        if (f.beforeContent === null) await this.fs.remove(abs);
        else await this.fs.writeFileAtomic(abs, f.beforeContent);
      } catch (e) {
        failures.push(`${f.path}: ${(e as Error).message}`);
      }
    }
    return failures;
  }

  // ------------------------------------------------------------------ undo & recovery

  listUndo(): Promise<UndoRecord[]> {
    return this.undoStore.list();
  }

  /** Undo the most recent applied change set (or a specific one). Refuses if files changed since, unless force. */
  undo(opts: { undoId?: string; force?: boolean } = {}): Promise<UndoResult> {
    return this.lock.run(async () => {
      const rec = opts.undoId ? await this.undoStore.load(opts.undoId) : (await this.undoStore.list()).find((r) => r.status === 'applied') ?? null;
      if (!rec) return { ok: false, code: 'NOTHING_TO_UNDO', message: 'No applied change set to undo' };
      if (rec.status !== 'applied') return { ok: false, code: 'NOT_UNDOABLE', message: `Change set ${rec.id} has status ${rec.status}` };

      if (!opts.force) {
        const conflicts: { path: string; expectedHash: string | null; actualHash: string | null }[] = [];
        for (const f of rec.files) {
          const d = await this.diskState(f.path);
          if (d.hash !== f.afterHash) conflicts.push({ path: f.path, expectedHash: f.afterHash, actualHash: d.hash });
        }
        if (conflicts.length) {
          return { ok: false, code: 'UNDO_CONFLICT', message: `${conflicts.length} file(s) changed after the apply; undo would overwrite newer edits`, conflicts };
        }
      }
      const failures = await this.restoreFiles([...rec.files].reverse());
      if (failures.length) {
        rec.status = 'needs-attention';
        rec.note = failures.join('; ');
        await this.undoStore.save(rec);
        return { ok: false, code: 'RESTORE_FAILED', message: failures.join('; ') };
      }
      rec.status = 'undone';
      await this.undoStore.save(rec);
      const restored = rec.files.map((f) => f.path);
      this.mutated('undone', { undoId: rec.id, restored });
      return { ok: true, undoId: rec.id, restored };
    });
  }

  /**
   * Call once at startup. Finds applies that were interrupted (crash, kill) and rolls back any file
   * that holds the half-applied content. Files that match neither before nor after are reported, not touched.
   */
  recover(): Promise<RecoveryReport> {
    return this.lock.run(async () => {
      const report: RecoveryReport = { inspected: 0, rolledBack: [], needsAttention: [] };
      for (const rec of await this.undoStore.list()) {
        if (rec.status !== 'applying') continue;
        report.inspected++;
        let attention = false;
        for (const f of rec.files) {
          const d = await this.diskState(f.path);
          if (d.hash === f.beforeHash) continue; // untouched
          if (d.hash === f.afterHash) {
            const fail = await this.restoreFiles([f]);
            if (fail.length) {
              attention = true;
              report.needsAttention.push({ undoId: rec.id, path: f.path, reason: fail[0] });
            } else report.rolledBack.push(f.path);
          } else {
            attention = true;
            report.needsAttention.push({ undoId: rec.id, path: f.path, reason: 'content matches neither the pre-apply nor the applied version; left untouched' });
          }
        }
        rec.status = attention ? 'needs-attention' : 'rolled-back';
        await this.undoStore.save(rec);
      }
      if (report.inspected) this.emit('recovered', report);
      return report;
    });
  }

  // ------------------------------------------------------------------ validation snapshot

  /**
   * Materialise the staged view as a real directory so tests/linters run against EXACTLY the accepted
   * hunks (not the on-disk checkout). Requires a real-disk workspace. Destination must be outside the workspace.
   * Python note: point PYTHONPATH at the snapshot and assert the imported module path is inside it.
   */
  materializeSnapshot(opts: { dest?: string; copyWorkspace?: boolean; exclude?: string[] } = {}) {
    return this.lock.run(async () => {
      const dest = path.resolve(opts.dest ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'proofpatch-snap-'))));
      const rootReal = await this.rootReal();
      const destReal = path.resolve(dest);
      if (destReal === rootReal || destReal.startsWith(rootReal + path.sep) || rootReal.startsWith(destReal + path.sep)) {
        throw new EngineError('SNAPSHOT_DEST_INVALID', 'Snapshot destination must not be inside (or contain) the workspace');
      }
      await fsp.mkdir(dest, { recursive: true });
      const excluded = new Set([...(opts.exclude ?? DEFAULT_IGNORE_DIRS)]);
      if (opts.copyWorkspace ?? true) {
        await fsp.cp(this.root, dest, {
          recursive: true,
          force: true,
          dereference: false,
          verbatimSymlinks: true,
          filter: (src) => {
            const rel = path.relative(this.root, src).split(path.sep);
            return !rel.some((seg) => seg && excluded.has(seg));
          }
        });
      }
      const files: string[] = [];
      for (const [rel, s] of this.peekStaged()) {
        const target = toAbs(dest, rel);
        files.push(rel);
        if (s.kind === 'delete') await fsp.rm(target, { force: true });
        else {
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(target, s.content ?? '', 'utf8');
        }
      }
      return { dir: dest, fingerprint: this.getStagedFingerprint(), stagedFiles: files.sort() };
    });
  }

  /** Delete a snapshot directory created by materializeSnapshot (only if it looks like one). */
  async disposeSnapshot(dir: string): Promise<void> {
    if (!path.basename(dir).startsWith('proofpatch-snap-')) throw new EngineError('SNAPSHOT_DISPOSE_REFUSED', 'Refusing to delete a directory that was not created as a snapshot');
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

interface StagedProviderLike {
  peekStaged(): StagedMap;
  getStagedFingerprint(): string;
}
