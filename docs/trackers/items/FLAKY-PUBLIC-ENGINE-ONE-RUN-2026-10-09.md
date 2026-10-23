---
schema: bridlewise-tracker-item/v1
published: false
id: FLAKY-PUBLIC-ENGINE-ONE-RUN-2026-10-09
type: Flake
state: closed
resolution: completed
lane: flaky-burn-down
opened: 2026-10-20
closed: 2026-10-20
---

covered and retired 2026-10-20 on `agent/public-reowning` from `114ab553` as fixed in this tree, not left as a private-history claim: `114df640` fixes five of the six identities and `300a2a7a` fixes `S1-B13-HOSTILE-REAL`. The private row's "failed in ONE run only (2026-10-09 20:42:23Z, tree `eb6b8f4c87`) … Not reproduced" is superseded by the door's own attempts: `engine/traceability/flake-reproductions/attempts/e5f2e977b5b00eb82939d0b57a4bc05e88f35f79ca19ccb24c1c165b757dfbd9.json` (recorded 2026-10-10T14:03:33Z; parent `69fc8701`, fix `114df640`, five runs per side) records `S1-B02-FAILURE`, `S1-B12-FAILURE`, `resolved defaults: a default its own module resolves is never exported`, `[FC-B001] pure modular boundary and single protocol ownership` and `atomic-write-consistency: every src/workflow/*.ts writeFileSync call writes to an fd, never a path`, and their five v2 records show 5/5 parent failures and 5/5 fix passes; `63ef82b280fe71021c1eaac3f8deee12eeb4a48a0fd54a13059aea230941fbfa.json` (parent `114df640`, fix `300a2a7a`, five per side) records `S1-B13-HOSTILE-REAL` with the same 5/5 counts. The identity set is exact: those six are the six entries this row owned. Five of the fix's six test files plus `engine/src/kernel/web-performance-budgets.ts` are byte-identical at HEAD (`b02`, `b12`, `resolved-default`, `FC-B001`, `atomic-write`, `web-performance-budgets`; only `checkout-setup.ts` moved on after the fix), and `b13.test.ts` and `test/support/repository-local-temporary.ts` are byte-identical to `300a2a7a`. The lane's other two entries (`candidate-format`, `S1-B08-CONTROL`) were already retired by the two `PUBLIC-SNAPSHOT-*` rows, so the lane is fully disposed. The six public `engine.json` entries leave with this row (the ledger's shrink-only rule; the private floor remains the owner of its records). Ran: the six entry files plus `harness-commands` 91/91; the engine flaky guard 19/19; `npm run test:public` 34/34; `npm run docs:links` clean (512 files); `npm run docs:roadmap -- --check` current. This closes the public tracking row only.
