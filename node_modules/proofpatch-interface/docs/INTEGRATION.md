# Member 1 connected to Member 3

`ProofPatchAPI` keeps `version: 1` and the existing `connect(services)` method, and adds `connectTrueForge(components?)`. Existing full-service integrations still work. The additional method constructs Member 1 internally and reuses the same Member 3 controller/view.

## Composition extension

A teammate's extension can add `"extensionDependencies": ["proofpatch-team.proofpatch-interface"]` to its manifest and import the shared types from `src/contracts.ts` (or your team's shared package):

```ts
import * as vscode from 'vscode';
import type {ProofPatchAPI, LiveComponents} from './shared/contracts';

export async function activate(context: vscode.ExtensionContext) {
  const ext = vscode.extensions.getExtension<ProofPatchAPI>(
    'proofpatch-team.proofpatch-interface'
  );
  if (!ext) throw new Error('Install ProofPatch first');
  const api = await ext.activate();
  const components: LiveComponents = {
    patches: patchEngineAdapter,
    validation: validationRunnerAdapter,
    subscribe: subscribeToEngineAndLedger,
    cleanupRequest: async requestId => {
      await stopOwnedMcpProcesses(requestId);
      await discardRequestOverlay(requestId);
    },
  };
  context.subscriptions.push(await api.connectTrueForge(components));
}
```

The adapter symbols above are integration points, not exports of this project. `cleanupRequest` is mandatory when enabling the patch engine. It must clean staging even for proposals not yet delivered to the UI. It must not revert already-applied user changes. Reconnect only while idle and with no unresolved review; dispose the returned binding when your composition extension is deactivated.

Without components, the standard Connect command enables chat/selected code and only tools marked read-only by the chosen MCP connector. Accept/Apply/Undo controls stay disabled. Member 5's absent runner reports NOT RUN; it never fabricates a passing result. When components are registered, all tools on the selected connector become eligible but every call is gated by the YAML's `@all` approval policy. Member 2 must expose only tools appropriate to this project and honor Member 4's no-silent-writes boundary.

## Requests and session lifecycle

Each input becomes a TrueForge `user.message` containing JSON with `requestId`, `instruction`, `mode`, `workspaceUris` and optional `selection`. Ranges are zero-based. The selection includes document version, language and captured text. No full repository is gathered by the extension.

TrueForge sessions are created lazily using an inline AgentSpec. The adapter reuses a session for the same workspace roots; a different workspace creates a fresh session. Reconnecting or reloading clears the local session reference. TrueForge retains its own server-side history. The UI retains only session-memory chat, plus the unsent draft in webview state.

Member 1 maps `model.message.delta` into chat text, `model.message` tool calls into activity, `tool.response` into completed/error activity, and `mcp.initialize` into visible connector status. Only root-thread assistant text is displayed as the main reply. Source events are indexed and deltas merged using the SDK helpers for accurate tool approval arguments.

At `turn.update` paused, the adapter displays native Allow/Deny prompts for every pending tool call. Full redacted arguments are inspectable in an editor document. The continuation subscription opens before approval events are submitted on the same turn. Approval is per-call, never a blanket session policy. Dismissal denies. Stop dismisses the prompt. Unsupported client-side tools or MCP OAuth requests stop with guidance to configure/authenticate in TrueForge first.

Automatic retries of session/turn creation are disabled: an ambiguous network failure must not replay an editing task. A stream that closes without `turn.done` triggers cancellation and an error. Reconnect/retry is explicit. There is no automatic fallback to another model in this version.

## Cancellation contract

AbortSignal marks the request cancelled and suppresses new UI events. The adapter handles the race where cancellation arrives while session/turn creation is pending: it first learns the session, does not launch a turn if cancellation preceded submission, and otherwise invokes `sessions.cancel`.

An HTTP success from cancel is only acknowledgment. The adapter polls the session's latest-turn status until done/cancelled/error (or no turn exists), then invokes `cleanupRequest`. Timeout/network/cleanup failures are errors, not successful cancellation. The controller now waits for agent cancellation before discarding its displayed review, preventing late tools from recreating a cleared overlay.

TrueForge's documented cancellation waits for MCP calls; it does not guarantee that Member 2's own child process tree is terminated. Member 2/5 and the cleanup hook must implement that responsibility. Long-running tool cleanup can therefore keep the UI in cancelling or cause a visible timeout. On an uncertain cleanup error, inspect the runtime/tool processes before reconnecting or reloading. Do not report a clean workspace without checking it.

## Member 4

The existing `Services.patches` interface remains unchanged. `decide` stages accepted/rejected hunks and returns a full authoritative Review with a new revision and current snapshotId. It does not write disk. Apply/Undo validate the expected revision and disk/editor baselines, perform controlled writes, and return actual state. The UI waits for acknowledgments. `discard` is idempotent and only clears temporary staging.

Hunk IDs/file IDs must be stable within a review. Hunk starts are one-based. Native diffs use the complete `original` and `proposed` strings supplied by the engine. Hunk decisions and snapshot IDs represent the accepted subset. Only the actual engine can compute baselines, hashes and workspace conflicts.

## Member 5

`validation.run(review, signal)` checks the accepted staged snapshot and returns state, exact command, exit code, duration, timestamp, snapshotId and fingerprint. FRESH requires a matching snapshot, exit code zero, a command and fingerprint at the display boundary; this does not replace the real SHA-256 ledger.

Use `subscribe` for post-turn review/ledger changes, including external file edits and dependency/config changes. Reviews must have the same ID and higher revision. Validation must match the current snapshot. Emit STALE/CONFLICT as appropriate. Validation process cancellation must honor AbortSignal.

## Integration limits

The extension never invokes filesystem patch writes, a provider SDK, its own agent loop, or a shell tool to apply a model-generated change. Starting TrueForge is an explicit user command in a visible terminal. API errors and approval arguments receive redaction; arbitrary assistant text/source code is not guaranteed secret-free, so context tools must exclude secrets before transmission.

The runtime path is local HTTP only. Optional runtime login tokens live in SecretStorage. Gemini keys are configured through TrueForge, not copied into the extension. Model/connector selections are machine-scoped settings.
