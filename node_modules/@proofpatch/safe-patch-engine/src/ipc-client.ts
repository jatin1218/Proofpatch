import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import type {
  ApplyResult,
  ChangeSetSummary,
  ConflictInfo,
  HunkDecision,
  ProposeResult,
  RecoveryReport,
  UndoRecord,
  UndoResult
} from './types';
import type { Role, RpcEvent, RpcResponse } from './protocol';

export class RpcError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/**
 * Client for PatchEngineServer. Emits 'event' ({event, data}) and also each engine event by name
 * (e.g. client.on('staged-changed', ...)). The agent role can only read + propose.
 */
export class PatchEngineClient extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buf = '';
  role: Role | null = null;

  private constructor(private readonly socket: net.Socket) {
    super();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('close', () => this.failAll(new RpcError('DISCONNECTED', 'Connection closed')));
    socket.on('error', (e) => this.failAll(new RpcError('DISCONNECTED', e.message)));
  }

  static async connect(socketPath: string, token: string, timeoutMs = 10000): Promise<PatchEngineClient> {
    const socket = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new RpcError('TIMEOUT', 'connect timed out')), timeoutMs);
      socket.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
      socket.once('error', (e) => {
        clearTimeout(t);
        reject(new RpcError('CONNECT_FAILED', e.message));
      });
    });
    const client = new PatchEngineClient(socket);
    try {
      client.role = (await client.call<{ role: Role }>('hello', { token })).role;
    } catch (e) {
      socket.destroy();
      throw e;
    }
    return client;
  }

  close(): void {
    this.socket.destroy();
  }

  private failAll(err: Error) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as RpcResponse | RpcEvent;
      if ('event' in msg) {
        this.emit('event', msg);
        this.emit(msg.event, msg.data);
      } else {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new RpcError(msg.error.code, msg.error.message));
      }
    }
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError('TIMEOUT', `${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  // ---- agent-safe helpers (read + propose)
  readFile = (path: string) => this.call<string>('view.readFile', { path });
  readLines = (path: string, startLine: number, endLine: number) =>
    this.call<{ path: string; startLine: number; endLine: number; totalLines: number; text: string }>('view.readLines', { path, startLine, endLine });
  exists = (path: string) => this.call<boolean>('view.exists', { path });
  listFiles = (opts: { dir?: string; maxEntries?: number } = {}) => this.call<{ files: string[]; truncated: boolean }>('view.listFiles', opts);
  search = (query: string, opts: { regex?: boolean; caseSensitive?: boolean; maxResults?: number; globs?: string[]; dir?: string } = {}) =>
    this.call<{ matches: { path: string; line: number; column: number; text: string }[]; truncated: boolean; filesScanned: number }>('view.search', { query, ...opts });
  overlayState = () => this.call<{ modified: string[]; created: string[]; deleted: string[]; fingerprint: string }>('view.overlayState');
  proposeFile = (p: { path: string; newContent: string; turnId?: string; description?: string }) => this.call<ProposeResult>('patch.proposeFile', p);
  proposeEdits = (p: { path: string; edits: { oldText: string; newText: string; replaceAll?: boolean }[]; turnId?: string; description?: string }) =>
    this.call<ProposeResult>('patch.proposeEdits', p);
  proposeDelete = (p: { path: string; turnId?: string; description?: string }) => this.call<ProposeResult>('patch.proposeDelete', p);
  getChangeSet = () => this.call<ChangeSetSummary | null>('changeSet.get');
  fingerprint = () => this.call<{ fingerprint: string; hasStagedChanges: boolean }>('snapshot.fingerprint');

  // ---- user-only helpers (rejected with FORBIDDEN for the agent role)
  setHunkDecision = (hunkId: string, decision: HunkDecision) => this.call<null>('hunk.setDecision', { hunkId, decision });
  setFileDecision = (path: string, decision: HunkDecision) => this.call<null>('file.setDecision', { path, decision });
  setAllDecisions = (decision: HunkDecision) => this.call<null>('all.setDecision', { decision });
  unifiedDiff = (acceptedOnly = true) => this.call<string>('changeSet.diff', { acceptedOnly });
  checkConflicts = () => this.call<ConflictInfo[]>('conflicts.check');
  apply = (opts: { ignorePending?: boolean } = {}) => this.call<ApplyResult>('apply', opts);
  undo = (opts: { undoId?: string; force?: boolean } = {}) => this.call<UndoResult>('undo', opts);
  listUndo = () => this.call<UndoRecord[]>('undo.list');
  cancelTurn = (turnId: string) => this.call<{ removedFiles: string[] }>('turn.cancel', { turnId });
  discard = () => this.call<boolean>('discard');
  materializeSnapshot = (opts: { dest?: string; copyWorkspace?: boolean; exclude?: string[] } = {}) =>
    this.call<{ dir: string; fingerprint: string; stagedFiles: string[] }>('snapshot.materialize', opts, 300000);
  disposeSnapshot = (dir: string) => this.call<boolean>('snapshot.dispose', { dir });
  recover = () => this.call<RecoveryReport>('recover');
}
