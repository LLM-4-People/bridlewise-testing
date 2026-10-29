---
schema: bridlewise-tracker-item/v1
published: false
id: FLAKY-CONFIG-PARENT-CHURN
type: Flake
state: open
lane: flaky-burn-down
opened: 2026-10-29
---

**Suspect with a named cause, not yet fixed.** Covers `tests/prevention/roadmap-status-owner.test.ts` › "a close is a claim until linked evidence proves it…", red in Shard 5 of #711's run 40818517399 with `SecurityError: Configuration parent identity changed` (`config_parent_changed`) from `configuredRepositoryIdentity()` → `loadPinnedConfigSnapshot()`. Cause: `engine/src/kernel/config.ts` pins the engine folder's whole stat (`sameIdentity`, engine/src/shared/identity.ts: mtime, ctime, nlink and size with dev and ino) at the start of a read and compares it at each step, so any concurrent creation or removal of an entry directly in `engine/` by another test of the shard (a first `engine/dist` or `engine/.bridlewise`, a lock file) refuses the read. Reproduced on demand with the same code as the parent (config.ts, identity.ts, repository-identity.ts and configured-forge.ts are unchanged from #711's base 6ac6d541): `mkdir`/`rmdir` of `engine/.churn-probe` in a loop beside `npx vitest run tests/prevention/roadmap-status-owner.test.ts` refuses with the same error. Owned by the flaky guard `tests/prevention/flaky-test-memory.test.ts` through `engine/traceability/flaky-burn-down/web.json`; the fix (judging the parent by what can swap it, or each test file not re-reading the pinned configuration under a churning shard) is the configuration owner's, recorded through `harness flake reproduce --statistical --during` when it lands.
