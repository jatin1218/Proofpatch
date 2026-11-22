/** Shared data shapes for the Safe Patch Engine. All "View"/"Result" types are JSON-serialisable (safe for IPC). */

export type FileKind = 'modify' | 'create' | 'delete';
export type HunkState = 'proposed' | 'accepted' | 'rejected' | 'applied';
export type HunkDecision = 'proposed' | 'accepted' | 'rejected';

/** Internal hunk. Line arrays keep their line terminators so reconstruction is byte-exact. */
export interface Hunk {
  id: string;
  index: number;
  state: HunkState;
  /** 0-based [oldStart, oldEnd) range in the base file's lines that this hunk replaces. */
  oldStart: number;
  oldEnd: number;
  /** 0-based [newStart, newEnd) range in the proposed file's lines. */
  newStart: number;
  newEnd: number;
  oldLines: string[];
  newLines: string[];
  contextBefore: string[];
  contextAfter: string[];
  /** Placeholder hunk for creating/deleting an empty file. */
  synthetic?: boolean;
}

export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  /** Line text without its terminator. */
  text: string;
  oldLine?: number;
  newLine?: number;
  noNewlineAtEof?: boolean;
}

export interface HunkView {
  id: string;
  index: number;
  state: HunkState;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  added: number;
  removed: number;
  lines: DiffLine[];
}

export interface FileSummary {
  path: string;
  kind: FileKind;
  baseHash: string | null;
  turnId?: string;
  status: 'proposed' | 'partial' | 'accepted' | 'rejected';
  added: number;
  removed: number;
  hunks: HunkView[];
}

export interface ChangeSetSummary {
  id: string;
  description?: string;
  createdAt: string;
  /** Fingerprint of the currently staged (accepted) content. */
  fingerprint: string;
  counts: { files: number; hunks: number; accepted: number; rejected: number; pending: number };
  files: FileSummary[];
}

export type ProposeResult =
  | {
      ok: true;
      path: string;
      kind: FileKind;
      /** True when the proposal equals the current file, so nothing was staged for review. */
      noChange?: boolean;
      changeSetId: string | null;
      hunkCount: number;
      added: number;
      removed: number;
      hunkIds: string[];
    }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

export interface ConflictInfo {
  path: string;
  reason: 'modified-externally' | 'deleted-externally' | 'created-externally';
  expectedHash: string | null;
  actualHash: string | null;
  /** Unified diff of base (what the proposal was made against) -> what is on disk now. */
  diskDiff?: string;
}

export type ApplyResult =
  | {
      ok: true;
      undoId: string;
      files: { path: string; op: 'write' | 'create' | 'delete' }[];
      fingerprint: string;
    }
  | {
      ok: false;
      code: 'NO_CHANGESET' | 'NOTHING_STAGED' | 'PENDING_HUNKS' | 'CONFLICT' | 'WRITE_FAILED' | 'ROLLBACK_FAILED';
      message: string;
      conflicts?: ConflictInfo[];
      pending?: number;
      rolledBack?: boolean;
    };

export type UndoStatus = 'applying' | 'applied' | 'undone' | 'rolled-back' | 'needs-attention';

export interface UndoFileRecord {
  path: string;
  op: 'write' | 'create' | 'delete';
  beforeHash: string | null;
  /** Full prior content; null when the file did not exist before (create). */
  beforeContent: string | null;
  afterHash: string | null;
}

export interface UndoRecord {
  id: string;
  createdAt: string;
  changeSetId: string;
  description?: string;
  fingerprint: string;
  status: UndoStatus;
  files: UndoFileRecord[];
  note?: string;
}

export type UndoResult =
  | { ok: true; undoId: string; restored: string[] }
  | {
      ok: false;
      code: 'NOTHING_TO_UNDO' | 'NOT_UNDOABLE' | 'UNDO_CONFLICT' | 'RESTORE_FAILED';
      message: string;
      conflicts?: { path: string; expectedHash: string | null; actualHash: string | null }[];
    };

export interface RecoveryReport {
  inspected: number;
  rolledBack: string[];
  needsAttention: { undoId: string; path: string; reason: string }[];
}

export interface StagedEntry {
  kind: 'write' | 'delete';
  /** Staged content; null for delete. */
  content: string | null;
}
export type StagedMap = Map<string, StagedEntry>;

export interface EngineOptions {
  workspaceRoot: string;
  /** Filesystem backend. Defaults to the real disk. */
  fs?: import('./fs').FileSystem;
  /** Where undo journals live. Default: <root>/.proofpatch/undo. Prefer extension global storage. */
  undoDir?: string;
  contextLines?: number;
  /** Changes separated by <= mergeGap unchanged lines share one hunk. Default 2*contextLines. 0 = finest. */
  mergeGap?: number;
  maxFileBytes?: number;
  maxUndoRecords?: number;
  /** Directory names skipped by listing/search. */
  ignoreDirs?: string[];
  /** Allow proposals to likely-secret files such as .env. Default false. */
  allowSecretPaths?: boolean;
}

export const ENGINE_EVENTS = [
  'proposal-updated',
  'hunk-decision',
  'staged-changed',
  'applied',
  'undone',
  'conflict',
  'cancelled',
  'discarded',
  'recovered'
] as const;
export type EngineEventName = (typeof ENGINE_EVENTS)[number];
