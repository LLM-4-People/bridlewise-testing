---
schema: bridlewise-tracker-item/v1
id: FLAKY-BURN-DOWN-RECONCILE
type: Flake
title: Reconcile the flaky burn-down list with the published memory
state: closed
resolution: completed
lane: flaky-burn-down
opened: 2026-10-20
closed: 2026-10-20
---

measured 22 engine entries across 9 private lanes and 0 web entries before; re-ran all 18 distinct engine entry files and the 3 public web suspects. Re-owned the 15 engine entries that still have live tests under 7 public rows; retired 7 engine entries with evidence: 2 live MCP arms moved to `engine/live/mcp-servers.test.ts`, and 5 deterministic public-snapshot failures recorded in the `PUBLIC-SNAPSHOT-*` rows above. The 3 web suspects are owned by 2 public rows (the two doc guards were deterministic stale-doc defects fixed at `fd7e058f`, the watchdog C3 is the one transient). After: 15 engine entries / 7 owners and 3 web entries / 2 owners; the engine guard and the web guard both pass. Evidence: the focused entry-file runs, `docs/floor/evidence.md`, and the commit message's command list.
