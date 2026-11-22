import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PatchEngine } from './engine';
import { EngineError, isSecretPath, normalizeRel } from './paths';
import { ENGINE_EVENTS } from './types';
import { MAX_LINE_BYTES, ROLE_METHODS, type Role, type RpcRequest, type RpcResponse } from './protocol';

export function defaultSocketPath(): string {
  const id = randomBytes(6).toString('hex');
  if (process.platform === 'win32') return `\\\\.\\pipe\\proofpatch-${id}`;
  let dir = os.tmpdir();
  if (dir.length > 80) dir = '/tmp'; // unix socket paths are limited to ~104 bytes
  return path.join(dir, `pp-${id}.sock`);
}

const digest = (s: string) => createHash('sha256').update(s).digest();
const tokenEquals = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

type Params = Record<string, any>;

export interface ServerInfo {
  socketPath: string;
  agentToken: string;
  userToken: string;
}

export class PatchEngineServer {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly listeners: [string, (d: unknown) => void][] = [];
  private info: ServerInfo | null = null;
  private readonly handlers: Record<string, (p: Params) => Promise<unknown> | unknown>;

  constructor(
    private readonly engine: PatchEngine,
    private readonly opts: { socketPath?: string; agentToken?: string; userToken?: string } = {}
  ) {
    const e = engine;
    const str = (p: Params, k: string): string => {
      if (typeof p[k] !== 'string') throw new EngineError('BAD_PARAMS', `${k} must be a string`);
      return p[k];
    };
    this.handlers = {
      'view.readFile': (p) => e.view.readFile(str(p, 'path')),
      'view.readLines': (p) => e.view.readLines(str(p, 'path'), Number(p.startLine), Number(p.endLine)),
      'view.exists': (p) => e.view.exists(str(p, 'path')),
      'view.listFiles': (p) => e.view.listFiles({ dir: p.dir, maxEntries: p.maxEntries }),
      'view.search': (p) => e.view.search(str(p, 'query'), { regex: p.regex, caseSensitive: p.caseSensitive, maxResults: p.maxResults, globs: p.globs, dir: p.dir }),
      'view.overlayState': () => e.view.overlayState(),
      'patch.proposeFile': (p) => e.proposeFile({ path: str(p, 'path'), newContent: str(p, 'newContent'), turnId: p.turnId, description: p.description }),
      'patch.proposeEdits': (p) => e.proposeEdits({ path: str(p, 'path'), edits: p.edits, turnId: p.turnId, description: p.description }),
      'patch.proposeDelete': (p) => e.proposeDelete({ path: str(p, 'path'), turnId: p.turnId, description: p.description }),
      'changeSet.get': () => e.getChangeSet(),
      'snapshot.fingerprint': () => ({ fingerprint: e.getStagedFingerprint(), hasStagedChanges: e.hasStagedChanges() }),

      'hunk.setDecision': (p) => e.setHunkDecision(str(p, 'hunkId'), p.decision),
      'file.setDecision': (p) => e.setFileDecision(str(p, 'path'), p.decision),
      'all.setDecision': (p) => e.setAllDecisions(p.decision),
      'changeSet.diff': (p) => e.toUnifiedDiff({ acceptedOnly: p.acceptedOnly }),
      'conflicts.check': () => e.checkConflicts(),
      apply: (p) => e.apply({ ignorePending: p.ignorePending === true }),
      undo: (p) => e.undo({ undoId: p.undoId, force: p.force === true }),
      'undo.list': () => e.listUndo(),
      'turn.cancel': (p) => e.cancelTurn(str(p, 'turnId')),
      discard: () => e.discard(),
      'snapshot.materialize': (p) => e.materializeSnapshot({ dest: p.dest, copyWorkspace: p.copyWorkspace, exclude: p.exclude }),
      'snapshot.dispose': async (p) => {
        await e.disposeSnapshot(str(p, 'dir'));
        return true;
      },
      recover: () => e.recover()
    };
  }

