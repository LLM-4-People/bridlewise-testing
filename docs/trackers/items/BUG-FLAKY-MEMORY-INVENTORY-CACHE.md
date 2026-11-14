---
schema: bridlewise-tracker-item/v1
published: false
id: BUG-FLAKY-MEMORY-INVENTORY-CACHE
title: Derive flaky-memory suites without an inventory cache
type: Bug
state: open
lane: floor
horizon: now
tests: [engine/test/prevention/flaky-test-memory.test.ts]
evidence: repo:pull/817
opened: 2026-11-14
---

Remove the derived inventory-cache prerequisite from `engine/test/prevention/flaky-test-memory.test.ts` while preserving its complete flaky-memory judgment. Normal validation observed 777 guards, 776 passed and one failed: the LIVE guard called `loadTestInventory` and refused with `safe_path_missing` for the ignored `engine/traceability/s1-test-inventory.json` cache. The inventory check validates the source projection without writing that cache, and the guard runner does not run the full runner's auto-heal preparation. The origin of the cache's deletion is unknown.

Derive the current inventory through the existing `buildTestInventory` producer for this consumer. Preserve every hermetic and qualified external suite member, suspect, ownership decision and failure. A missing cache must not become an empty inventory, skipped judgment or undeclared fallback.

Qualification must compare the current source projection with a valid present cache, then remove only a disposable fixture's cache and prove that the same consumer still supplies real nonempty suite coverage. Run the whole affected guard owner and changed-head normal validation, retaining the original failed qualification separately.

This item remains open until the consumer fix and regression are independently qualified. It makes no claim about who removed the original cache, historical failure equivalence, a flaky-cause explanation, or the separate hosted Guardian TMPDIR refusal.
