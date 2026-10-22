---
schema: bridlewise-tracker-item/v1
id: FLAKY-PUBLIC-ENGINE-GUARD-REDS-ON-ROUND-TREES
type: Flake
state: open
lane: flaky-burn-down
opened: 2026-10-20
---

public re-owning of `FLAKY-ENGINE-GUARD-REDS-ON-ROUND-TREES`; **needs private history, still owned**. Keeps the three entries whose tests are green at HEAD: `engine/test/verification/test-surface-conservation.test.ts` (two arms, 11/11) and `engine/test/workflow/harness-commands.test.ts`. The private row says these guards were red on the committed round tree of 2026-10-07 23:59Z and fixed by a later commit of the same round — "not flakes … the coordinator decides". Their schema-v2 records (`b1cf5ba8…`, `0cc4dff2…`, `50c8c4ef…`) name parent `7f319afc` → fix `a12dccb8` at one run per side, but they are ignored by the current door and have no `attempts/` files here; the fix's exact bytes are not at HEAD either (`a12dccb8`'s conservation blob `3e8a0765…` and harness blob `9ec78f88…` differ from HEAD, because later work moved both files). The already-Done `FLAKY-WEB-GUARD-REDS-ON-ROUND-TREES` row covers 18 `tests/prevention/*` identities — the same "round-tree guard red, fixed by the next commit" mechanism but a disjoint identity set (none of the three engine files appears there), so it does not cover this lane. Missing artifact: the private coordinator's decision (E-01/GC-0) on the three entries, or current-door records/attempts that explain them. Guarded by `engine/test/prevention/flaky-test-memory.test.ts`.
