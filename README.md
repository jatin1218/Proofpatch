# ProofPatch integrated source

This checkout connects the TrueForge agent, Member 2 workspace tools, Member 3 review panel, Member 4 patch engine and Member 5 validation runner inside the VS Code extension. The older member-specific design notes describe their standalone packages.

## Build and run on Windows

1. Extract the ZIP. Open PowerShell in the folder containing the root package.json. Install Node.js 22.14 or later, then run the commands below. The first command requires access to the npm registry.

   ```powershell
   npm install
   npm run check
   npm run build
   npm run package
   ```

2. In VS Code choose **Extensions → … → Install from VSIX** and select the generated file under `extensions/vscode`. Open one trusted local project folder.
3. Run **ProofPatch: Start Local TrueForge**. Configure a model in TrueForge Settings. If your server requires authentication, use **ProofPatch: Set TrueForge Access Token**.
4. Run **ProofPatch: Connect TrueForge**. Select your configured model. The extension starts the loopback HTTP MCP endpoint and registers a connector for this session. Keep TrueForge and the extension on the same host. Old connector entries may remain in TrueForge Settings after VS Code exits.
5. For Python validation, set **proofpatch.validation.python** to the absolute path of a Python interpreter with pytest and your project’s dependencies installed. Without an interpreter, the panel reports **NOT RUN**.
6. Ask for an edit in ProofPatch Chat. Approve the requested tool calls, inspect the diff, and accept or reject each hunk. **Validate** previews the command and asks before running pytest in a temporary copy of the accepted workspace. **Apply** asks before writing and checks for disk conflicts. **Undo** checks for newer changes before restoring files.

## Tests

`npm test` runs the member suites and the extension tests. The integrated-review test exercises partial acceptance, staged search, a real child-process validation, a disk conflict, Apply, Undo, and cancellation. The integrated-http test connects an MCP SDK client to the actual loopback endpoint and requests a proposal. Neither test requires a model key. The live TrueForge smoke test requires a configured local service.

Validation supports bounded UTF-8 text workspaces. Build caches, dependency directories and the engine’s internal directories are excluded. Unsupported files within the validation inputs cause an incomplete snapshot. The validation runner executes approved commands with the user's OS permissions.