  async start(): Promise<ServerInfo> {
    const info: ServerInfo = {
      socketPath: this.opts.socketPath ?? defaultSocketPath(),
      agentToken: this.opts.agentToken ?? randomBytes(32).toString('hex'),
      userToken: this.opts.userToken ?? randomBytes(32).toString('hex')
    };
    if (tokenEquals(info.agentToken, info.userToken)) throw new Error('agentToken and userToken must differ');
    this.info = info;
    if (process.platform !== 'win32') await fsp.rm(info.socketPath, { force: true });

    this.server = net.createServer((s) => this.onConnection(s));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(info.socketPath, () => resolve());
    });
    if (process.platform !== 'win32') await fsp.chmod(info.socketPath, 0o600);

    for (const name of ENGINE_EVENTS) {
      const fn = (data: unknown) => this.broadcast(name, data);
      this.engine.on(name, fn);
      this.listeners.push([name, fn]);
    }
    return info;
  }

  async stop(): Promise<void> {
    for (const [name, fn] of this.listeners) this.engine.off(name, fn);
    this.listeners.length = 0;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const srv = this.server;
    this.server = null;
    if (srv) await new Promise<void>((r) => srv.close(() => r()));
    if (this.info && process.platform !== 'win32') await fsp.rm(this.info.socketPath, { force: true });
  }

  private roles = new WeakMap<net.Socket, Role>();

  private broadcast(event: string, data: unknown) {
    const line = JSON.stringify({ event, data }) + '\n';
    for (const s of this.sockets) if (this.roles.has(s) && !s.destroyed) s.write(line);
  }

  private onConnection(socket: net.Socket) {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES) return void socket.destroy();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) void this.onLine(socket, line);
      }
    });
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
  }

  private reply(socket: net.Socket, msg: RpcResponse) {
    if (!socket.destroyed) socket.write(JSON.stringify(msg) + '\n');
  }

  private async onLine(socket: net.Socket, line: string) {
    let req: RpcRequest;
    try {
      req = JSON.parse(line);
      if (typeof req.id !== 'number' || typeof req.method !== 'string') throw new Error('bad request');
    } catch {
      return void socket.destroy();
    }
    const fail = (code: string, message: string) => this.reply(socket, { id: req.id, ok: false, error: { code, message } });
    const params: Params = req.params && typeof req.params === 'object' ? req.params : {};

    if (req.method === 'hello') {
      const t = typeof params.token === 'string' ? params.token : '';
      const info = this.info!;
      const role: Role | null = tokenEquals(t, info.userToken) ? 'user' : tokenEquals(t, info.agentToken) ? 'agent' : null;
      if (!role) {
        fail('UNAUTHENTICATED', 'Invalid token');
        return void setTimeout(() => socket.destroy(), 20);
      }
      this.roles.set(socket, role);
      return this.reply(socket, { id: req.id, ok: true, result: { role } });
    }

    const role = this.roles.get(socket);
    if (!role) return fail('UNAUTHENTICATED', 'Send hello with a token first');
    if (!ROLE_METHODS[role].has(req.method)) return fail('FORBIDDEN', `Role '${role}' may not call ${req.method}`);

    try {
      if (role === 'agent' && typeof params.path === 'string') {
        // Keep secrets out of model context even if the agent asks for them by name.
        const rel = normalizeRel(this.engine.root, params.path);
        if (req.method.startsWith('view.') && isSecretPath(rel)) throw new EngineError('PATH_SECRET', `${rel} looks like a secrets file and is not readable by the agent`);
      }
      const result = await this.handlers[req.method](params);
      this.reply(socket, { id: req.id, ok: true, result: result === undefined ? null : result });
    } catch (e) {
      if (e instanceof EngineError) fail(e.code, e.message);
      else fail('INTERNAL', 'Internal error');
    }
  }
}
