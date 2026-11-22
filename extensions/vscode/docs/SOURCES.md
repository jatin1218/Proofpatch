# Source and version notes

Checked on 14 November 2026 against the published package typings and the official repository documentation:

- Runtime pinned to `@truefoundry/trueforge@0.185.1`.
- SDK pinned to `@truefoundry/trueforge-sdk@0.185.0`.
- The SDK's session/stream/approval contracts are compiled against its shipped TypeScript declarations and covered by serialization tests.
- Current turn lifecycle uses `turn.update` paused, subscription before approval submission, and `turn.done` terminal. Earlier pre-0.185 recipes are not used.

Official references:

- https://github.com/truefoundry/trueforge/blob/main/docs/api/quickstart.mdx
- https://github.com/truefoundry/trueforge/blob/main/docs/api/use-agent.mdx
- https://github.com/truefoundry/trueforge/blob/main/docs/create-agent/overview.mdx
- https://github.com/truefoundry/trueforge/blob/main/docs/quickstart.mdx
- https://github.com/truefoundry/trueforge/blob/main/docs/mcp-servers.mdx
- https://code.visualstudio.com/api/extension-guides/webview

The selected Gemini model is discovered from the user's configured TrueForge catalog, avoiding a hard-coded unverified model ID. The checked-in YAML is an application template converted to an inline SDK AgentSpec, not a claim that TrueForge automatically loads `.agent.yaml` files.
