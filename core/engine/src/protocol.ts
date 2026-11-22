/**
 * Wire protocol between the extension host (which owns the PatchEngine) and other processes such as the
 * MCP server that TrueForge spawns. Newline-delimited JSON over a local socket / named pipe.
 *
 * Two roles, two secret tokens:
 *   agent - read the staged view and PROPOSE changes. Cannot review, apply, undo or cancel.
 *   user  - everything. Held only by the VS Code extension.
 * This is how "no silent writes" is enforced at the protocol level, not just by convention.
 */
export type Role = 'agent' | 'user';

export interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}
export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } };
export interface RpcEvent {
  event: string;
  data: unknown;
}

export const AGENT_METHODS = [
  'view.readFile',
  'view.readLines',
  'view.exists',
  'view.listFiles',
  'view.search',
  'view.overlayState',
  'patch.proposeFile',
  'patch.proposeEdits',
  'patch.proposeDelete',
  'changeSet.get',
  'snapshot.fingerprint'
] as const;

export const USER_ONLY_METHODS = [
  'hunk.setDecision',
  'file.setDecision',
  'all.setDecision',
  'changeSet.diff',
  'conflicts.check',
  'apply',
  'undo',
  'undo.list',
  'turn.cancel',
  'discard',
  'snapshot.materialize',
  'snapshot.dispose',
  'recover'
] as const;

export const ROLE_METHODS: Record<Role, ReadonlySet<string>> = {
  agent: new Set<string>(AGENT_METHODS),
  user: new Set<string>([...AGENT_METHODS, ...USER_ONLY_METHODS])
};

export const MAX_LINE_BYTES = 32 * 1024 * 1024;
