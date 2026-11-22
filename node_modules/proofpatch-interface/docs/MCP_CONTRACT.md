# MCP evidence contract for Members 2, 4 and 5

Member 1 connects TrueForge to a registered connector; it does not implement MCP tools. Agree on actual tool names with Member 2. The agent sends the request ID and workspace roots in its user request; tools that create request-owned context/staging should accept and return that request ID.

A tool result may return a JSON string with this shape, an MCP `structuredContent` containing it, or an MCP `content` text item containing that JSON:

```json
{
  "proofpatch": {
    "version": 1,
    "requestId": "the-current-request-id",
    "events": [
      {
        "type": "context",
        "items": [{
          "id": "ctx-1",
          "uri": "file:///project/src/example.py",
          "path": "src/example.py",
          "symbol": "greet",
          "startLine": 1,
          "endLine": 2,
          "reason": "The selected function implements this behavior",
          "characters": 43
        }],
        "used": 43,
        "budget": 8000
      }
    ]
  }
}
```

`events` supports the `context`, `review` and `validation` variants in `src/contracts.ts`. Exact runtime validation is in `src/trueforge/evidence.ts`. Evidence is accepted only from a TrueForge `tool.response` whose originating MCP tool belongs to the connector selected in settings. Model text never creates review/validation evidence. An envelope for another request is ignored. Limits: 2 MB serialized tool output, 100 events, 100 files/review, 200 hunks/file, 200 context entries, 200,000 characters per file/excerpt. Larger proposals must be split into requests.

For `review`, the engine must already own/stage the proposal identified by `review.id`; the UI does not import arbitrary JSON as a patch. For `validation`, Member 5 supplies actual results and an exact snapshot identity. Tool `isError: true` is displayed as failed activity and cannot create evidence.

Examples of suitable MCP capabilities are workspace listing/reading/search, symbol lookup, bounded context retrieval, safe patch proposal and approved validation. Actual names are chosen by Member 2; none are fabricated as implemented tools here. Without Member 4, only tools annotated read-only are enabled. All eligible calls require explicit approval by default.

Use one shared WorkspaceView for search, patch proposals and validation. Exclude secrets and redact logs before returning them. The request cleanup hook must stop owned child processes and discard all temporary request staging, including proposals whose UI event was never delivered. Do not expose a real workspace-write tool that bypasses explicit Apply.
