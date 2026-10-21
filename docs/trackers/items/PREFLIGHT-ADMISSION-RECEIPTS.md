---
schema: bridlewise-tracker-item/v1
id: PREFLIGHT-ADMISSION-RECEIPTS
type: Task
title: Add per-capability admission receipts
state: closed
resolution: completed
lane: floor
parent: M2-RECEIPTS
opened: 2026-10-20
closed: 2026-10-20
---

every `preflight` capability entry now names the fact that decided it and what would change a denial: `evidence.path` is `engine/src/kernel/root-policy.ts`, `evidence.field` is `capabilities.<name>` (covered by the receipt's `rootPolicyHash`), and `remedy` is `null` only for the admitted `preflight` capability while each denied capability names its governance gate as the remedy. The regression test (`engine/test/preflight.test.ts`, "each capability receipt names its covering policy fact and a remedy when denied") failed before the fix with `TypeError: Cannot read properties of undefined (reading 'path')` and passes 29/29 after; the focused preflight/S1/S2.4 consumer set is 57/57, `tests/prevention/exposure-reachable.test.ts` is 14/14, `npm --prefix engine run typecheck` is clean, `npm run test:public` is 29/29, and `node --experimental-strip-types src/cli.ts harness check --skip-typecheck` passed with the architecture manifest in sync (869 modules, no registry change). This closes the receipt shape only: the M2 admission gates for model invocation, repository mutation, process execution, and network egress remain open, and no capability beyond `preflight` is admitted.
