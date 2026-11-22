# Members 1 + 3 + 5 composition contract

`src/validation/adapter.ts` adapts the repository's real `ValidationSession` to
`Services.validation.run(review, signal)`. The VS Code API remains version 1 with
an additive `createValidation` factory and `LiveComponents.member5` option.

## Composition example

The following belongs in Member 4's integration extension, after its own engine
has initialized. `patchEngine`, `snapshotBridge` and `fingerprintKeyProvider` are
integration objects you must implement; they are not supplied by this repository.
Import the types from this repository's `src/contracts.ts` and
`src/validation/adapter.ts` when compiling your composition extension.

```typescript
const extension = vscode.extensions.getExtension<ProofPatchAPI>(
  'proofpatch-team.proofpatch-interface'
);
if (!extension) throw new Error('Install ProofPatch first');
const api = await extension.activate();
const connection = await api.connectTrueForge({
  patches: patchEngine, // decide, apply, undo, discard
  cleanupRequest: id => patchEngine.cleanupRequest(id),
  subscribe: listener => patchEngine.subscribe(listener),
  member5: {
    // Return the CURRENT snapshot every call, not a permanently captured copy.
    getSnapshot: review => snapshotBridge.getSnapshot(review),
    checks: [{
      command: {
        kind: 'test',
        executable: 'C:\\Python311\\python.exe', // installed absolute executable
        args: ['-m', 'pytest', '-q'], timeoutMs: 60000
      }, required: true
    }],
    fingerprintKeyProvider, // stable private >=32-byte key, e.g. VS Code SecretStorage
    environmentAllowlist: [], // no ambient environment inherited
    security: { secrets: true } // optional Semgrep options supported as in Member 5
  }
});
context.subscriptions.push(connection);
```

The Python path above is an example; set your installed interpreter's path. It
must have pytest installed and the snapshot must contain the tests and required
text/config inputs. For Node checks use an installed absolute Node executable
with an argument array. Windows shell wrappers such as npm.cmd are not portable
executables for this shell-free runner. Do not pass an arbitrary shell command.
Environment values must be explicitly set in `command.env` and their names
included in `environmentAllowlist`; only names are recorded in evidence.

If `member5` is provided, it takes precedence over `validation`. If neither is
provided the live service advertises validation unavailable. `api.createValidation`
uses the same native command approval and trust check as `connectTrueForge`.

## Snapshot bridge

`getSnapshot(review)` must return:

```typescript
{
  reviewId: review.id,
  revision: review.revision,
  snapshotId: review.snapshotId,
  complete: true,
  snapshot: {
    files: [ // all inputs, base files plus ACCEPTED hunks only
      { path: 'src/example.py', content: '...exact staged text...' },
      { path: 'tests/test_example.py', content: '...exact staged text...' }
    ]
  },
  conflictingPaths: []
}
```

Do not simply copy the requested IDs onto a newer snapshot. IDs must identify
the engine's actual current state. A mismatch returns STALE. Paths follow the
core's canonical repo-relative POSIX rules. Set `complete:false` with `limitations`
when binaries, modes, symlinks, renames/deletions or missing inputs cannot be
faithfully represented by Member 5's provisional text-only snapshot model.
Incomplete snapshots never execute checks or report FRESH.

The adapter reads around execution and after security checks, compares content
fingerprints, and preserves opaque Member 4 identity separately from Member 5's
hash. The patch engine must publish review updates or STALE/CONFLICT validation
events via `subscribe` when disk/staging changes after a run. No filesystem
watcher is guessed by this adapter. Apply safety remains Member 4's responsibility.

## Agent and UI flow

Member 1 continues consuming Member 2's `proofpatch` MCP evidence envelope.
A trusted review event opens Member 3's review. User decisions go to Member 4.
The Evidence tab's **Run validation** invokes Member 5 against Member 4's snapshot.
The native host asks permission to execute the configured checks. Results return
to the Evidence tab with per-check status, output, timing, skipped checks and
security status. The model never decides whether a snapshot is FRESH.

Stop aborts validation, waits for child cleanup, then discards staging. A cleanup
failure remains a visible error and blocks further operations. The native approval
picker also closes on cancellation. Agent requests still go only through TrueForge.

## Tests

- Original core: 320 tests cover snapshots, runner, ledger, security and orchestration.
- Extension: 39 tests include TrueForge SDK serialization/streaming, review logic,
  real Member 5 child execution, failure, identity mismatch, incomplete snapshots,
  content changes, cancellation and cleanup ordering.
- React DOM test covers chat/review/evidence controls and escaped output.

No live Gemini key or Member 2/4 implementation is included. A real end-to-end
agent → MCP → patch snapshot → validation run must be verified with those services.
