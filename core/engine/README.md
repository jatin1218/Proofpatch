# ProofPatch - Safe Patch Engine (Member 4)

Manages code changes: **proposal, staging, per-hunk approval, conflict detection, apply, undo.**
TypeScript, zero runtime dependencies, Node 22.14+.

> Status: implemented and tested as a standalone library (40 passing tests). It has **not** yet been
> wired into a VS Code extension, the MCP server or TrueForge; `INTEGRATION.md` shows how. Nothing here
> claims Forge-a-thon task results.

## The guarantees (each one has tests)

| Guarantee | How |
|---|---|
| **No silent writes** | Proposing, reviewing, staging, cancelling and discarding never touch disk. Only `apply()`, `undo()` and `recover()` write. Over IPC the **agent role cannot call them** (separate secret tokens). |
| **No unreviewed apply** | `apply()` refuses while any hunk is undecided (`PENDING_HUNKS`) unless `ignorePending` is passed explicitly. |
| **Per-hunk accept/reject** | Hunks are independent replacements of base-file ranges, fuzz-tested: any subset applies cleanly. |
| **One consistent view** | `engine.view` = disk + accepted hunks. Read, list, search, exists and the validation snapshot all derive from the same staged state. |
| **Conflict detection** | Each proposal records the SHA-256 of the file it was made against. Apply re-checks, and checks again immediately before each write. Any mismatch => nothing is written; a base-to-disk diff is returned. |
| **All-or-nothing apply** | A journal is written *before* the first write. A failing write rolls back every file already written, then verifies. |
| **Crash recovery** | `recover()` finds interrupted applies and restores files that hold half-applied content; files matching neither version are reported, never touched. |
| **Durable undo** | One JSON journal per apply (stored outside the workspace if you pass `undoDir`). Undo refuses if a file changed after the apply (so it can't clobber newer work) unless `force`. |
| **Cancellation** | `cancelTurn(id)` drops that turn's files and rejects late proposals carrying the same id. Disk was never touched. |
| **Validation hook** | `getStagedFingerprint()` (SHA-256 of path, kind, base hash, staged content hash) and a `staged-changed` event for Member 5's freshness ledger. `materializeSnapshot()` writes the exact staged tree for tests. |

Also: path-traversal and symlink-escape refusal, `.git`/`.proofpatch` protection, secret-file protection
(`.env`, keys...), binary/size limits, CRLF preservation, atomic writes that keep file mode.

## Lifecycle

```
proposeFile / proposeEdits / proposeDelete      (agent)       disk untouched
        -> hunks: proposed
setHunkDecision / setFileDecision / ...          (user)       disk untouched
        -> accepted hunks form the STAGED overlay  -> fingerprint changes -> 'staged-changed'
materializeSnapshot()  -> run tests on the exact staged tree      (Member 5)
apply()                                          (user)       conflict check -> journal -> write -> verify
        -> undoId
undo()                                           (user)       restores prior content (durable)
```

## Quick start

```bash
npm install
npm test        # build + 40 tests
npm run demo    # Task-A-style flow on a stand-in file (needs python3 for the check step)
```

```ts
import { PatchEngine } from '@proofpatch/safe-patch-engine';

const engine = new PatchEngine({ workspaceRoot, undoDir: '<extension global storage>/undo' });
await engine.recover();                                   // once, at startup

await engine.proposeEdits({ path: 'src/a.py', turnId: 't1',
  edits: [{ oldText: 'x = 1', newText: 'x = 2' }] });     // agent side
const cs = engine.getChangeSet();                          // hunks with line-numbered diff lines for the UI
await engine.setHunkDecision(cs!.files[0].hunks[0].id, 'accepted');   // user side
const r = await engine.apply();                            // r.ok | CONFLICT | PENDING_HUNKS | ...
await engine.undo();
```

## API summary

`PatchEngine` (extends `EventEmitter`)

- Propose: `proposeFile`, `proposeEdits` (search/replace, accumulates, reports ambiguity), `proposeDelete`
- Review: `getChangeSet`, `setHunkDecision`, `setFileDecision`, `setAllDecisions`, `toUnifiedDiff`
- Cancel: `cancelTurn(turnId)`, `discard()`
- Safety: `checkConflicts()`, `apply({ignorePending?})`, `undo({undoId?, force?})`, `listUndo()`, `recover()`
- Staged state: `view` (`readFile`, `readLines`, `exists`, `listFiles`, `search`, `overlayState`), `getStagedFingerprint`, `hasStagedChanges`, `materializeSnapshot`, `disposeSnapshot`
- Events: `proposal-updated`, `hunk-decision`, `staged-changed`, `applied`, `undone`, `conflict`, `cancelled`, `discarded`, `recovered`

IPC: `PatchEngineServer(engine).start()` -> `{socketPath, agentToken, userToken}`;
`PatchEngineClient.connect(socketPath, token)`. Method/role table in `src/protocol.ts`.

## Layout

```
src/engine.ts      lifecycle, conflicts, apply/rollback, undo, recovery, snapshot
src/diff.ts        Myers diff, hunks, unified diff, EOL handling
src/overlay.ts     WorkspaceView (consistent read/list/search)
src/undo.ts        durable undo journal
src/fs.ts          FileSystem interface, NodeFileSystem, MemoryFileSystem (tests)
src/ipc-*.ts       role-separated JSON-lines IPC (server + client), protocol.ts
test/              node:test suites (diff fuzz, engine, IPC)
adapters/vscode/   VsCodeFileSystem template (untested, see header)
examples/          Task-A-style demo
INTEGRATION.md     how Members 1, 2, 3, 5 plug in
```

## Known limitations (honest list)

- **Text files only**; UTF-8; binary and files over `maxFileBytes` (default 1 MB) are refused.
- **Single process owns the engine** (the extension host). No cross-process locking; other processes use IPC.
- **One open change set at a time.** Proposals accumulate into it; `cancelTurn` removes the files last proposed in that turn.
- **Conflict detection compares disk content.** Unsaved VS Code editor buffers are invisible to it; the extension must check `isDirty` (see adapter header).
- Delete-then-undo recreates a file with default permissions; undo of a create leaves any directories it created.
- `materializeSnapshot` copies the workspace (minus `.git`, `node_modules`, etc.) so it is O(repo size); it needs a real-disk workspace.
- `view.search` is a simple JS scan, correct but slower than ripgrep. For ripgrep use `view.overlayState()` to re-check the few staged paths.
- Very different huge files (edit distance > 4000 lines) degrade to one replace-all hunk instead of a fine-grained diff.
- Rollback is best effort if the disk itself fails during rollback; it is then reported as `ROLLBACK_FAILED` / `needs-attention` and `recover()` can retry.
- `adapters/vscode` and the IPC-over-MCP wiring are templates/specs, not integration-tested here.
