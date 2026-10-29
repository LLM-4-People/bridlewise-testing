---
schema: bridlewise-tracker-item/v1
published: false
id: FLAKY-CONFIG-PARENT-CHURN
type: Flake
state: closed
resolution: completed
lane: flaky-burn-down
opened: 2026-10-29
closed: 2026-10-29
---

**Fixed at its root and reproduced through the door.** Covered `tests/prevention/roadmap-status-owner.test.ts` › "a close is a claim until linked evidence proves it…", red in Shard 5 of #711's run 40818517399 and again in merge-group run 40833604047 (#737), with `SecurityError: Configuration parent identity changed` (`config_parent_changed`). Cause: `engine/src/kernel/config.ts` held the engine folder by its whole stat (mtime, ctime, link count, size) and by the presence of every entry across a pinned read, so any entry a concurrent test made in `engine/` refused it; measured, the writer was `tests/prevention/customization-write-path-owner.test.ts`, whose test store named the real config, so its write lock made `engine/.bridlewise` mid-shard on a fresh checkout (a watch on `engine/` saw exactly that `rename .bridlewise`, 72 ms into that file). Fixed at the root by `4c57c7e8` (`Flake-cause:` trailer): the read holds the folder by its identity (device, inode, type, owner) and lets an entry the configuration surface excludes be made or removed; a swapped folder is still refused. Beside it, `e2d81b83`: a test store whose config lies in the checkout under test is refused at its write, and every test store names its own fixture. Reproduced deterministically through `harness flake reproduce --suite web --fix 4c57c7e8` with the shim `tests/helpers/flake-shim-config-parent-churn.ts` and the writer test run alongside (`--during`, releasing the reader only when it passed): the parent failed with the recorded digest, the fix passed (`engine/traceability/flake-reproductions/f9f7eca4614374c399a4e0da.json`). The web burn-down entry leaves with this row, owned by the flaky guard `tests/prevention/flaky-test-memory.test.ts`.
