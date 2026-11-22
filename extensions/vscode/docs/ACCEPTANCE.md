# Acceptance checklist — version 0.2.0

## Automated checks

Run `npm run check`, `npm test`, `npm run test:dom`, `npm run test:runtime` and `npm run package`.

The regression suite covers the Member 3 controller and the Member 1 adapter: hunk decisions, stale evidence, validation cancellation, session reuse, request scoping, streamed deltas, approval denial/resume, evidence provenance and schema, startup/approval cancellation races, cancellation acknowledgment versus termination, redaction, failure handling, and real SDK HTTP serialization/SSE decoding. The runtime smoke test starts TrueForge 0.185.1 and checks discovery plus a missing-provider failure without a key. These tests do not substitute for the live checks below.

## Native VS Code and Gemini

1. Install `proofpatch-interface-0.2.0.vsix` or build and press F5. Confirm old demo/development windows are closed.
2. Start local TrueForge. In its UI configure Google with a valid Gemini API key and select an available model. Connect from ProofPatch.
3. Send a short chat. Confirm streaming text and a TrueForge session ID appear, and the label names the selected model.
4. Ask a follow-up. Verify it uses the same session. Reconnect to start a new session.
5. Select code and invoke Edit Selection. Verify the request includes exactly the captured URI/range/version/text, and no automatic repository dump.
6. Stop mid-response. Confirm cancellation status resolves, no late UI text appears, and no workspace file changed.
7. Stop during session creation and during a tool-approval prompt. Confirm no approval is accidentally sent after Stop.
8. Stop the runtime or use an invalid provider key. Check a clear error and responsive UI. A failed request must not be automatically replayed.
9. Check a different Gemini model through settings and reconnect. No API key should appear in source, settings, chat or diagnostics.

## MCP and remaining members

1. Start Member 2's actual MCP endpoint and register/select it. Confirm `mcp.initialize` and tool activity in the UI. Registration alone does not prove connectivity.
2. Without Member 4, confirm only annotated read-only tools are available. Inspect the tool arguments, deny a call, and confirm it is not executed.
3. Register Member 4/5 through `connectTrueForge(components)`. Ensure cleanupRequest stops owned processes and discards request staging.
4. Request a real inline edit. Confirm an engine-owned Review arrives via a trusted MCP result, the native diff opens, and each hunk can be accepted/rejected.
5. Accept stages only. Explicit Apply writes only accepted changes after revision/conflict checks. Undo must protect later unrelated edits.
6. Validate the accepted snapshot: command/exit/fingerprint displayed. Change a hunk → STALE. Failed checks never show FRESH. External file edits produce CONFLICT and block Apply.
7. Stop during a tool and validation; inspect process cleanup and `git status`. No partial edits or leaked staging.
8. Rehearse project Tasks A/B/C on the required Flask revision. Do not claim them passed from the demo or mocked tests.

## UI checks

Native sidebar loading/CSP, light/dark/high-contrast themes, 280/380/900px widths, keyboard-only navigation, hidden/reopened webview, multiple workspace roots, unsaved buffers and full-argument approval inspection all need local VS Code checks. `npm run test:ui` provides browser checks once Chromium can launch.

## Known boundaries

No provider key or actual Member 2/4/5 implementation was supplied for this build. Successful credentialed Gemini inference and full workspace edits are therefore not verified here. No automatic model fallback, persistent UI session restoration, arbitrary client-side tool execution, or hosted backend is implemented. TrueForge owns runtime state; the other members own repository operations and their cleanup.
