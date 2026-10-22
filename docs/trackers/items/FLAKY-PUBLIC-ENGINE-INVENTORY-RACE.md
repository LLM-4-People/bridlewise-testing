---
schema: bridlewise-tracker-item/v1
id: FLAKY-PUBLIC-ENGINE-INVENTORY-RACE
type: Flake
state: closed
resolution: completed
lane: flaky-burn-down
opened: 2026-10-20
closed: 2026-10-20
---

covered and retired 2026-10-20 on `agent/public-reowning` from `114ab553` as fixed by `694cfd1b`, not left owned: the identity is `engine/test/verification/test-surface-conservation.test.ts` `conservation: the identity is asserted by the production inventory door`; the private row records it failed once (2026-10-14 13:55:03Z, validate 15) because the inventory CLI it runs refused "test inventory source tree changed during discovery" while `engine/verification/benchmarks/opencode-history/review/independent-scope-review.test.ts` made and removed sandboxes inside the live tree in the same suite, reproduced by hand six of six `test-inventory --check` refusals, and the cause is fixed at `694cfd1b` (the sandboxes are in the run's temp root). Both files the fix touched are byte-identical at HEAD to `694cfd1b`: `test-surface-conservation.test.ts` `d0ee23a9…` and `independent-scope-review.test.ts` `dabd6bc7…`. Focused runs at HEAD: `test-surface-conservation.test.ts` 11/11 and `independent-scope-review.test.ts` 8/8. There is no `engine/traceability/flake-reproductions/` record for the identity, but this is a deterministic fixture red fixed at its cause, not a flake, and the fix is in this tree. The one public `engine.json` entry leaves with this row (the ledger's shrink-only rule; the private floor remains the owner of its records). Ran: the two files 19/19; the engine flaky guard 19/19; `npm run test:public` 34/34; `npm run docs:links` clean (512 files); `npm run docs:roadmap -- --check` current. This closes the public tracking row only.
