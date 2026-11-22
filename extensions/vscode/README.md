# ProofPatch for VS Code

The integrated setup and verification steps are in the repository README. The normal Connect TrueForge command starts the embedded MCP endpoint and uses the shared patch engine. Set proofpatch.validation.python to enable staged pytest checks.

## Live patch/validation integration

See `docs/INTEGRATION.md`. The extension exports:

```ts
const api = await vscode.extensions
  .getExtension<ProofPatchAPI>('proofpatch-team.proofpatch-interface')!
  .activate();

context.subscriptions.push(await api.connectTrueForge({
  patches: member4PatchAdapter,
  validation: member5ValidationAdapter,
  subscribe: subscribeToPatchAndLedgerUpdates,
  cleanupRequest: cancelRequestToolsAndDiscardStaging,
}));
```

These named adapters are your teammates' implementations of `src/contracts.ts`. The built-in TrueForge adapter supplies the agent; you no longer need to implement Member 1 to use the UI. MCP tool results carry structured context/review/validation evidence using `docs/MCP_CONTRACT.md`.

## Commands

| Command | Purpose |
| --- | --- |
| ProofPatch: Start Local TrueForge | Start pinned local runtime in a visible terminal |
| ProofPatch: Open TrueForge Settings | Open local runtime UI for Google/Gemini and connectors |
| ProofPatch: Connect TrueForge | Discover models/connectors and attach the live agent to Member 3 |
| ProofPatch: Register Member 2 MCP Server | Register an existing HTTP MCP endpoint in TrueForge |
| ProofPatch: Set TrueForge Access Token | Store/remove optional runtime login token; not the Gemini key |
| ProofPatch: Open Chat | Open ProofPatch's own sidebar |
| ProofPatch: Edit Selection | Capture code, version and range; send through TrueForge |
| ProofPatch: Stop Current Request | Cancel remote turn and wait for terminal state/cleanup |
| ProofPatch: Apply Accepted Changes / Undo Last Apply | Delegate explicitly to Member 4 |
| ProofPatch: Start Demo Mode | Isolated fixtures, no real model calls or writes |

Choose a different model/connector using VS Code Settings → search `proofpatch.trueforge`, then reconnect after completing or rejecting the current review. Clear `model` to show the model picker again. Reconnecting starts a new runtime session; requests within one connection reuse their session, isolated by workspace roots. Session IDs are not persisted across reloads.

## Develop and test

```sh
npm ci
npm run check
npm test
npm run test:dom
npm run build
```

Open this directory in VS Code and press F5. In the new Extension Development Host window, connect TrueForge using the commands above. The `samples` folder is opened automatically. Use the original editor window to modify extension source.

```sh
npm run test:runtime
npm run package
```

The runtime smoke test starts a separate TrueForge server on port 18790 and checks discovery and a missing-provider error. It needs package-download access, but no model API key. It does not prove real Gemini inference or Member 2 tools. `npm run test:ui` is an additional Chromium layout/interaction test; install its browser using `npx playwright install chromium` first. `CHROMIUM_PATH` can select an existing browser executable.

## What was verified

- Strict TypeScript check, esbuild bundles, regression tests, React DOM controls and VSIX packaging.
- Real SDK request serialization, snake_case SSE decoding and approval-resume request ordering using controlled HTTP fixtures.
- Real TrueForge **0.185.1** startup, model/connector discovery and unconfigured-model error handling using SDK **0.185.0**.
- Cancellation during session startup and approval pauses; terminal-state polling; session reuse; evidence provenance; secret redaction in diagnostics.

Not verified here: a credentialed Gemini response, your actual MCP server, Member 4/5 behavior, or this updated version in a native VS Code Extension Development Host. The old Member 3 diff UI was demonstrated in your earlier screenshots; that is not evidence that the new runtime path has passed live end-to-end tests. Follow `docs/ACCEPTANCE.md` locally.

## Implementation map

| Path | Responsibility |
| --- | --- |
| `agent/proofpatch.agent.yaml` | Agent instructions, approval policy and runtime constraints |
| `src/trueforge/spec.ts` | Validate template and build the typed SDK AgentSpec |
| `src/trueforge/transport.ts` | Actual TrueForge SDK HTTP/SSE client; no provider calls |
| `src/trueforge/agent.ts` | Session/turn lifecycle, streaming, tool approval resume, cancellation |
| `src/trueforge/connect.ts` | VS Code setup commands, model selection, MCP registration, native approval prompts |
| `src/trueforge/evidence.ts` | Bounded validation of Member 2/4/5 evidence envelopes |
| `src/trueforge/errors.ts` | Actionable connection errors and diagnostic redaction |
| `src/controller.ts` | Member 3 lifecycle, state and serialized review operations |
| `src/extension.ts`, `webview/` | Native editor controls, React chat/review/evidence |

The YAML is this application's checked-in template; the extension converts it to an inline SDK AgentSpec. TrueForge need not discover a YAML file on disk or have a saved registry agent named ProofPatch. The selected model and MCP connector are inserted at connection time. The bundled definition disables sandbox, web search, memory, dynamic subagents and unsupported client-side question/generative tools.

The implementation follows the supplied ProofPatch project document and the official TrueForge SDK/package documentation. See `docs/SOURCES.md`. No keys are included. No source from the TrueForge runtime has been copied or forked; the published SDK is bundled as a dependency.
