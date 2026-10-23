---
schema: bridlewise-tracker-item/v1
published: false
id: FLAKY-HELPERS-README-HARNESS-VIEW
type: Flake
state: closed
resolution: completed
lane: flaky-burn-down
opened: 2026-10-20
closed: 2026-10-20
---

retired 2026-10-20 on `agent/flaky-harness-view` from `1a9a6e38` as a stale private-web lane: the recorded mechanism no longer exists, and the public ledger never carried its entry. The record claimed `tests/prevention/source-root-organization.test.ts` "tests/ each README names exactly the folder's real files" failed in the 2026-10-10T18:44Z full web run at `e8b25c8c` because `tests/helpers/README.md` did not name `tests/helpers/harness-view.ts`, and judged it not a flake: `9d7c7e78` folded that helper into `tests/helpers/isolated-config.ts` and deleted the file, so FLAKE-REPRO cannot explain it (the cause is absent at the fix, and a README is Markdown, never a semantic change). Observed at `1a9a6e38`: the arm is deterministic, not intermittent. At `e8b25c8c` the helper exists (blob `bb145be1`) and the README omits it; restoring exactly that file as an untracked fixture twice, the arm failed twice 1/1 (exit 1, "In the folder but not named in its README (undocumented): tests/helpers/harness-view.ts"); removing it, the arm passed twice 1/1. At HEAD the file is absent and `tests/helpers/README.md` names `isolated-config.ts`. The two named files are 44/44 (36 + 8) in ten consecutive `npx vitest run` runs (440 test results). The ledger's own rule (`engine/src/workflow/flaky-burn-down.ts`) retires an entry only with its owning row, and the removal commit names the decision (FLAKE-REPRO); there is nothing to remove here because `2545d94f` carried the private web history, `94b1a97f` emptied it, and `400a130a` re-added only the three public suspects `engine/traceability/flaky-burn-down/web.json` holds. That file's source-root entry is the `engine/test/` README arm owned by `FLAKY-PUBLIC-WEB-GUARD-REDS-ON-ROUND-TREES`, a different identity from this lane's `tests/` arm; the private floor's `web.json` remains this identity's owner and is not edited from the public floor. The web ledger guard is 8/8 and `engine/test/prevention/flaky-test-memory.test.ts` is 19/19 over the closed row. This closes the public tracking row only; the private floor remains the owner of its own record.
