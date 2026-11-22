# Integration guide

The engine lives **in the VS Code extension host** (one process, one owner). Everything else talks to it.

```
 TrueForge agent ──MCP──> MCP server (Member 2) ──IPC, agent token──┐
                                                                     ▼
 React webview ◄──► extension (Member 3) ── in-process / IPC, user token ──> PatchEngine (Member 4)
                                                                     ▲
 Validation (Member 5) ── materializeSnapshot + 'staged-changed' ────┘
```

## Startup (extension, Member 3 / Member 1)

```ts
const engine = new PatchEngine({ workspaceRoot, undoDir: join(context.globalStorageUri.fsPath, 'undo', hash(workspaceRoot)) });
await engine.recover();                       // roll back an interrupted apply from a previous session
const server = new PatchEngineServer(engine);
const { socketPath, agentToken } = await server.start();
// Give socketPath + agentToken (ONLY the agent token) to the MCP server, e.g. via env vars in the
// MCP server definition that proofpatch.agent.yaml points TrueForge at.
```

The extension itself calls `engine.*` directly (it owns the engine) or connects as `user` role.

## Member 2 - MCP server tools

Connect once with the **agent** token and map tools 1:1:

| MCP tool | Client call |
|---|---|
| `read_file` (bounded) | `client.readLines(path, start, end)` / `client.readFile(path)` |
| `list_files` | `client.listFiles({dir})` |
| `search_text` | `client.search(query, {regex, globs, maxResults})` |
| `propose_edits` | `client.proposeEdits({path, edits, turnId})` |
| `propose_file` | `client.proposeFile({path, newContent, turnId})` |
| `propose_delete` | `client.proposeDelete({path, turnId})` |
| `workspace_status` | `client.getChangeSet()` + `client.overlayState()` |

Rules that keep the "one consistent view" promise:

- Read through `client.readFile/readLines/search`, **not** straight from disk, so the agent sees accepted staged hunks.
- If you use ripgrep on disk for speed, call `client.overlayState()` and re-check `modified/created/deleted`
  paths through `client.readFile`.
- Pass the TrueForge turn/session id as `turnId` on every proposal. This makes cancellation exact.
- Tool errors come back as `{ok:false, code, message}` (propose) or `RpcError` (`PATH_SECRET`,
  `PATH_OUTSIDE_WORKSPACE`, `NOT_FOUND`, ...). Relay `message` to the model; `EDIT_AMBIGUOUS` /
  `EDIT_NOT_FOUND` messages tell it how to fix the edit.
- The agent token cannot apply/undo/cancel; do not expose such tools to the agent.

## Member 3 - UI

- Render `engine.getChangeSet()`: each `FileSummary.hunks[]` has `header`, `state` and `lines`
  (`context|add|remove`, text, old/new line numbers) ready for a diff view.
- Accept/Reject buttons -> `setHunkDecision(hunkId, 'accepted'|'rejected')`; file/all variants exist.
- Subscribe: `engine.on('proposal-updated' | 'hunk-decision' | 'staged-changed' | 'applied' | 'conflict' ...)`
  and re-render from `getChangeSet()`.
- Apply button -> `const r = await engine.apply()`:
  - `PENDING_HUNKS` -> highlight undecided hunks.
  - `CONFLICT` -> show `r.conflicts[i].diskDiff` (what changed on disk since the proposal).
  - `WRITE_FAILED` / `ROLLBACK_FAILED` -> show `message`; workspace is restored (or flagged).
- Before `apply()`, make sure affected files have no unsaved editor changes (`TextDocument.isDirty`).
- Stop button -> `engine.cancelTurn(turnId)` **and** cancel the TrueForge turn. Late tool calls are ignored.
- Undo button -> `engine.undo()`; on `UNDO_CONFLICT` ask before `force`.
- Optional: `adapters/vscode/VsCodeFileSystem.ts.example` for writes through `vscode.workspace.fs`.

## Member 5 - validation & freshness ledger

```ts
engine.on('staged-changed', ({ fingerprint }) => ledger.markStaleIfDifferent(fingerprint));

const snap = await engine.materializeSnapshot();           // exact accepted hunks, in a temp dir
try {
  run('pytest tests/test_cli.py -q', { cwd: snap.dir, env: { PYTHONPATH: join(snap.dir, 'src') } });
  // assert the imported module path is inside snap.dir (editable installs can shadow it)
  ledger.record({ fingerprint: snap.fingerprint, command, exitCode, ... });  // FRESH only if exit 0
} finally { await engine.disposeSnapshot(snap.dir); }
```

- `snap.fingerprint === engine.getStagedFingerprint()` at snapshot time (the call holds the engine lock, so
  staging cannot change mid-copy). If they differ later, the result is **STALE**.
- `apply()` raising `CONFLICT` maps to the ledger's **CONFLICT** state. `NOT RUN` = no ledger entry for the
  current fingerprint.
- The fingerprint covers path, kind, base-file hash and staged content hash. It does **not** cover
  dependencies, env vars or test config; record those in the ledger yourself.

## Member 1 - agent

- No code needed here beyond the MCP server registration; the agent only ever *proposes*.
- Suggested agent instruction: "Edit only through the propose_* tools. After proposing, tell the user
  to review the diff. Never claim a change is applied; only the user applies."
