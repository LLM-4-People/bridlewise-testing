# S2 sources

The vendored S2.3 primary sources: the OpenAI and MCP specification
fragments the offline protocol contracts are built against, with their
licenses and digests. Retrieval is recorded; verification is offline.

## What each file does

- `manifest.json` — the vendored-set manifest: each source's URL, pinned
  revision, retrieval date, and SHA-256 digest.
- `research-manifest.json` — the research manifest the slice-source
  contracts bind.
- `openai-chat-stream.yaml` — the OpenAI chat-completions streaming
  fragment.
- `openai-responses-*.yaml` — the OpenAI Responses API fragments
  (function calls, in-progress, lifecycle, output items, text).
- `mcp-jsonrpc.ts` / `mcp-tools.ts` — the MCP 2025-11-25 JSON-RPC and tools
  schema fragments.
- `openai-LICENSE` / `mcp-LICENSE` — the licenses of the vendored
  specifications.

## Where it lives and what consumes it

The folder lives at `engine/traceability/sources/s2/`. The slice-source
contracts (`engine/scripts/verification/slice-source-contracts.ts`) and the
S2.3 verifiers bind these bytes by digest.
