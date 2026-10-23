---
schema: bridlewise-tracker-item/v1
published: false
id: FLAKY-LIVE-MCP-ARMS-RETIRE
type: Task
title: Retire the two hermetic live MCP arms from the flaky list
state: closed
resolution: completed
lane: floor
opened: 2026-10-20
closed: 2026-10-20
---

both identities named `engine/test/mcp/real-servers.test.ts` live, opt-in arms that no longer exist there; the equivalent live arms are `engine/live/mcp-servers.test.ts:321` (context7) and `:325` (deepwiki), in the opt-in live suite. No `harness flake move` record exists because the public import has no parent tree that holds the hermetic identities; the entries were removed by the same commit that added this reasoned row, and the private lane remains the source of truth.
